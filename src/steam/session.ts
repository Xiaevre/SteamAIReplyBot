import { SteamBrowserManager } from './browser';
import { Logger } from '../utils/logger';

export type SessionHealthStatus = 'SESSION_VALID' | 'SESSION_INVALID' | 'HEALTH_CHECK_UNAVAILABLE';

export interface SessionHealthResult {
  valid: boolean;
  status: SessionHealthStatus;
  steamId64: string | null;
  accountName: string | null;
  profileUrl: string | null;
  hasSessionIdCookie: boolean;
  hasSteamLoginSecure: boolean;
  redirectedToLogin: boolean;
  reason?: string;
  checkedAt: string;
}

export type LoginResultType = 'LOGIN_SUCCESS' | 'LOGIN_INVALID' | 'LOGIN_HEALTH_CHECK_UNAVAILABLE';

export interface LoginResult {
  type: LoginResultType;
  success: boolean;
  session?: SessionHealthResult;
  message?: string;
}

export class SteamSessionManager {
  private lastSuccessfulAuthCheck: string | null = null;
  private cachedSteamId64: string | null = null;
  private cachedAccountName: string | null = null;
  private cachedProfileUrl: string | null = null;
  private isLastCheckValid: boolean = false;

  constructor(
    private browserManager: SteamBrowserManager,
    private logger: Logger
  ) {}

  public getLastSuccessfulAuthCheck(): string | null {
    return this.lastSuccessfulAuthCheck;
  }

  public getCachedSessionInfo(): {
    steamId64: string | null;
    accountName: string | null;
    profileUrl: string | null;
    isLastCheckValid: boolean;
  } {
    return {
      steamId64: this.cachedSteamId64,
      accountName: this.cachedAccountName,
      profileUrl: this.cachedProfileUrl,
      isLastCheckValid: this.isLastCheckValid
    };
  }

  /**
   * Authenticated-session health check:
   * 1. Prioritizes reusing existingPage or an already open page from ctx.pages()
   * 2. Only attempts to create a new page as a last resort
   * 3. Distinguishes SESSION_VALID, SESSION_INVALID, and HEALTH_CHECK_UNAVAILABLE
   * 4. Checks g_steamID, account UI, and auxiliary cookies
   */
  public async checkSessionHealth(existingPage?: any): Promise<SessionHealthResult> {
    const checkedAt = new Date().toISOString();
    let page: any = null;
    let shouldClosePage = false;

    try {
      const ctx = await this.browserManager.getContext();
      let cookies: any[] = [];
      try {
        cookies = await ctx.cookies();
      } catch {
        // Context might be restricted
      }

      const hasSessionIdCookie = cookies.some((c: any) => c.name === 'sessionid' && c.value && c.value.length > 0);
      const loginCookie = cookies.find((c: any) => c.name === 'steamLoginSecure' && c.value && c.value.length > 10);
      const hasSteamLoginSecure = Boolean(loginCookie);
      const steamLoginSecurePrefix = loginCookie ? loginCookie.value.substring(0, 17) + '...' : null;

      if (!hasSteamLoginSecure) {
        this.logger.warn('SESSION_COOKIE_MISSING', {
          reason: 'steamLoginSecure cookie is missing or invalid (health warning)'
        });
      }

      // Step 1: Resolve Page to use without unnecessarily calling newPage()
      if (existingPage && typeof existingPage.isClosed === 'function' && !existingPage.isClosed()) {
        page = existingPage;
        shouldClosePage = false;
      } else {
        const openPages = (ctx && typeof ctx.pages === 'function') ? ctx.pages() : [];
        const candidate = openPages.find((p: any) => p && typeof p.isClosed === 'function' && !p.isClosed());
        if (candidate) {
          page = candidate;
          shouldClosePage = false;
        } else {
          try {
            page = await this.browserManager.openEphemeralPage();
            shouldClosePage = true;
          } catch (err: any) {
            this.logger.warn('SESSION_HEALTH_TARGET_UNAVAILABLE', {
              error: err.message || String(err)
            });
            return {
              valid: false,
              status: 'HEALTH_CHECK_UNAVAILABLE',
              steamId64: null,
              accountName: null,
              profileUrl: null,
              hasSessionIdCookie,
              hasSteamLoginSecure,
              redirectedToLogin: false,
              reason: `HEALTH_CHECK_UNAVAILABLE: ${err.message || 'Failed to open browser page'}`,
              checkedAt
            };
          }
        }
      }

      // Step 2: Navigate or reload /my
      try {
        await page.goto('https://steamcommunity.com/my', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
      } catch (err: any) {
        const errMsg = err.message || String(err);
        if (
          errMsg.includes('Target.createTarget') ||
          errMsg.includes('Protocol error') ||
          errMsg.includes('Target closed') ||
          errMsg.includes('session closed')
        ) {
          return {
            valid: false,
            status: 'HEALTH_CHECK_UNAVAILABLE',
            steamId64: null,
            accountName: null,
            profileUrl: null,
            hasSessionIdCookie,
            hasSteamLoginSecure,
            redirectedToLogin: false,
            reason: `HEALTH_CHECK_UNAVAILABLE: ${errMsg}`,
            checkedAt
          };
        }
        throw err;
      }

      const currentUrl: string = page.url ? page.url() : '';
      const redirectedToLogin = currentUrl.includes('/login') || currentUrl.includes('/login/home');

      const resolvedProfileDir = typeof this.browserManager.getProfileDir === 'function' ? this.browserManager.getProfileDir() : '(unknown)';
      const chromiumProcessId = typeof this.browserManager.getChromiumPid === 'function' ? this.browserManager.getChromiumPid() : null;
      const browserContextId = typeof this.browserManager.getContextId === 'function' ? this.browserManager.getContextId() : '(unknown)';
      const contextPagesCount = typeof this.browserManager.getOpenPagesCount === 'function' ? this.browserManager.getOpenPagesCount() : 0;

      if (redirectedToLogin) {
        this.isLastCheckValid = false;
        this.logger.warn('SESSION_HEALTH_FAILED', {
          reason: 'REDIRECTED_TO_LOGIN',
          currentUrl,
          resolvedProfileDir,
          chromiumProcessId,
          browserContextId,
          hasSteamLoginSecure,
          steamLoginSecurePrefix,
          contextPagesCount
        });
        return {
          valid: false,
          status: 'SESSION_INVALID',
          steamId64: null,
          accountName: null,
          profileUrl: currentUrl,
          hasSessionIdCookie,
          hasSteamLoginSecure,
          redirectedToLogin: true,
          reason: 'REDIRECTED_TO_LOGIN',
          checkedAt
        };
      }

      const pageState = await page.evaluate(() => {
        const gSteamId = (window as any).g_steamID;
        const accountPulldown = document.querySelector('#account_pulldown')?.textContent?.trim() || null;
        const isLoginButtonVisible = Boolean(document.querySelector('.global_action_link[href*="login"], a[href*="login.steampowered.com"]'));
        const hasUserAvatar = Boolean(document.querySelector('.user_avatar, #account_pulldown'));
        return {
          gSteamId: (gSteamId && gSteamId !== false && gSteamId !== '0') ? String(gSteamId) : null,
          accountPulldown,
          isLoginButtonVisible,
          hasUserAvatar
        };
      }).catch(() => ({
        gSteamId: null,
        accountPulldown: null,
        isLoginButtonVisible: true,
        hasUserAvatar: false
      }));

      this.logger.info('SESSION_STARTUP_DIAGNOSTICS', {
        resolvedProfileDir,
        chromiumProcessId,
        browserContextId,
        requestedUrl: 'https://steamcommunity.com/my',
        finalUrl: currentUrl,
        windowSteamId: pageState.gSteamId,
        accountName: pageState.accountPulldown,
        hasSteamLoginSecure,
        steamLoginSecurePrefix,
        contextPagesCount
      });

      // Check g_steamID
      if (!pageState.gSteamId || pageState.gSteamId === 'false' || pageState.gSteamId === '0') {
        this.isLastCheckValid = false;
        this.logger.warn('SESSION_HEALTH_FAILED', {
          reason: 'G_STEAMID_FALSE_OR_MISSING',
          gSteamId: pageState.gSteamId,
          resolvedProfileDir,
          chromiumProcessId,
          browserContextId
        });
        return {
          valid: false,
          status: 'SESSION_INVALID',
          steamId64: null,
          accountName: pageState.accountPulldown,
          profileUrl: currentUrl,
          hasSessionIdCookie,
          hasSteamLoginSecure,
          redirectedToLogin: false,
          reason: 'G_STEAMID_FALSE_OR_MISSING',
          checkedAt
        };
      }

      // Check steamLoginSecure presence
      if (!hasSteamLoginSecure) {
        this.isLastCheckValid = false;
        return {
          valid: false,
          status: 'SESSION_INVALID',
          steamId64: pageState.gSteamId,
          accountName: pageState.accountPulldown,
          profileUrl: currentUrl,
          hasSessionIdCookie,
          hasSteamLoginSecure: false,
          redirectedToLogin: false,
          reason: 'STEAM_LOGIN_SECURE_MISSING',
          checkedAt
        };
      }

      // Check account DOM indicators
      if (pageState.isLoginButtonVisible && !pageState.hasUserAvatar) {
        this.isLastCheckValid = false;
        this.logger.warn('SESSION_HEALTH_FAILED', {
          reason: 'LOGIN_BUTTON_VISIBLE_ANONYMOUS',
          resolvedProfileDir,
          chromiumProcessId,
          browserContextId
        });
        return {
          valid: false,
          status: 'SESSION_INVALID',
          steamId64: pageState.gSteamId,
          accountName: null,
          profileUrl: currentUrl,
          hasSessionIdCookie,
          hasSteamLoginSecure,
          redirectedToLogin: false,
          reason: 'LOGIN_BUTTON_VISIBLE_ANONYMOUS',
          checkedAt
        };
      }

      // All checks passed -> SESSION_VALID
      this.isLastCheckValid = true;
      this.lastSuccessfulAuthCheck = checkedAt;
      this.cachedSteamId64 = pageState.gSteamId;
      this.cachedAccountName = pageState.accountPulldown;
      this.cachedProfileUrl = currentUrl;

      this.logger.info('SESSION_HEALTH_OK', {
        steamId64: pageState.gSteamId,
        accountName: pageState.accountPulldown,
        profileUrl: currentUrl,
        resolvedProfileDir,
        chromiumProcessId,
        browserContextId
      });

      return {
        valid: true,
        status: 'SESSION_VALID',
        steamId64: pageState.gSteamId,
        accountName: pageState.accountPulldown,
        profileUrl: currentUrl,
        hasSessionIdCookie,
        hasSteamLoginSecure: true,
        redirectedToLogin: false,
        checkedAt
      };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      if (
        errMsg.includes('Target.createTarget') ||
        errMsg.includes('Protocol error') ||
        errMsg.includes('Target closed') ||
        errMsg.includes('session closed')
      ) {
        return {
          valid: false,
          status: 'HEALTH_CHECK_UNAVAILABLE',
          steamId64: null,
          accountName: null,
          profileUrl: null,
          hasSessionIdCookie: false,
          hasSteamLoginSecure: false,
          redirectedToLogin: false,
          reason: `HEALTH_CHECK_UNAVAILABLE: ${errMsg}`,
          checkedAt
        };
      }

      this.isLastCheckValid = false;
      this.logger.error('SESSION_HEALTH_ERROR', { error: errMsg });
      return {
        valid: false,
        status: 'SESSION_INVALID',
        steamId64: null,
        accountName: null,
        profileUrl: null,
        hasSessionIdCookie: false,
        hasSteamLoginSecure: false,
        redirectedToLogin: false,
        reason: errMsg || 'SESSION_HEALTH_EXCEPTION',
        checkedAt
      };
    } finally {
      if (page && shouldClosePage) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * Lightweight in-context session verification on an existing page.
   * Does NOT navigate away or generate extra network requests.
   */
  public static async checkLightweightSession(page: any): Promise<{
    valid: boolean;
    steamId: string | null;
    hasSessionId: boolean;
    hasLoginCookie: boolean;
    reason?: string;
  }> {
    try {
      const ctx = page.context ? page.context() : null;
      let hasLoginCookie = false;
      let hasSessionId = false;
      let cookieSteamId: string | null = null;

      if (ctx && typeof ctx.cookies === 'function') {
        let cookies: any[] = [];
        try {
          cookies = await ctx.cookies();
        } catch {
          try {
            cookies = await ctx.cookies('https://steamcommunity.com');
          } catch {}
        }
        hasLoginCookie = cookies.some((c: any) => c.name === 'steamLoginSecure' && c.value && c.value.length > 10);
        hasSessionId = cookies.some((c: any) => c.name === 'sessionid' && c.value && c.value.length > 0);

        const loginCookie = cookies.find((c: any) => c.name === 'steamLoginSecure' && c.value && c.value.length > 17);
        if (loginCookie) {
          const m = loginCookie.value.match(/^(\d{17})/);
          if (m) {
            cookieSteamId = m[1];
          }
        }
      }

      const evalResult = await page.evaluate(() => {
        let sid = (window as any).g_sessionID;
        if (!sid) {
          const m = document.cookie.match(/sessionid=([^;]+)/);
          if (m) sid = decodeURIComponent(m[1].trim());
        }
        const gSteamId = (window as any).g_steamID;
        const validSteamId = (gSteamId && gSteamId !== false && gSteamId !== '0') ? String(gSteamId) : null;
        const accountPulldown = document.querySelector('#account_pulldown')?.textContent?.trim() || null;
        const hasLoginCookieInDoc = document.cookie.includes('steamLoginSecure=');

        return {
          sessionId: sid || null,
          steamId: validSteamId,
          accountPulldown,
          hasLoginCookieInDoc
        };
      }).catch(() => ({
        sessionId: null,
        steamId: null,
        accountPulldown: null,
        hasLoginCookieInDoc: false
      }));

      const resolvedHasLogin = hasLoginCookie || evalResult.hasLoginCookieInDoc;
      const resolvedHasSession = hasSessionId || Boolean(evalResult.sessionId);
      const effectiveSteamId = evalResult.steamId || (resolvedHasLogin ? cookieSteamId : null);
      const isAnon = !effectiveSteamId;

      if (isAnon || !resolvedHasLogin) {
        return {
          valid: false,
          steamId: effectiveSteamId,
          hasSessionId: resolvedHasSession,
          hasLoginCookie: resolvedHasLogin,
          reason: isAnon ? 'ANONYMOUS_SESSION_G_STEAMID_ABSENT' : 'STEAM_LOGIN_SECURE_MISSING'
        };
      }

      return {
        valid: true,
        steamId: effectiveSteamId,
        hasSessionId: resolvedHasSession,
        hasLoginCookie: resolvedHasLogin
      };
    } catch (err: any) {
      return {
        valid: false,
        steamId: null,
        hasSessionId: false,
        hasLoginCookie: false,
        reason: err.message || 'LIGHTWEIGHT_CHECK_FAILED'
      };
    }
  }

  public async runInteractiveLogin(expectedSteamId?: string): Promise<LoginResult> {
    console.log('\n========================================');
    console.log('   Steam AI Reply Bot - 登录恢复向导');
    console.log('========================================\n');
    console.log('1. 正在启动可视浏览器窗口（使用本地持久化 profile）...');
    console.log('2. 请在弹出的浏览器窗口中手动输入您的 Steam 账号和密码。');
    console.log('3. 手动完成 Steam 手机令牌 / 邮箱验证码。');
    console.log('4. 登录成功后，凭据将保存在 data/browser-profile/。');
    console.log('5. 本程序严格不自动输入密码、不收集、不保存任何密码。\n');

    this.logger.info('LOGIN_STARTED', 'Interactive login wizard launched');

    const ctx = await this.browserManager.getContext();
    let page: any = null;

    // Prioritize reusing existing page if already opened by browser launch
    const existingPages = (ctx && typeof ctx.pages === 'function') ? ctx.pages() : [];
    if (existingPages.length > 0 && !existingPages[0].isClosed()) {
      page = existingPages[0];
    } else {
      page = await ctx.newPage();
    }

    try {
      this.logger.info('INTERACTIVE_LOGIN_WAITING', {
        targetUrl: 'https://steamcommunity.com/login/home/?goto='
      });

      await page.goto('https://steamcommunity.com/login/home/?goto=', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      console.log('[Login] 浏览器已打开，请在窗口中登录 Steam...');

      const maxWaitMs = 5 * 60 * 1000;
      const startTime = Date.now();
      let loggedIn = false;
      let lastObservedSteamId: string | null = null;
      let lastObservedAccountName: string | null = null;

      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, 2000));

        if (page.isClosed()) {
          const remainingPages = (ctx && typeof ctx.pages === 'function') ? ctx.pages() : [];
          page = remainingPages.find((p: any) => !p.isClosed());
          if (!page) {
            this.logger.warn('INTERACTIVE_LOGIN_CANCELLED', {
              reason: 'Browser window was closed before login completed'
            });
            return {
              type: 'LOGIN_INVALID',
              success: false,
              message: 'WINDOW_CLOSED'
            };
          }
        }

        // Primary check: DOM and JavaScript state of Steam page
        const pageState = await page.evaluate(() => {
          const gSteamId = (window as any).g_steamID;
          const validSteamId = (gSteamId && gSteamId !== false && gSteamId !== '0') ? String(gSteamId) : null;
          const accountPulldown = document.querySelector('#account_pulldown')?.textContent?.trim() || null;
          const isUserAvatar = Boolean(document.querySelector('.user_avatar, #account_pulldown, #header_wallet_balance'));
          const isLoginButton = Boolean(document.querySelector('.global_action_link[href*="login"], a[href*="login.steampowered.com"]'));
          const currentUrl = window.location.href;
          const isAwayFromLogin = !currentUrl.includes('/login') && !currentUrl.includes('/login/home');
          return {
            steamId: validSteamId,
            accountPulldown,
            isUserAvatar,
            isLoginButton,
            isAwayFromLogin
          };
        }).catch(() => null);

        // Auxiliary check: Cookies
        const cookies = await ctx.cookies('https://steamcommunity.com').catch(() => []);
        const hasLoginCookie = cookies.some((c: any) => c.name === 'steamLoginSecure' && c.value.length > 10);

        if (pageState?.steamId) {
          lastObservedSteamId = pageState.steamId;
          lastObservedAccountName = pageState.accountPulldown;
          loggedIn = true;
          break;
        }

        if ((pageState?.isUserAvatar && !pageState?.isLoginButton) || (pageState?.isAwayFromLogin && hasLoginCookie)) {
          lastObservedAccountName = pageState?.accountPulldown || null;
          loggedIn = true;
          break;
        }
      }

      if (loggedIn) {
        console.log('\n[Login] 检测到登录操作完成，正在执行会话健康自检 (复用当前页面)...');

        // Reuse current page without closing it or calling newPage()
        const health = await this.checkSessionHealth(page);

        // Optional check for expected SteamID
        if (expectedSteamId && health.steamId64 && health.steamId64 !== expectedSteamId) {
          this.logger.warn('LOGIN_STEAMID_MISMATCH', {
            expected: expectedSteamId,
            actual: health.steamId64
          });
        }

        if (health.status === 'SESSION_VALID') {
          console.log(`\n✅ 登录成功且自检通过！(LOGIN_SUCCESS)`);
          console.log(`- SteamID64:   ${health.steamId64}`);
          console.log(`- 账号名称:    ${health.accountName || '已登录'}`);
          console.log(`- 个人主页:    ${health.profileUrl}`);
          this.logger.info('INTERACTIVE_LOGIN_SUCCESS', {
            steamId64: health.steamId64,
            accountName: health.accountName
          });
          this.logger.info('LOGIN_SUCCESS', {
            steamId64: health.steamId64,
            accountName: health.accountName
          });
          return {
            type: 'LOGIN_SUCCESS',
            success: true,
            session: health
          };
        } else if (health.status === 'HEALTH_CHECK_UNAVAILABLE') {
          const msg = 'Steam 登录已完成，但自动健康检查暂时无法创建检查页面。请稍后使用 --status 再次验证。';
          console.log(`\nℹ️ ${msg} (LOGIN_HEALTH_CHECK_UNAVAILABLE)`);
          this.logger.warn('LOGIN_HEALTH_CHECK_UNAVAILABLE', {
            reason: health.reason,
            lastObservedSteamId
          });
          return {
            type: 'LOGIN_HEALTH_CHECK_UNAVAILABLE',
            success: true,
            session: health,
            message: msg
          };
        } else {
          // SESSION_INVALID
          console.log(`\n❌ 登录会话无效或被重定向至登录页: ${health.reason} (LOGIN_INVALID)`);
          this.logger.warn('LOGIN_INVALID', { reason: health.reason });
          return {
            type: 'LOGIN_INVALID',
            success: false,
            session: health
          };
        }
      } else {
        console.log('\n❌ 登录超时（超过 5 分钟）或窗口已关闭。');
        this.logger.warn('LOGIN_TIMEOUT', 'Interactive login timed out');
        return {
          type: 'LOGIN_INVALID',
          success: false,
          message: 'LOGIN_TIMEOUT'
        };
      }
    } catch (e: any) {
      console.error('[Login] 发生异常:', e.message);
      this.logger.error('LOGIN_ERROR', e.message);
      return {
        type: 'LOGIN_HEALTH_CHECK_UNAVAILABLE',
        success: false,
        message: e.message
      };
    } finally {
      try {
        if (page && !page.isClosed()) {
          await page.close().catch(() => {});
        }
      } catch {
        // Ignore
      }
      if (this.browserManager && typeof this.browserManager.close === 'function') {
        await this.browserManager.close();
      }
    }
  }

  public async verifyLoggedIn(): Promise<boolean> {
    const health = await this.checkSessionHealth();
    return health.status === 'SESSION_VALID';
  }
}
