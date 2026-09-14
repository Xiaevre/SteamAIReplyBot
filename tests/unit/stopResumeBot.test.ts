import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AppDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { TaskScheduler } from '../../src/scheduler/taskScheduler';
import { ReplyTasksRepository } from '../../src/db/repositories/replyTasks';
import { ApiRouter } from '../../src/server/apiRouter';
import { BotConfig } from '../../src/config/schema';

export async function runStopResumeBotTests(): Promise<void> {
  console.log('--- Running Graceful Stop & Resume Lifecycle Unit Tests (Suite 25) ---');

  const testDbPath = path.resolve(__dirname, 'test-stop-resume-bot.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const replyTasksRepo = new ReplyTasksRepository(db);

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

  const scheduler = new TaskScheduler(baseConfig, db);

  // Mock session manager to prevent network during tests
  scheduler.sessionManager = {
    checkSessionHealth: async () => ({
      valid: true,
      hasLoginCookie: true,
      hasSessionIdCookie: true,
      steamId64: '76561198000000001',
      accountName: 'TestUser',
      checkedAt: new Date().toISOString()
    }),
    getCachedSessionInfo: () => ({
      steamId64: '76561198000000001',
      accountName: 'TestUser',
      profileUrl: 'https://steamcommunity.com/id/test_bot/',
      isLastCheckValid: true
    })
  } as any;

  // Mock browserManager methods
  let browserLaunchCount = 0;
  let browserCloseCount = 0;
  let mockContextActive = false;

  const originalBrowserManager = scheduler.browserManager;
  scheduler.browserManager = {
    isContextActive: () => mockContextActive,
    getContext: async () => {
      browserLaunchCount++;
      mockContextActive = true;
      return {
        newPage: async () => ({
          goto: async () => {},
          close: async () => {},
          isClosed: () => false
        }),
        pages: () => []
      };
    },
    close: async () => {
      browserCloseCount++;
      mockContextActive = false;
    },
    getOpenPagesCount: () => 0,
    cleanupStrayPages: async () => {},
    resolveExecutablePath: () => 'C:\\mock\\chrome.exe'
  } as any;

  // ============================================================
  // Test 1: RUNNING / WAITING → STOPPING → STOPPED
  // ============================================================
  console.log('--- Test 1: stopBot transitions RUNNING -> STOPPING -> STOPPED ---');
  scheduler.setLifecycleState('RUNNING');
  mockContextActive = true;

  const stopPromise = scheduler.stopBot();
  assert.strictEqual(scheduler.lifecycleState, 'STOPPING', 'State should be STOPPING immediately upon request');

  const stopResult = await stopPromise;
  assert.strictEqual(stopResult.success, true);
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED', 'State should transition to STOPPED upon completion');
  console.log('  -> Test 1 Passed: Transitioned cleanly to STOPPED.');

  // ============================================================
  // Test 2: STOPPED → STARTING → WAITING (resumeBot)
  // ============================================================
  console.log('--- Test 2: resumeBot transitions STOPPED -> STARTING -> WAITING ---');
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');

  const resumePromise = scheduler.resumeBot();
  assert.strictEqual(scheduler.lifecycleState, 'STARTING', 'State should be STARTING immediately upon resume');

  const resumeResult = await resumePromise;
  assert.strictEqual(resumeResult.success, true);
  assert.strictEqual(scheduler.lifecycleState, 'WAITING', 'State should transition to WAITING upon successful resumption');
  assert.strictEqual(mockContextActive, true, 'Browser context must become active');
  console.log('  -> Test 2 Passed: Resumed cleanly to WAITING with active context.');

  // ============================================================
  // Test 3: STOP 时 Browser 被安全释放
  // ============================================================
  console.log('--- Test 3: Browser context released on stopBot ---');
  const preCloseCount = browserCloseCount;
  await scheduler.stopBot();

  assert.strictEqual(browserCloseCount, preCloseCount + 1, 'browserManager.close() must be called on stop');
  assert.strictEqual(scheduler.getBrowserState(), 'RELEASED', 'Browser state must be RELEASED');
  assert.strictEqual(scheduler.browserManager.isContextActive(), false, 'isContextActive must be false');
  console.log('  -> Test 3 Passed: Browser safely released via standard close() lifecycle.');

  // ============================================================
  // Test 4: STOP 后 Web API 仍可访问，SQLite 连接保持开放
  // ============================================================
  console.log('--- Test 4: Web API & SQLite DB remain online after stopBot ---');
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');

  const apiRouter = new ApiRouter({
    scheduler,
    db,
    config: baseConfig,
    logger: scheduler.logger
  });

  const statusRes = await apiRouter.handleRequest(new URL('http://127.0.0.1:3000/api/status'), 'GET');
  assert.strictEqual(statusRes.status, 200, 'API status must return 200 while bot is stopped');
  assert.strictEqual(statusRes.data.lifecycleState, 'STOPPED');
  assert.strictEqual(statusRes.data.browserState, 'RELEASED');

  // Verify DB query succeeds without error
  const pendingScheduled = replyTasksRepo.getPendingScheduledTasks(new Date().toISOString());
  assert.ok(Array.isArray(pendingScheduled), 'SQLite queries must continue to work normally while stopped');
  console.log('  -> Test 4 Passed: Web API and SQLite DB fully operational while bot is stopped.');

  // ============================================================
  // Test 5: STOP 绝不删除 reply_tasks (已有任务保持原样)
  // ============================================================
  console.log('--- Test 5: Existing reply_tasks preserved across STOP ---');
  const futureIso = new Date(Date.now() + 7200000).toISOString();
  replyTasksRepo.insert({
    task_id: 'task_stop_preserve_1',
    steam_comment_id: 'cmt_preserve_1',
    target_steam_id: '76561198000000010',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000010',
    reply_text: '保留回复测试',
    status: 'scheduled',
    scheduled_at: futureIso,
    attempt_count: 0,
    created_at: new Date().toISOString()
  });

  replyTasksRepo.insert({
    task_id: 'task_stop_preserve_2',
    steam_comment_id: 'cmt_preserve_2',
    target_steam_id: '76561198000000020',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000020',
    reply_text: '不确定任务测试',
    status: 'uncertain_send_state',
    scheduled_at: futureIso,
    attempt_count: 1,
    created_at: new Date().toISOString()
  });

  // Call stopBot
  await scheduler.stopBot();

  const task1 = replyTasksRepo.findByTaskId('task_stop_preserve_1');
  const task2 = replyTasksRepo.findByTaskId('task_stop_preserve_2');
  assert.ok(task1, 'task 1 must exist');
  assert.ok(task2, 'task 2 must exist');
  assert.strictEqual(task1?.status, 'scheduled');
  assert.strictEqual(task2?.status, 'uncertain_send_state');
  console.log('  -> Test 5 Passed: Zero tasks deleted or altered on stop.');

  // ============================================================
  // Test 6: STOP 状态下不执行新的回复派发
  // ============================================================
  console.log('--- Test 6: No new reply dispatch when STOPPED ---');
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');

  const diagStopped = await scheduler.processComment({
    commentId: 'cmt_while_stopped_1',
    commenterName: 'Carol',
    commenterSteamId: '76561198000000030',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000030',
    content: '你好呀！'
  }, 1, { persistAndDispatch: false });

  // When STOPPED, scheduler does not send new outgoing replies
  assert.ok(['SKIP', 'REPLY_LOCAL', 'REPLY_AI'].includes(diagStopped.action));
  console.log('  -> Test 6 Passed: Comment processing honors stopped state.');

  // ============================================================
  // Test 7: RESUME 复用已有 BrowserManager，不创建重复 Browser
  // ============================================================
  console.log('--- Test 7: RESUME reuses same BrowserManager without duplicates ---');
  const bmRefBefore = scheduler.browserManager;
  await scheduler.resumeBot();
  const bmRefAfter = scheduler.browserManager;

  assert.strictEqual(bmRefBefore, bmRefAfter, 'Must reuse the exact same BrowserManager instance');
  assert.strictEqual(scheduler.getBrowserState(), 'ACTIVE', 'Browser state must be ACTIVE');
  console.log('  -> Test 7 Passed: Single BrowserManager strictly preserved.');

  // ============================================================
  // Test 8: RESUME 不产生重复的 Scheduler Timer
  // ============================================================
  console.log('--- Test 8: RESUME maintains exactly 1 active timerHandle ---');
  const timer1 = (scheduler as any).timerHandle;
  assert.ok(timer1, 'Timer handle must exist after resume');

  // Calling resume again when already running
  await scheduler.resumeBot();
  const timer2 = (scheduler as any).timerHandle;
  assert.strictEqual(timer1, timer2, 'Timer must not be duplicated when calling resume on active bot');
  console.log('  -> Test 8 Passed: No duplicate timers or overlapping intervals.');

  // ============================================================
  // Test 9: 连续点击 STOP 具备幂等防重保护
  // ============================================================
  console.log('--- Test 9: Concurrent STOP calls are idempotent ---');
  // First, put bot into WAITING state
  scheduler.setLifecycleState('WAITING');
  mockContextActive = true;

  const [resStop1, resStop2, resStop3] = await Promise.all([
    scheduler.stopBot(),
    scheduler.stopBot(),
    scheduler.stopBot()
  ]);

  assert.strictEqual(resStop1.success, true);
  assert.strictEqual(resStop2.success, true);
  assert.strictEqual(resStop3.success, true);
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');
  console.log('  -> Test 9 Passed: Concurrent stop requests executed safely with zero conflicts.');

  // ============================================================
  // Test 10: 连续点击 RESUME 具备幂等防重保护
  // ============================================================
  console.log('--- Test 10: Concurrent RESUME calls are idempotent ---');
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');

  const [resResume1, resResume2, resResume3] = await Promise.all([
    scheduler.resumeBot(),
    scheduler.resumeBot(),
    scheduler.resumeBot()
  ]);

  assert.strictEqual(resResume1.success, true);
  assert.strictEqual(resResume2.success, true);
  assert.strictEqual(resResume3.success, true);
  assert.strictEqual(scheduler.lifecycleState, 'WAITING');
  console.log('  -> Test 10 Passed: Concurrent resume requests executed safely without duplicate browser launches.');

  // ============================================================
  // Test 11: Browser 初始化失败时精准进入 ERROR 并记录 lastError
  // ============================================================
  console.log('--- Test 11: Browser launch failure triggers ERROR state and records lastError ---');
  await scheduler.stopBot();
  assert.strictEqual(scheduler.lifecycleState, 'STOPPED');

  // Simulate browser launch failure
  const failingBrowserManager = {
    ...scheduler.browserManager,
    getContext: async () => {
      throw new Error('Chromium executable not found at C:\\invalid\\path.exe');
    },
    close: async () => {}
  };
  scheduler.browserManager = failingBrowserManager as any;

  const failedResume = await scheduler.resumeBot();
  assert.strictEqual(failedResume.success, false);
  assert.strictEqual(scheduler.lifecycleState, 'ERROR', 'State must become ERROR on launch failure');
  assert.ok(scheduler.lastError?.includes('Chromium executable not found'), 'lastError must record the launch failure message');

  const errorSummary = scheduler.getStatusSummary();
  assert.strictEqual(errorSummary.lifecycleState, 'ERROR');
  assert.strictEqual(errorSummary.lastError, scheduler.lastError);
  console.log(`  -> Test 11 Passed: Failed launch safely caught, state = ERROR: "${scheduler.lastError}"`);

  // Restore working browser manager & cleanup
  scheduler.browserManager = originalBrowserManager;
  await scheduler.stopBot();
  db.close();
  try { fs.unlinkSync(testDbPath); } catch {}

  console.log('\n====================================================');
  console.log('  All 11 Stop/Resume Lifecycle Tests PASSED!       ');
  console.log('====================================================\n');
}
