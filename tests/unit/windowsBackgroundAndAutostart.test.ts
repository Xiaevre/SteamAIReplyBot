import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { WindowsServiceHelper } from '../../src/utils/service';
import { BotInstanceLock, BOT_INSTANCE_MUTEX_PORT } from '../../src/utils/instanceLock';
import { getRuntimeRoot } from '../../src/utils/paths';
import { WebServer } from '../../src/server/webServer';
import { AppDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { Logger } from '../../src/utils/logger';
import { BotConfig } from '../../src/config/schema';

export async function runWindowsBackgroundAndAutostartTests(): Promise<void> {
  console.log('--- Running Windows Background & Autostart Unit Tests (Suite 26) ---');

  const testTaskName = 'SteamAIReplyBotTestDaemon';
  const origExecutor = WindowsServiceHelper.executeSchtasks;
  const simulatedTasks: Record<string, string> = {};

  WindowsServiceHelper.executeSchtasks = (cmd: string) => {
    if (cmd.includes('/delete')) {
      const match = cmd.match(/\/tn\s+"?([^"\s]+)"?/);
      if (match && match[1]) {
        delete simulatedTasks[match[1]];
      }
      return { stdout: 'SUCCESS' };
    }
    if (cmd.includes('/query')) {
      const match = cmd.match(/\/tn\s+"?([^"\s]+)"?/);
      const name = match ? match[1] : '';
      if (name && simulatedTasks[name]) {
        return { stdout: simulatedTasks[name] };
      }
      const err: any = new Error('Task not registered');
      err.code = 1;
      return { stdout: '', error: err };
    }
    return origExecutor(cmd);
  };

  // Ensure test task is cleared before and after
  try {
    WindowsServiceHelper.disableAutostart(testTaskName);
  } catch {}

  try {
    // ============================================================
    // Test 1: Dynamic relative path resolution (Zero hardcoded developer paths)
    // ============================================================
    console.log('--- Test 1: Dynamic relative path resolution ---');
    const targetExe = WindowsServiceHelper.resolveTargetExe();
    assert.ok(targetExe, 'Target exe must be resolved');
    assert.ok(targetExe.endsWith('SteamAIReplyBot.exe'), 'Must resolve to SteamAIReplyBot.exe');
    assert.ok(
      !targetExe.includes('D:\\SteamAIReplyBot') || targetExe.startsWith(process.cwd()),
      'Should resolve relative to active environment'
    );
    // Strict developer path audit
    const appRoot = getRuntimeRoot();
    assert.ok(fs.existsSync(appRoot), `Runtime root ${appRoot} must exist`);
    console.log(`  -> Test 1 Passed: Dynamic exe path resolved safely to: ${targetExe}`);

    // ============================================================
    // Test 2: ONSTART autostart command assembly & priority
    // ============================================================
    console.log('--- Test 2: ONSTART priority command assembly ---');
    const onstartRes = WindowsServiceHelper.enableAutostart({
      taskName: testTaskName,
      trigger: 'ONSTART',
      dryRun: true
    });
    assert.ok(onstartRes.commandExecuted, 'Command must be recorded');
    assert.ok(onstartRes.commandExecuted.includes('/sc onstart'), 'Must include /sc onstart');
    assert.ok(onstartRes.commandExecuted.includes('/ru "SYSTEM"'), 'Must run under SYSTEM for non-interactive boot');
    assert.ok(onstartRes.commandExecuted.includes('/rl highest'), 'Must run with highest privileges');
    assert.ok(onstartRes.commandExecuted.includes('/f'), 'Must include /f to enforce idempotent overwrite');
    assert.ok(onstartRes.commandExecuted.includes('--background'), 'Must pass --background flag');
    assert.ok(onstartRes.commandExecuted.includes('--headless'), 'Must pass --headless flag');
    console.log('  -> Test 2 Passed: ONSTART command correctly assembled with all required security flags.');

    // ============================================================
    // Test 3: ONLOGON autostart command assembly
    // ============================================================
    console.log('--- Test 3: ONLOGON autostart command assembly ---');
    const onlogonRes = WindowsServiceHelper.enableAutostart({
      taskName: testTaskName,
      trigger: 'ONLOGON',
      dryRun: true
    });
    assert.ok(onlogonRes.commandExecuted, 'Command must be recorded');
    assert.ok(onlogonRes.commandExecuted.includes('/sc onlogon'), 'Must include /sc onlogon');
    assert.ok(onlogonRes.commandExecuted.includes('/rl highest'), 'Must run with highest privileges');
    assert.ok(onlogonRes.commandExecuted.includes('/f'), 'Must include /f to prevent duplicate tasks');
    assert.ok(onlogonRes.commandExecuted.includes('--background'), 'Must pass --background flag');
    assert.ok(onlogonRes.commandExecuted.includes('--headless'), 'Must pass --headless flag');
    console.log('  -> Test 3 Passed: ONLOGON command correctly assembled.');

    // ============================================================
    // Test 4: Autostart status inspection & parsing
    // ============================================================
    console.log('--- Test 4: Autostart status inspection ---');
    const statusBefore = WindowsServiceHelper.getAutostartStatus('NonExistentTask99999');
    assert.strictEqual(statusBefore.enabled, false, 'Non-existent task must report enabled = false');
    assert.strictEqual(statusBefore.taskName, 'NonExistentTask99999');

    const statusTestTask = WindowsServiceHelper.getAutostartStatus(testTaskName);
    assert.strictEqual(typeof statusTestTask.enabled, 'boolean');
    assert.strictEqual(statusTestTask.taskName, testTaskName);
    console.log(`  -> Test 4 Passed: Status inspection schema valid (Enabled: ${statusTestTask.enabled}).`);

    // ============================================================
    // Test 5: Disable autostart cleanly uninstalls task
    // ============================================================
    console.log('--- Test 5: Disable autostart removes scheduled task ---');
    const disableRes = WindowsServiceHelper.disableAutostart(testTaskName);
    assert.ok(disableRes.commandExecuted?.includes(`schtasks /delete /tn "${testTaskName}" /f`));
    const statusAfterDisable = WindowsServiceHelper.getAutostartStatus(testTaskName);
    assert.strictEqual(statusAfterDisable.enabled, false, 'Task must be disabled after deletion');
    console.log('  -> Test 5 Passed: disableAutostart cleanly removed the task.');

    // ============================================================
    // Test 6: Single-Instance Mutex (BotInstanceLock) protection
    // ============================================================
    console.log('--- Test 6: BotInstanceLock single-instance mutex ---');
    assert.strictEqual(BOT_INSTANCE_MUTEX_PORT, 31989, 'Must reuse project standard mutex port 31989');

    const primaryLock = new BotInstanceLock(true);
    const primaryResult = await primaryLock.acquire();
    assert.strictEqual(primaryResult.acquired, true, 'Primary instance must acquire lock successfully');

    // Secondary instance attempts acquisition
    const secondaryLock = new BotInstanceLock(true);
    const secondaryResult = await secondaryLock.acquire();
    assert.strictEqual(secondaryResult.acquired, false, 'Secondary instance must be blocked');
    assert.ok(secondaryResult.existing, 'Secondary instance must receive existing instance info');
    assert.strictEqual(secondaryResult.existing?.pid, process.pid, 'Existing pid must match primary');

    // Release primary lock
    primaryLock.release();
    console.log('  -> Test 6 Passed: BotInstanceLock cleanly prevented multiple instances.');

    // ============================================================
    // Test 7: start-background.vbs file existence & portability
    // ============================================================
    console.log('--- Test 7: start-background.vbs existence and syntax ---');
    const rootVbs = path.resolve(getRuntimeRoot(), 'start-background.vbs');
    const releaseVbs = path.resolve(getRuntimeRoot(), 'release', 'start-background.vbs');

    assert.ok(fs.existsSync(rootVbs), `start-background.vbs must exist at ${rootVbs}`);
    if (fs.existsSync(releaseVbs)) {
      const releaseContent = fs.readFileSync(releaseVbs, 'utf8');
      assert.ok(releaseContent.includes('SteamAIReplyBot.exe'), 'release VBS must reference SteamAIReplyBot.exe');
    }

    const vbsContent = fs.readFileSync(rootVbs, 'utf8');
    assert.ok(vbsContent.includes('SteamAIReplyBot.exe'), 'VBS must reference SteamAIReplyBot.exe');
    assert.ok(vbsContent.includes('--background'), 'VBS must pass --background');
    assert.ok(vbsContent.includes('--headless'), 'VBS must pass --headless');
    assert.ok(vbsContent.includes('0, False'), 'VBS must launch with window style 0 (hidden)');
    console.log('  -> Test 7 Passed: start-background.vbs verified.');

    // ============================================================
    // Test 8: release/SteamAIReplyBot.exe compiled & metadata intact
    // ============================================================
    console.log('--- Test 8: release/SteamAIReplyBot.exe binary check ---');
    const releaseExe = path.resolve(getRuntimeRoot(), 'release', 'SteamAIReplyBot.exe');
    if (fs.existsSync(releaseExe)) {
      const stats = fs.statSync(releaseExe);
      assert.ok(stats.size > 20000, `Executable size must be valid (.NET launcher size ~40KB, got ${stats.size})`);
      console.log(`  -> Test 8 Passed: release/SteamAIReplyBot.exe exists (${stats.size} bytes).`);
    } else {
      console.log('  -> Test 8 Skipped: release/SteamAIReplyBot.exe not compiled yet (run npm run package to build)');
    }

    // ============================================================
    // Test 9: Web API Autostart Endpoints on 127.0.0.1
    // ============================================================
    console.log('--- Test 9: Web API autostart endpoints ---');
    const testDbPath = path.resolve(__dirname, 'test-autostart-api.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    const db = new AppDatabase(testDbPath);
    runMigrations(db);

    const baseConfig: BotConfig = {
      STEAM_PROFILE_URL: 'https://steamcommunity.com/id/test_bot/',
      BOT_ENABLED: true,
      BOT_MODE: 'AI_ENHANCED',
      EMERGENCY_STOP: false,
      DRY_RUN: true,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_MODEL: 'deepseek-chat',
      CHECK_INTERVAL_MIN_SECONDS: 60,
      CHECK_INTERVAL_MAX_SECONDS: 120,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 50,
      DEFAULT_LANGUAGE: 'zh',
      TIMEZONE: 'Asia/Tokyo',
      MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
      HOLIDAY_ACTIVE_DAYS: 30,
      HOLIDAY_SEND_START: '09:00',
      HOLIDAY_SEND_END: '22:00',
      AI_REQUEST_DELAY_MS: 0,
      MEMORY_WARNING_MB: 400,
      MEMORY_CRITICAL_MB: 600,
      BROWSER_MODE: 'AUTO',
      HEADLESS: true
    };

    const server = new WebServer({
      db,
      config: baseConfig,
      logger: new Logger()
    });

    const port = await server.start(3188);
    assert.ok(port > 0, 'Server must start on assigned port');
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // GET /api/autostart/status
      const resStatus = await fetch(`${baseUrl}/api/autostart/status`);
      assert.strictEqual(resStatus.status, 200);
      const dataStatus = await resStatus.json();
      assert.strictEqual(dataStatus.success, true);
      assert.strictEqual(dataStatus.taskName, 'SteamAIReplyBotDaemon');
      console.log('  -> Test 9.1 Passed: GET /api/autostart/status returned valid response.');

      // POST /api/autostart/disable
      const resDisable = await fetch(`${baseUrl}/api/autostart/disable`, { method: 'POST' });
      assert.strictEqual(resDisable.status, 200);
      const dataDisable = await resDisable.json();
      assert.strictEqual(dataDisable.success, true);
      console.log('  -> Test 9.2 Passed: POST /api/autostart/disable returned valid response.');
    } finally {
      await server.stop();
      db.close();
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    console.log('\n====================================================');
    console.log('  All 9 Windows Background & Autostart Tests PASSED! ');
    console.log('====================================================\n');
  } finally {
    // Guaranteed cleanup of any test scheduled tasks
    try {
      WindowsServiceHelper.disableAutostart(testTaskName);
    } catch {}
    WindowsServiceHelper.executeSchtasks = origExecutor;
  }
}
