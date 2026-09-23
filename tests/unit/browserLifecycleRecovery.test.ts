import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SteamBrowserManager } from '../../src/steam/browser';
import { Logger } from '../../src/utils/logger';
import { WindowsServiceHelper } from '../../src/utils/service';
import { TaskScheduler } from '../../src/scheduler/taskScheduler';
import { AppDatabase } from '../../src/db/database';
import { BotConfig } from '../../src/config/schema';
import { ApiRouter } from '../../src/server/apiRouter';

export async function runBrowserLifecycleRecoveryTests(): Promise<void> {
  console.log('--- Running Browser Profile Recovery & Lifecycle Stability Tests (Suite 29) ---');

  const logger = new Logger();
  const testDir = path.resolve(__dirname, 'test-browser-recovery-profile');
  const tempDir = path.resolve(__dirname, 'test-browser-recovery-temp');

  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // ------------------------------------------------------------
    // Test 1: Normal startup profile checks
    // ------------------------------------------------------------
    console.log('--- Test 1: Normal startup profile checks ---');
    const browserManager = new SteamBrowserManager(logger, {
      profileDir: testDir,
      tempDir: tempDir
    });
    (browserManager as any).isEdgeProcessActive = () => false;

    const check1 = browserManager.checkAndCleanProfileLocks();
    assert.strictEqual(check1.staleLockDetected, false, 'No stale lock should be detected initially');
    assert.strictEqual(check1.lockCleanup, false, 'No lock cleanup needed');
    console.log('  -> Test 1 Passed: Clean profile directory validated.');

    // ------------------------------------------------------------
    // Test 2: Stale SingletonLock and lockfile recovery
    // ------------------------------------------------------------
    console.log('--- Test 2: Stale SingletonLock and lockfile recovery ---');
    fs.writeFileSync(path.join(testDir, 'SingletonLock'), 'lock1', 'utf8');
    fs.writeFileSync(path.join(testDir, 'SingletonCookie'), 'cookie_lock', 'utf8');
    fs.writeFileSync(path.join(testDir, 'lockfile'), 'edge_lock', 'utf8');
    // Ensure actual cookies and Local State are present and MUST be preserved
    const fakeCookiesDb = path.join(testDir, 'Cookies');
    fs.writeFileSync(fakeCookiesDb, 'REAL_COOKIE_DATA', 'utf8');
    const fakeLocalState = path.join(testDir, 'Local State');
    fs.writeFileSync(fakeLocalState, '{"os_crypt":{"encrypted_key":"..."}}', 'utf8');

    // Simulate inactive edge process
    (browserManager as any).isEdgeProcessActive = () => false;

    const check2 = browserManager.checkAndCleanProfileLocks();
    assert.strictEqual(check2.staleLockDetected, true, 'Stale locks must be detected');
    assert.strictEqual(check2.lockCleanup, true, 'Stale locks must be cleaned');

    assert.ok(!fs.existsSync(path.join(testDir, 'SingletonLock')), 'SingletonLock must be removed');
    assert.ok(!fs.existsSync(path.join(testDir, 'SingletonCookie')), 'SingletonCookie must be removed');
    assert.ok(!fs.existsSync(path.join(testDir, 'lockfile')), 'lockfile must be removed');

    // CRITICAL: Cookies and Local State MUST NOT be touched
    assert.ok(fs.existsSync(fakeCookiesDb), 'Cookies database must remain intact');
    assert.strictEqual(fs.readFileSync(fakeCookiesDb, 'utf8'), 'REAL_COOKIE_DATA', 'Cookie data must not be modified');
    assert.ok(fs.existsSync(fakeLocalState), 'Local State must remain intact');
    console.log('  -> Test 2 Passed: Stale locks safely purged without touching user session cookies.');

    // ------------------------------------------------------------
    // Test 3: Active process preservation
    // ------------------------------------------------------------
    console.log('--- Test 3: Active Edge process lock preservation ---');
    fs.writeFileSync(path.join(testDir, 'SingletonLock'), 'lock_active', 'utf8');
    (browserManager as any).isEdgeProcessActive = () => true;

    const check3 = browserManager.checkAndCleanProfileLocks();
    assert.strictEqual(check3.staleLockDetected, true, 'Lock detected');
    assert.strictEqual(check3.lockCleanup, false, 'Must NOT cleanup locks when process is active');
    assert.ok(fs.existsSync(path.join(testDir, 'SingletonLock')), 'Lock must be preserved when process is running');
    console.log('  -> Test 3 Passed: Active process locks strictly preserved.');

    // ------------------------------------------------------------
    // Test 4: Autostart default trigger & 30s settling delay
    // ------------------------------------------------------------
    console.log('--- Test 4: Autostart default trigger & delay assembly ---');
    const autoRes = WindowsServiceHelper.enableAutostart({
      taskName: 'SteamAIReplyBot_TestAutostart',
      dryRun: true
    });
    assert.strictEqual(autoRes.trigger, 'ONLOGON', 'Default trigger must be ONLOGON');
    assert.ok(autoRes.commandExecuted?.includes('/sc onlogon'), 'Command must contain /sc onlogon');
    assert.ok(autoRes.commandExecuted?.includes('/delay 0000:30'), 'Command must specify 30s boot settling delay');
    assert.ok(!autoRes.commandExecuted?.includes('/ru "SYSTEM"'), 'Must NOT run under SYSTEM account');
    console.log('  -> Test 4 Passed: Autostart command correctly assembled with ONLOGON and 30s delay.');

    // ------------------------------------------------------------
    // Test 5: Full Exit Mechanism (/api/bot/exit)
    // ------------------------------------------------------------
    console.log('--- Test 5: Full Exit Mechanism via /api/bot/exit ---');
    let shutdownInvoked = false;
    const mockDbPath = path.resolve(__dirname, 'test-exit.db');
    const db = new AppDatabase(mockDbPath);
    const mockConfig: BotConfig = {
      STEAM_PROFILE_URL: 'https://steamcommunity.com/id/test',
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      CHECK_INTERVAL_MIN_SECONDS: 60,
      CHECK_INTERVAL_MAX_SECONDS: 120,
      DRY_RUN: true,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 50,
      MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
      HOLIDAY_ACTIVE_DAYS: 30,
      HOLIDAY_SEND_START: '09:00',
      HOLIDAY_SEND_END: '22:00',
      DEFAULT_LANGUAGE: 'zh',
      TIMEZONE: 'Asia/Tokyo',
      MIN_REPLY_DELAY_SECONDS: 10,
      MAX_REPLY_DELAY_SECONDS: 20,
      AI_REQUEST_DELAY_MS: 500,
      MEMORY_WARNING_MB: 400,
      MEMORY_CRITICAL_MB: 600,
      BOT_ENABLED: true,
      EMERGENCY_STOP: false
    };

    const scheduler = new TaskScheduler(mockConfig, db, logger);
    const apiRouter = new ApiRouter({
      scheduler,
      db,
      config: mockConfig,
      logger,
      onShutdown: async () => {
        shutdownInvoked = true;
        await scheduler.stop();
      }
    });

    const exitRes = await apiRouter.handleRequest(new URL('http://127.0.0.1:3000/api/bot/exit'), 'POST');
    assert.strictEqual(exitRes.status, 200);
    assert.strictEqual(exitRes.data.success, true);

    // Wait for the asynchronous timeout trigger
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(shutdownInvoked, true, 'onShutdown hook must be invoked on exit call');
    console.log('  -> Test 5 Passed: Full graceful exit endpoint verified.');

    db.close();
    try { fs.unlinkSync(mockDbPath); } catch {}
  } finally {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('  All Browser Profile Recovery & Lifecycle Stability Tests PASSED!\n');
}
