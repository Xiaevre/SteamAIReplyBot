const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runSessionLifecycleTests() {
  console.log('--- Running Steam Session Lifecycle & Auth Health Unit Tests ---');

  const { SteamSessionManager } = require('../../dist/steam/session');
  const { CommentSender } = require('../../dist/steam/commentSender');
  const { CommentMonitor } = require('../../dist/steam/commentMonitor');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');

  const warningsLogged = [];
  const errorsLogged = [];
  const infoLogged = [];

  const mockLogger = {
    info: (tag, data) => infoLogged.push({ tag, data }),
    warn: (tag, data) => warningsLogged.push({ tag, data }),
    error: (tag, data) => errorsLogged.push({ tag, data })
  };

  // =========================================================================
  // Test 1: /my redirected to login -> SESSION_INVALID
  // =========================================================================
  {
    console.log('--- Test 1: /my redirected to login -> SESSION_INVALID ---');
    const mockPage = {
      url: () => 'https://steamcommunity.com/login/home/?goto=%2Fmy',
      goto: async () => {},
      close: async () => {}
    };

    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => []
      }),
      openEphemeralPage: async () => mockPage
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth();

    assert.strictEqual(health.valid, false, 'Redirect to login must be invalid');
    assert.strictEqual(health.status, 'SESSION_INVALID');
    assert.strictEqual(health.redirectedToLogin, true);
    assert.strictEqual(health.reason, 'REDIRECTED_TO_LOGIN');
    console.log('  -> Test 1 Passed: /my redirection correctly identified as SESSION_INVALID');
  }

  // =========================================================================
  // Test 2: g_steamID=false / missing -> SESSION_INVALID
  // =========================================================================
  {
    console.log('--- Test 2: g_steamID=false -> SESSION_INVALID ---');
    const mockPage = {
      url: () => 'https://steamcommunity.com/my',
      goto: async () => {},
      evaluate: async () => ({
        gSteamId: null,
        accountPulldown: null,
        isLoginButtonVisible: true,
        hasUserAvatar: false
      }),
      close: async () => {}
    };

    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [{ name: 'sessionid', value: 'sess123' }]
      }),
      openEphemeralPage: async () => mockPage
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth();

    assert.strictEqual(health.valid, false);
    assert.strictEqual(health.status, 'SESSION_INVALID');
    assert.strictEqual(health.reason, 'G_STEAMID_FALSE_OR_MISSING');
    console.log('  -> Test 2 Passed: g_steamID=false correctly mapped to SESSION_INVALID');
  }

  // =========================================================================
  // Test 3: steamLoginSecure missing -> health warning & SESSION_INVALID
  // =========================================================================
  {
    console.log('--- Test 3: steamLoginSecure missing -> health warning & SESSION_INVALID ---');
    warningsLogged.length = 0;

    const mockPage = {
      url: () => 'https://steamcommunity.com/id/someuser',
      goto: async () => {},
      evaluate: async () => ({
        gSteamId: '76561198000000001',
        accountPulldown: 'SomeUser',
        isLoginButtonVisible: false,
        hasUserAvatar: true
      }),
      close: async () => {}
    };

    const mockBrowserManager = {
      getContext: async () => ({
        // sessionid exists but steamLoginSecure missing
        cookies: async () => [{ name: 'sessionid', value: 'sess12345' }]
      }),
      openEphemeralPage: async () => mockPage
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth();

    assert.strictEqual(health.valid, false);
    assert.strictEqual(health.status, 'SESSION_INVALID');
    assert.strictEqual(health.hasSteamLoginSecure, false);
    assert.strictEqual(health.reason, 'STEAM_LOGIN_SECURE_MISSING');

    const hasCookieWarn = warningsLogged.some(w => w.tag === 'SESSION_COOKIE_MISSING');
    assert.ok(hasCookieWarn, 'Must log SESSION_COOKIE_MISSING warning');
    console.log('  -> Test 3 Passed: steamLoginSecure absence triggers warning and SESSION_INVALID');
  }

  // =========================================================================
  // Test 4: authenticated /my -> SESSION_VALID
  // =========================================================================
  {
    console.log('--- Test 4: authenticated /my -> SESSION_VALID ---');
    const mockPage = {
      url: () => 'https://steamcommunity.com/id/authedUser/',
      goto: async () => {},
      evaluate: async () => ({
        gSteamId: '76561198123456789',
        accountPulldown: 'AuthedUser',
        isLoginButtonVisible: false,
        hasUserAvatar: true
      }),
      close: async () => {}
    };

    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [
          { name: 'sessionid', value: 'sess12345678' },
          { name: 'steamLoginSecure', value: '76561198123456789%7C%7CvalidJwtToken12345678' }
        ]
      }),
      openEphemeralPage: async () => mockPage
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth();

    assert.strictEqual(health.valid, true);
    assert.strictEqual(health.status, 'SESSION_VALID');
    assert.strictEqual(health.steamId64, '76561198123456789');
    assert.strictEqual(health.accountName, 'AuthedUser');
    assert.strictEqual(health.hasSteamLoginSecure, true);
    assert.strictEqual(health.hasSessionIdCookie, true);
    assert.ok(sessionManager.getLastSuccessfulAuthCheck(), 'Must record lastSuccessfulAuthCheck timestamp');
    console.log('  -> Test 4 Passed: Fully authenticated session verified as SESSION_VALID');
  }

  // =========================================================================
  // Test 5: invalid session + POST permission error -> SESSION_INVALID
  // =========================================================================
  {
    console.log('--- Test 5: invalid session + POST permission error -> SESSION_INVALID ---');
    let postExecuted = false;

    // Simulate unauthenticated browser context during comment send
    const mockPage = {
      context: () => ({
        cookies: async () => [{ name: 'timezoneOffset', value: '28800' }]
      }),
      goto: async () => {},
      $eval: async () => false, // Target profile is NOT restricted in DOM
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
            // Lightweight session check -> unauthenticated
            return {
              sessionId: null,
              steamId: null,
              accountPulldown: null,
              hasLoginCookieInDoc: false
            };
          }
          if (fnStr.includes('fetch')) {
            postExecuted = true;
            return {
              httpStatus: 200,
              networkError: null,
              rawJson: { success: false, error: '此帐户的设置不允许您添加留言。' },
              rawResponseText: '{"success":false,"error":"此帐户的设置不允许您添加留言。"}'
            };
          }
        }
        return {};
      },
      close: async () => {}
    };

    const mockBrowserManager = {
      openEphemeralPage: async () => mockPage
    };

    const sender = new CommentSender(mockBrowserManager, 'https://steamcommunity.com/id/myid', mockLogger);
    const result = await sender.sendReply('https://steamcommunity.com/profiles/76561199202573055', 'test reply');

    assert.strictEqual(result.status, 'SESSION_INVALID', 'Unauthenticated session must result in SESSION_INVALID');
    assert.strictEqual(postExecuted, false, 'Pre-send check must prevent POST from executing when unauthenticated');
    console.log('  -> Test 5 Passed: Invalid session intercepted as SESSION_INVALID before POST');
  }

  // =========================================================================
  // Test 6: valid session + target genuinely restricted -> TARGET_RESTRICTED (PERMISSION_DENIED)
  // =========================================================================
  {
    console.log('--- Test 6: valid session + target genuinely restricted -> TARGET_RESTRICTED ---');
    const mockPage = {
      context: () => ({
        cookies: async () => [
          { name: 'sessionid', value: 'sess_valid_123' },
          { name: 'steamLoginSecure', value: '76561198000000000%7C%7CvalidToken' }
        ]
      }),
      goto: async () => {},
      $eval: async (sel) => {
        // Target profile DOM has explicit restricted notice
        if (sel.includes('commentthread_restricted') || sel.includes('profile_comment_area_restricted')) {
          return true;
        }
        return false;
      },
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
            return {
              sessionId: 'sess_valid_123',
              steamId: '76561198000000000',
              accountPulldown: 'MyAccount',
              hasLoginCookieInDoc: true
            };
          }
        }
        return {};
      },
      close: async () => {}
    };

    const mockBrowserManager = {
      openEphemeralPage: async () => mockPage
    };

    const sender = new CommentSender(mockBrowserManager, 'https://steamcommunity.com/id/myid', mockLogger);
    const result = await sender.sendReply('https://steamcommunity.com/profiles/76561199202573055', 'test reply');

    assert.strictEqual(result.status, 'PERMISSION_DENIED');
    assert.ok(result.message.includes('TARGET_RESTRICTED'), 'Message must indicate TARGET_RESTRICTED');
    console.log('  -> Test 6 Passed: Target genuine DOM restriction mapped to TARGET_RESTRICTED');
  }

  // =========================================================================
  // Test 7: State machine transitions: waiting_for_login -> authenticated -> resumed
  // =========================================================================
  {
    console.log('--- Test 7: State machine transitions: waiting_for_login -> authenticated -> resumed ---');
    const testDbPath = path.resolve(__dirname, 'test-session-state-machine.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = new AppDatabase(testDbPath);
    runMigrations(db);

    const replyTasksRepo = new ReplyTasksRepository(db);

    // Insert task in waiting_for_login
    replyTasksRepo.insert({
      task_id: 'task_login_pause_1',
      steam_comment_id: 'comm_login_pause_1',
      target_steam_id: '76561199202573055',
      target_profile_url: 'https://steamcommunity.com/profiles/76561199202573055',
      reply_text: 'paused reply',
      status: 'waiting_for_login',
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    });

    assert.strictEqual(replyTasksRepo.getWaitingForLoginTasksCount(), 1);

    const mockConfig = {
      STEAM_PROFILE_URL: 'https://steamcommunity.com/id/myprofile',
      DEEPSEEK_API_KEY: 'mock_key',
      DEEPSEEK_MODEL: 'deepseek-chat',
      CHECK_INTERVAL_MIN_SECONDS: 60,
      CHECK_INTERVAL_MAX_SECONDS: 120,
      DRY_RUN: false,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 50,
      MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
      HOLIDAY_ACTIVE_DAYS: 30,
      HOLIDAY_SEND_START: '09:00',
      HOLIDAY_SEND_END: '22:00',
      DEFAULT_LANGUAGE: 'zh',
      TIMEZONE: 'Asia/Shanghai',
      MIN_REPLY_DELAY_SECONDS: 5,
      MAX_REPLY_DELAY_SECONDS: 10,
      AI_REQUEST_DELAY_MS: 1000,
      MEMORY_WARNING_MB: 400,
      MEMORY_CRITICAL_MB: 800,
      BOT_ENABLED: true,
      EMERGENCY_STOP: false
    };

    const scheduler = new TaskScheduler(mockConfig, db, mockLogger);
    assert.strictEqual(scheduler.getSessionState(), 'waiting_for_login');

    scheduler.transitionSessionState('authenticated');
    assert.strictEqual(scheduler.getSessionState(), 'authenticated');

    scheduler.transitionSessionState('resumed');
    assert.strictEqual(scheduler.getSessionState(), 'resumed');

    // Verify task status was automatically restored to waiting
    const restoredTask = replyTasksRepo.findByTaskId('task_login_pause_1');
    assert.strictEqual(restoredTask.status, 'waiting', 'Task must transition back to waiting on resumed');
    assert.strictEqual(replyTasksRepo.getWaitingForLoginTasksCount(), 0);

    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    console.log('  -> Test 7 Passed: State machine transitions and task resumption verified');
  }

  // =========================================================================
  // Test 8: newPage throws Target.createTarget -> HEALTH_CHECK_UNAVAILABLE
  // =========================================================================
  {
    console.log('--- Test 8: newPage throws Target.createTarget -> HEALTH_CHECK_UNAVAILABLE ---');
    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [{ name: 'sessionid', value: 'sess123' }, { name: 'steamLoginSecure', value: '76561198000000000%7C%7CvalidJwt' }],
        pages: () => [] // No existing pages
      }),
      openEphemeralPage: async () => {
        throw new Error('browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab');
      }
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth();

    assert.strictEqual(health.valid, false);
    assert.strictEqual(health.status, 'HEALTH_CHECK_UNAVAILABLE', 'Must classify as HEALTH_CHECK_UNAVAILABLE, NOT SESSION_INVALID');
    assert.ok(health.reason.includes('HEALTH_CHECK_UNAVAILABLE'));
    assert.ok(health.reason.includes('Target.createTarget'));
    console.log('  -> Test 8 Passed: Target.createTarget error correctly classified as HEALTH_CHECK_UNAVAILABLE');
  }

  // =========================================================================
  // Test 9: Reusing existing authenticated page directly completes SESSION_VALID
  // =========================================================================
  {
    console.log('--- Test 9: Reusing existing authenticated page directly completes SESSION_VALID ---');
    let newPageCalled = false;
    let pageClosed = false;

    const existingPage = {
      isClosed: () => false,
      url: () => 'https://steamcommunity.com/id/myprofile/',
      goto: async () => {},
      evaluate: async () => ({
        gSteamId: '76561198000000000',
        accountPulldown: 'MyAccount',
        isLoginButtonVisible: false,
        hasUserAvatar: true
      }),
      close: async () => {
        pageClosed = true;
      }
    };

    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [
          { name: 'sessionid', value: 'sess123' },
          { name: 'steamLoginSecure', value: '76561198000000000%7C%7CvalidJwt' }
        ],
        pages: () => [existingPage]
      }),
      openEphemeralPage: async () => {
        newPageCalled = true;
        throw new Error('Should not call openEphemeralPage when existing page is available');
      }
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    // Call with existingPage passed in
    const health = await sessionManager.checkSessionHealth(existingPage);

    assert.strictEqual(newPageCalled, false, 'Must NOT create new page when existing page is provided');
    assert.strictEqual(pageClosed, false, 'Must NOT close caller-provided existing page');
    assert.strictEqual(health.status, 'SESSION_VALID');
    assert.strictEqual(health.valid, true);
    assert.strictEqual(health.steamId64, '76561198000000000');
    console.log('  -> Test 9 Passed: Existing open page reused directly without opening new tab');
  }

  // =========================================================================
  // Test 10: Existing page redirected to login -> SESSION_INVALID
  // =========================================================================
  {
    console.log('--- Test 10: Existing page redirected to login -> SESSION_INVALID ---');
    const existingPage = {
      isClosed: () => false,
      url: () => 'https://steamcommunity.com/login/home/?goto=%2Fmy',
      goto: async () => {},
      close: async () => {}
    };

    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [],
        pages: () => [existingPage]
      }),
      openEphemeralPage: async () => {
        throw new Error('Should not call openEphemeralPage');
      }
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    const health = await sessionManager.checkSessionHealth(existingPage);

    assert.strictEqual(health.status, 'SESSION_INVALID');
    assert.strictEqual(health.redirectedToLogin, true);
    assert.strictEqual(health.reason, 'REDIRECTED_TO_LOGIN');
    console.log('  -> Test 10 Passed: Existing page redirected to login correctly identified as SESSION_INVALID');
  }

  // =========================================================================
  // Test 11: Preserving profile on Target.createTarget error (No profile deletion)
  // =========================================================================
  {
    console.log('--- Test 11: Preserving profile on Target.createTarget error ---');
    const profileDir = path.resolve(__dirname, 'test-profile-preserve');
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const dummyCookieFile = path.join(profileDir, 'Cookies');
    fs.writeFileSync(dummyCookieFile, 'dummy-cookie-data');

    // Simulate runInteractiveLogin encountering Target.createTarget during health check
    const mockPage = {
      isClosed: () => false,
      goto: async () => {},
      evaluate: async () => ({
        steamId: '76561198000000000',
        accountPulldown: 'MyAccount',
        isUserAvatar: true,
        isLoginButton: false,
        isAwayFromLogin: true
      }),
      close: async () => {}
    };

    let browserClosed = false;
    const mockBrowserManager = {
      getContext: async () => ({
        cookies: async () => [{ name: 'steamLoginSecure', value: '76561198000000000%7C%7CvalidJwt' }],
        pages: () => [mockPage]
      }),
      openEphemeralPage: async () => {
        throw new Error('Protocol error (Target.createTarget): Failed to open a new tab');
      },
      close: async () => {
        browserClosed = true;
      }
    };

    const sessionManager = new SteamSessionManager(mockBrowserManager, mockLogger);
    // Mock checkSessionHealth to throw or return HEALTH_CHECK_UNAVAILABLE
    sessionManager.checkSessionHealth = async () => ({
      valid: false,
      status: 'HEALTH_CHECK_UNAVAILABLE',
      steamId64: null,
      accountName: null,
      profileUrl: null,
      hasSessionIdCookie: true,
      hasSteamLoginSecure: true,
      redirectedToLogin: false,
      reason: 'HEALTH_CHECK_UNAVAILABLE: Protocol error (Target.createTarget): Failed to open a new tab',
      checkedAt: new Date().toISOString()
    });

    const loginResult = await sessionManager.runInteractiveLogin();

    assert.strictEqual(loginResult.type, 'LOGIN_HEALTH_CHECK_UNAVAILABLE');
    assert.strictEqual(loginResult.success, true, 'Login itself succeeded, must return success: true');
    assert.ok(fs.existsSync(dummyCookieFile), 'Browser profile files MUST NOT be wiped or deleted');
    assert.strictEqual(browserClosed, true);

    fs.unlinkSync(dummyCookieFile);
    fs.rmdirSync(profileDir);
    console.log('  -> Test 11 Passed: Profile data strictly preserved during Target.createTarget error');
  }

  // =========================================================================
  // Test 12: Persistent Context Consistency: checkSessionHealth -> monitor -> sendReply
  // =========================================================================
  {
    console.log('--- Test 12: Persistent Context Consistency across health check -> monitor -> sender ---');
    const EXPECTED_STEAM_ID = '76561198000000001';
    const EXPECTED_ACCOUNT = 'TestBotAccount';
    const sharedCookies = [
      { name: 'sessionid', value: 'sess_persistent_123', domain: 'steamcommunity.com', path: '/' },
      { name: 'steamLoginSecure', value: `${EXPECTED_STEAM_ID}%7C%7CvalidJwtToken123456789`, domain: 'steamcommunity.com', path: '/' }
    ];

    const sharedContext = {
      cookies: async () => sharedCookies,
      pages: () => []
    };

    let observedSenderSteamId = null;
    let observedMonitorSteamId = null;

    const createSharedPage = (pageType) => ({
      isClosed: () => false,
      context: () => sharedContext,
      url: () => {
        if (pageType === 'health') return 'https://steamcommunity.com/id/test_bot_profile/';
        if (pageType === 'monitor') return 'https://steamcommunity.com/id/test_bot_profile/?_t=123456';
        return 'https://steamcommunity.com/profiles/76561198000000002';
      },
      goto: async () => {},
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      $eval: async () => false,
      $$eval: async (sel, fn) => {
        if (typeof fn === 'function') {
          const fakeComments = [{
            querySelector: (s) => {
              if (s.includes('text')) return { textContent: 'test reply' };
              if (s.includes('author')) return { textContent: EXPECTED_ACCOUNT, getAttribute: () => 'https://steamcommunity.com/id/test_bot_profile/' };
              return null;
            }
          }];
          return fn(fakeComments);
        }
        return [];
      },
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function') {
          const fnStr = fn.toString();
          // Evaluate in page
          if (fnStr.includes('fetch')) {
            return {
              httpStatus: 200,
              networkError: null,
              rawJson: {
                success: true,
                comments_html: '<div class="commentthread_comment" id="comment_999999999"></div>'
              },
              rawResponseText: '{"success":true}',
              sessionIdFound: true
            };
          }
          if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
            return {
              gSteamId: EXPECTED_STEAM_ID,
              sessionId: 'sess_persistent_123',
              steamId: EXPECTED_STEAM_ID,
              accountPulldown: EXPECTED_ACCOUNT,
              isLoginButtonVisible: false,
              hasUserAvatar: true,
              hasLoginCookieInDoc: true
            };
          }
          if (fnStr.includes('sessionid')) {
            return {
              hasSessionCookie: true,
              hasLoginSecureCookie: true,
              steamLoginSecureValue: `${EXPECTED_STEAM_ID}%7C%7CvalidJwtToken123456789`,
              steamIdInCookie: EXPECTED_STEAM_ID
            };
          }
          if (fnStr.includes('g_rgProfileData')) {
            return { steamId: '76561198000000002', source: 'g_rgProfileData' };
          }
        }
        return {
          gSteamId: EXPECTED_STEAM_ID,
          sessionId: 'sess_persistent_123',
          steamId: EXPECTED_STEAM_ID,
          accountPulldown: EXPECTED_ACCOUNT,
          isLoginButtonVisible: false,
          hasUserAvatar: true,
          hasLoginCookieInDoc: false
        };
      },
      close: async () => {}
    });

    let pageInvocationCount = 0;
    const persistentBrowserManager = {
      getContext: async () => sharedContext,
      getProfileDir: () => path.join('mock', 'data', 'browser-profile'),
      getContextId: () => 'ctx_persistent_test',
      getChromiumPid: () => 12345,
      getOpenPagesCount: () => 1,
      openEphemeralPage: async () => {
        pageInvocationCount++;
        const type = pageInvocationCount === 1 ? 'health' : pageInvocationCount === 2 ? 'monitor' : 'sender';
        return createSharedPage(type);
      }
    };

    // Step 1: Health check
    const sessionManager = new SteamSessionManager(persistentBrowserManager, mockLogger);
    const healthResult = await sessionManager.checkSessionHealth();
    assert.strictEqual(healthResult.valid, true, 'Health check must be valid');
    assert.strictEqual(healthResult.steamId64, EXPECTED_STEAM_ID, 'Health check must observe expected SteamID64');
    assert.strictEqual(healthResult.accountName, EXPECTED_ACCOUNT);

    // Step 2: Comment Monitor
    const commentMonitor = new CommentMonitor(persistentBrowserManager, 'https://steamcommunity.com/id/test_bot_profile/', mockLogger);
    const monitorPage = await persistentBrowserManager.openEphemeralPage();
    const monitorSession = await SteamSessionManager.checkLightweightSession(monitorPage);
    observedMonitorSteamId = monitorSession.steamId;
    assert.strictEqual(monitorSession.valid, true, 'Monitor session must be valid');
    assert.strictEqual(observedMonitorSteamId, EXPECTED_STEAM_ID, 'Monitor must observe identical SteamID64');

    // Step 3: Comment Sender
    const sender = new CommentSender(persistentBrowserManager, 'https://steamcommunity.com/id/test_bot_profile/', mockLogger);
    const senderPage = await persistentBrowserManager.openEphemeralPage();
    const senderSession = await SteamSessionManager.checkLightweightSession(senderPage);
    observedSenderSteamId = senderSession.steamId;
    assert.strictEqual(senderSession.valid, true, 'Sender session must be valid');
    assert.strictEqual(observedSenderSteamId, EXPECTED_STEAM_ID, 'Sender must observe identical SteamID64');

    const sendResult = await sender.sendReply('https://steamcommunity.com/profiles/76561199202573055', 'test reply');
    assert.strictEqual(sendResult.status, 'SUCCESS', 'Send must succeed on valid session');

    // Strict identity assertion across all 3 components on the same context
    assert.strictEqual(healthResult.steamId64, observedMonitorSteamId, 'Health check and monitor SteamID64 must be strictly identical');
    assert.strictEqual(observedMonitorSteamId, observedSenderSteamId, 'Monitor and sender SteamID64 must be strictly identical');
    assert.strictEqual(healthResult.steamId64, EXPECTED_STEAM_ID);
    console.log(`  -> Test 12 Passed: Strict SteamID64 identity (${EXPECTED_STEAM_ID}) confirmed across health check -> monitor -> sender`);
  }

  // =========================================================================
  // Test 13: --login branch instantiation: sessionManager exists and is usable
  // =========================================================================
  {
    console.log('--- Test 13: --login CLI instantiation & sessionManager availability ---');
    const { SteamBrowserManager } = require('../../dist/steam/browser');

    const testBrowserManager = new SteamBrowserManager(mockLogger, {
      headless: true
    });
    const sessionManager = new SteamSessionManager(testBrowserManager, mockLogger);

    assert.ok(sessionManager, 'sessionManager must be defined in --login branch');
    assert.strictEqual(typeof sessionManager.runInteractiveLogin, 'function', 'runInteractiveLogin must be callable');
    assert.strictEqual(typeof sessionManager.checkSessionHealth, 'function', 'checkSessionHealth must be callable');

    // Also verify dist/index.js contains explicit instantiation before runInteractiveLogin
    const indexJsContent = fs.readFileSync(path.resolve(__dirname, '../../dist/index.js'), 'utf8');
    const loginBranchRegex = /new\s+SteamSessionManager\s*\(\s*browserManager\s*,\s*logger\s*\)[\s\S]*?runInteractiveLogin/;
    assert.ok(
      loginBranchRegex.test(indexJsContent),
      'dist/index.js MUST instantiate SteamSessionManager before calling runInteractiveLogin in --login branch'
    );
    console.log('  -> Test 13 Passed: sessionManager is strictly instantiated and available in --login branch');
  }

  console.log('✅ All Steam Session Lifecycle tests PASSED!');
}

module.exports = { runSessionLifecycleTests };

if (require.main === module) {
  runSessionLifecycleTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
