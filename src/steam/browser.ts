import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { getBrowserProfileDir, getPlaywrightTempDir, getBrowsersDir } from '../utils/paths';

export type BrowserMode = 'AUTO' | 'CHROME' | 'EDGE';

export interface SteamBrowserOptions {
  headless?: boolean;
  profileDir?: string;
  tempDir?: string;
  executablePath?: string;
  browserMode?: BrowserMode;
  channel?: string;
}

export interface ResolvedBrowserInfo {
  browserName: 'Google Chrome' | 'Microsoft Edge' | 'Custom Chromium' | 'Playwright Bundled';
  executablePath: string;
}

export class BrowserLifecycleError extends Error {
  public readonly isLifecycleError = true;
  constructor(message: string) {
    super(message);
    this.name = 'BrowserLifecycleError';
  }
}

export class SteamBrowserManager {
  private playwright: any = null;
  private browserContext: any = null;
  private logger: Logger;
  private profileDir: string;
  private tempDir: string;
  private headless: boolean;
  private executablePath?: string;
  private browserMode: BrowserMode;
  private channel?: string;
  private contextId: string = '';
  private chromiumPid: number | null = null;
  private selectedBrowserInfo: ResolvedBrowserInfo | null = null;
  private isClosing: boolean = false;

  constructor(logger: Logger, options: SteamBrowserOptions = {}) {
    this.logger = logger;
    this.headless = options.headless !== undefined ? options.headless : true;
    this.profileDir = path.resolve(options.profileDir || getBrowserProfileDir());
    this.tempDir = path.resolve(options.tempDir || getPlaywrightTempDir());
    this.executablePath = options.executablePath;
    this.browserMode = options.browserMode || 'AUTO';
    this.channel = options.channel;

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    if (this.profileDir.toLowerCase() === this.tempDir.toLowerCase()) {
      throw new Error(`Profile directory and temp directory must not be the same: ${this.profileDir}`);
    }
  }

  private loadPlaywright(): any {
    if (this.playwright) return this.playwright;
    try {
      this.playwright = require('playwright');
      return this.playwright;
    } catch {
      try {
        const userHome = process.env.USERPROFILE || process.env.HOME || '';
        const codexPath = userHome ? path.join(userHome, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright') : '';
        if (codexPath && fs.existsSync(codexPath)) {
          this.playwright = require(codexPath);
          return this.playwright;
        }
        throw new Error('Standard playwright package resolution failed');
      } catch (e: any) {
        throw new Error('Playwright could not be loaded: ' + e.message);
      }
    }
  }

  /**
   * Discovers candidate browser executable paths on the current system.
   */
  public static getStandardChromeCandidates(): string[] {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
  }

  public static getStandardEdgeCandidates(): string[] {
    return [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
  }

  /**
   * Resolves browser executable according to configured mode and priorities:
   * 1. Explicitly configured executablePath (must exist, else throws)
   * 2. BROWSER_MODE === 'CHROME': Checks Chrome candidates (must exist, else throws)
   * 3. BROWSER_MODE === 'EDGE': Checks Edge candidates (must exist, else throws)
   * 4. BROWSER_MODE === 'AUTO' (Default):
   *    - Release bundled Chrome/Chromium
   *    - Google Chrome (standard installation paths)
   *    - Microsoft Edge (standard installation paths)
   *    - Playwright bundled chromium
   *    - Throws error if no compatible Chromium browser found
   */
  public resolveExecutablePath(): string {
    const mode = (this.browserMode || 'AUTO').toUpperCase() as BrowserMode;

    // 1. Explicit custom executable path specified
    if (this.executablePath && this.executablePath.trim()) {
      const explicit = path.resolve(this.executablePath.trim());
      if (!fs.existsSync(explicit)) {
        throw new Error(`[BROWSER_ERROR] Configured browser executable path does not exist: "${explicit}"`);
      }
      this.selectedBrowserInfo = {
        browserName: explicit.toLowerCase().includes('msedge') ? 'Microsoft Edge' : explicit.toLowerCase().includes('chrome') ? 'Google Chrome' : 'Custom Chromium',
        executablePath: explicit
      };
      this.logger.info('BROWSER_SELECTED', {
        browserName: this.selectedBrowserInfo.browserName,
        executablePath: explicit,
        mode: 'EXPLICIT_CONFIG'
      });
      return explicit;
    }

    // 2. Explicit CHROME mode
    if (mode === 'CHROME') {
      const chromeCandidates = SteamBrowserManager.getStandardChromeCandidates();
      for (const cand of chromeCandidates) {
        if (fs.existsSync(cand)) {
          this.selectedBrowserInfo = { browserName: 'Google Chrome', executablePath: cand };
          this.logger.info('BROWSER_SELECTED', {
            browserName: 'Google Chrome',
            executablePath: cand,
            mode: 'CHROME'
          });
          return cand;
        }
      }
      throw new Error(
        `[BROWSER_ERROR] Google Chrome was explicitly requested (BROWSER_MODE=CHROME), but Chrome was not found at standard installation locations:\n` +
        chromeCandidates.map(c => `  - ${c}`).join('\n')
      );
    }

    // 3. Explicit EDGE mode
    if (mode === 'EDGE') {
      const edgeCandidates = SteamBrowserManager.getStandardEdgeCandidates();
      for (const cand of edgeCandidates) {
        if (fs.existsSync(cand)) {
          this.selectedBrowserInfo = { browserName: 'Microsoft Edge', executablePath: cand };
          this.logger.info('BROWSER_SELECTED', {
            browserName: 'Microsoft Edge',
            executablePath: cand,
            mode: 'EDGE'
          });
          return cand;
        }
      }
      throw new Error(
        `[BROWSER_ERROR] Microsoft Edge was explicitly requested (BROWSER_MODE=EDGE), but Edge was not found at standard installation locations:\n` +
        edgeCandidates.map(c => `  - ${c}`).join('\n')
      );
    }

    // 4. AUTO mode: Priority: Release Bundled -> Google Chrome -> Microsoft Edge -> Playwright Bundled
    // Priority A: Check release/browsers directory if present
    const releaseBrowsers = getBrowsersDir();
    if (fs.existsSync(releaseBrowsers)) {
      const candidates = [
        path.join(releaseBrowsers, 'chrome-win', 'chrome.exe'),
        path.join(releaseBrowsers, 'chrome.exe'),
        path.join(releaseBrowsers, 'edge-win', 'msedge.exe')
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          this.selectedBrowserInfo = { browserName: 'Custom Chromium', executablePath: cand };
          this.logger.info('BROWSER_SELECTED', {
            browserName: 'Custom Chromium',
            executablePath: cand,
            mode: 'AUTO'
          });
          return cand;
        }
      }
    }

    // Priority B: System Google Chrome
    const chromeCandidates = SteamBrowserManager.getStandardChromeCandidates();
    for (const cand of chromeCandidates) {
      if (cand && fs.existsSync(cand)) {
        this.selectedBrowserInfo = { browserName: 'Google Chrome', executablePath: cand };
        this.logger.info('BROWSER_SELECTED', {
          browserName: 'Google Chrome',
          executablePath: cand,
          mode: 'AUTO'
        });
        return cand;
      }
    }

    // Priority C: System Microsoft Edge (Standard for Windows Server / Windows 10/11)
    const edgeCandidates = SteamBrowserManager.getStandardEdgeCandidates();
    for (const cand of edgeCandidates) {
      if (cand && fs.existsSync(cand)) {
        this.selectedBrowserInfo = { browserName: 'Microsoft Edge', executablePath: cand };
        this.logger.info('BROWSER_SELECTED', {
          browserName: 'Microsoft Edge',
          executablePath: cand,
          mode: 'AUTO'
        });
        return cand;
      }
    }

    // Priority D: Playwright bundled chromium
    try {
      const pw = this.loadPlaywright();
      if (pw && pw.chromium && typeof pw.chromium.executablePath === 'function') {
        const pwExe = pw.chromium.executablePath();
        if (pwExe && fs.existsSync(pwExe)) {
          this.selectedBrowserInfo = { browserName: 'Playwright Bundled', executablePath: pwExe };
          this.logger.info('BROWSER_SELECTED', {
            browserName: 'Playwright Bundled',
            executablePath: pwExe,
            mode: 'AUTO'
          });
          return pwExe;
        }
      }
    } catch {
      // Ignore
    }

    // None found -> Fail explicitly with clear instructions
    throw new Error(
      `[BROWSER_ERROR] No suitable Chromium browser found on this system!\n` +
      `Tested locations:\n` +
      `  Google Chrome:\n` + chromeCandidates.map(c => `    - ${c}`).join('\n') + `\n` +
      `  Microsoft Edge:\n` + edgeCandidates.map(c => `    - ${c}`).join('\n') + `\n` +
      `Please install Microsoft Edge or Google Chrome, or set BROWSER_PATH in .env / config.json to your browser executable.`
    );
  }

  public getSelectedBrowserInfo(): ResolvedBrowserInfo | null {
    return this.selectedBrowserInfo;
  }

  public setHeadless(headless: boolean): void {
    this.headless = headless;
  }

  public isHeadless(): boolean {
    return this.headless;
  }

  public isContextActive(): boolean {
    return this.browserContext !== null;
  }

  public async getContext(): Promise<any> {
    if (this.browserContext) {
      return this.browserContext;
    }

    const pw = this.loadPlaywright();
    const resolvedExe = this.resolveExecutablePath();

    const launchArgs = [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      `--disk-cache-dir=${path.join(this.tempDir, 'cache')}`
    ];

    if (this.headless) {
      launchArgs.push('--hide-scrollbars');
    } else {
      launchArgs.push('--start-maximized');
    }

    const lockfilePath = path.join(this.profileDir, 'lockfile');
    const hasLockfile = fs.existsSync(lockfilePath);

    this.logger.info('BROWSER_LAUNCHING', {
      headless: this.headless,
      profileDir: this.profileDir,
      tempDir: this.tempDir,
      hasLockfile,
      executablePath: resolvedExe || 'bundled/default'
    });

    const launchOptions: any = {
      headless: this.headless,
      args: launchArgs,
      viewport: this.headless ? { width: 1280, height: 720 } : null,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      artifactsDir: this.tempDir,
      downloadsPath: path.join(this.tempDir, 'downloads')
    };

    if (resolvedExe) {
      launchOptions.executablePath = resolvedExe;
    } else if (this.channel) {
      launchOptions.channel = this.channel;
    }

    this.browserContext = await pw.chromium.launchPersistentContext(this.profileDir, launchOptions);
    this.contextId = 'ctx_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);

    // Extract Chromium PID if available
    let pid: number | null = null;
    try {
      if (this.browserContext._browserProcess && typeof this.browserContext._browserProcess.pid === 'number') {
        pid = this.browserContext._browserProcess.pid;
      } else if (this.browserContext._browser && this.browserContext._browser._process && typeof this.browserContext._browser._process.pid === 'number') {
        pid = this.browserContext._browser._process.pid;
      } else if (typeof this.browserContext.browser === 'function' && this.browserContext.browser()?._process?.pid) {
        pid = this.browserContext.browser()._process.pid;
      }
    } catch {
      // Fallback
    }
    this.chromiumPid = pid;

    this.logger.info('BROWSER_LAUNCHED', {
      profileDir: this.profileDir,
      contextId: this.contextId,
      chromiumPid: this.chromiumPid,
      headless: this.headless
    });

    // Route blocking to reduce memory in headless mode only
    if (this.headless) {
      await this.browserContext.route('**/*', (route: any) => {
        const req = route.request();
        const resType = req.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resType) && !req.url().includes('steamcommunity')) {
          return route.abort();
        }
        return route.continue();
      });
    }

    return this.browserContext;
  }

  public getProfileDir(): string {
    return this.profileDir;
  }

  public getContextId(): string {
    return this.contextId;
  }

  public getChromiumPid(): number | null {
    return this.chromiumPid;
  }

  public isBrowserClosing(): boolean {
    return this.isClosing;
  }

  public async openEphemeralPage(): Promise<any> {
    if (this.isClosing) {
      throw new BrowserLifecycleError('Browser is currently closing or restarting');
    }
    const ctx = await this.getContext();
    if (this.isClosing || !ctx) {
      throw new BrowserLifecycleError('Browser context is not available');
    }
    try {
      return await ctx.newPage();
    } catch (err: any) {
      const msg = err.message || String(err);
      if (
        msg.includes('closed') ||
        msg.includes('Protocol error') ||
        msg.includes('Failed to open a new tab')
      ) {
        throw new BrowserLifecycleError(`Browser context closed during page creation: ${msg}`);
      }
      throw err;
    }
  }

  public getOpenPagesCount(): number {
    if (!this.browserContext) return 0;
    try {
      return this.browserContext.pages().length;
    } catch {
      return 0;
    }
  }

  public async cleanupStrayPages(): Promise<void> {
    if (!this.browserContext) return;
    try {
      const pages = this.browserContext.pages();
      // Keep at most 1 empty page or close all unused
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        try {
          if (!p.isClosed()) {
            await p.close();
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  public async resetContext(): Promise<void> {
    this.logger.warn('BROWSER_RESET_CONTEXT', 'Resetting browser context for self-healing');
    await this.close();
    await new Promise(r => setTimeout(r, 2000));
    await this.getContext();
  }

  public async close(): Promise<void> {
    this.isClosing = true;
    try {
      if (this.browserContext) {
        try {
          await this.browserContext.close();
        } catch (e: any) {
          this.logger.warn('BROWSER_CLOSE_ERROR', e.message);
        } finally {
          this.browserContext = null;
          this.chromiumPid = null;
          this.contextId = '';
        }
      }
      // Settle file locks on Windows file systems
      await new Promise(r => setTimeout(r, 800));
    } finally {
      this.isClosing = false;
    }
  }
}
