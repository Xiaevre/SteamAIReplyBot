import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AppDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { TaskScheduler } from '../../src/scheduler/taskScheduler';
import { CommentsRepository } from '../../src/db/repositories/comments';
import { ReplyTasksRepository } from '../../src/db/repositories/replyTasks';
import { RuntimeControl } from '../../src/config/runtimeControl';
import { BotConfig } from '../../src/config/schema';

export async function runRuntimeModeAndStateTests(): Promise<void> {
  console.log('--- Running Runtime Mode & Lifecycle State Unit Tests (Suite 24) ---');

  const testDbPath = path.resolve(__dirname, 'test-runtime-mode-state.db');
  const testRcPath = path.resolve(__dirname, 'test-runtime-control.json');

  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }
  if (fs.existsSync(testRcPath)) {
    try { fs.unlinkSync(testRcPath); } catch {}
  }

  RuntimeControl.setCustomPath(testRcPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  const baseConfig: BotConfig = {
    STEAM_PROFILE_URL: 'https://steamcommunity.com/id/test_bot/',
    BOT_ENABLED: true,
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

  // ============================================================
  // Test 1: 默认旧配置可以启动并平滑映射
  // ============================================================
  console.log('--- Test 1: Default legacy config startup & mode resolution ---');
  const legacyConfig: BotConfig = { ...baseConfig };
  delete (legacyConfig as any).BOT_MODE;
  legacyConfig.BOT_ENABLED = true;

  const scheduler1 = new TaskScheduler(legacyConfig, db);
  assert.strictEqual(scheduler1.effectiveBotMode, 'AI_ENHANCED', 'Legacy BOT_ENABLED=true should map to AI_ENHANCED');
  assert.strictEqual(scheduler1.lifecycleState, 'STOPPED', 'Initial state before start should be STOPPED');
  console.log('  -> Test 1 Passed: Legacy config safely starts with AI_ENHANCED mode.');

  // ============================================================
  // Test 2: LOCAL_ONLY 不调用 DeepSeek (0 次请求，安全本地兜底，且 unknown 不变成 timeGreeting)
  // ============================================================
  console.log('--- Test 2: LOCAL_ONLY strictly 0 DeepSeek calls with safe local fallback ---');
  let deepseekCallCount = 0;
  const schedulerLocal = new TaskScheduler({ ...baseConfig, BOT_MODE: 'LOCAL_ONLY', BOT_ENABLED: true }, db);
  schedulerLocal.deepseek = {
    generateReply: async () => {
      deepseekCallCount++;
      return { reply: 'AI response', category: 'general', language: 'zh', confidence: 0.9, learnablePhrases: [] };
    }
  } as any;

  // Unknown comment (normally routes to AI in AI_ENHANCED mode)
  const unknownComment = {
    commentId: 'cmt_unknown_local_1',
    commenterName: '小明',
    commenterSteamId: '76561198000000001',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000001',
    content: '今天这把排位打得太曲折了，队友全掉了'
  };

  const diagLocal = await schedulerLocal.processComment(unknownComment, 1, { persistAndDispatch: true });

  assert.strictEqual(deepseekCallCount, 0, 'DeepSeek must NOT be called in LOCAL_ONLY mode!');
  assert.strictEqual(diagLocal.action, 'REPLY_LOCAL', 'Action should be REPLY_LOCAL');
  assert.strictEqual(diagLocal.aiDecision, 'NOT_NEEDED', 'aiDecision should be NOT_NEEDED');
  assert.strictEqual(diagLocal.replySource, 'LOCAL_TEMPLATE', 'replySource should be LOCAL_TEMPLATE');
  const taskLocal = replyTasksRepo.findByCommentId('cmt_unknown_local_1');
  assert.ok(taskLocal && taskLocal.reply_text, 'Must have a safe fallback reply text in created task');
  // Constraint 1: unknown must not automatically become a timeGreeting (like "早上好/中午好/下午好/晚上好")
  assert.strictEqual(/早上好|中午好|下午好|晚上好/.test(taskLocal.reply_text), false, 'Unknown comment must NOT become timeGreeting');
  console.log(`  -> Test 2 Passed: 0 DeepSeek requests verified, safe fallback: "${taskLocal.reply_text}"`);

  // ============================================================
  // Test 3: AI_ENHANCED 模式下允许调用 DeepSeek
  // ============================================================
  console.log('--- Test 3: AI_ENHANCED invokes DeepSeek for unknown comments ---');
  let aiCallCount = 0;
  const schedulerAi = new TaskScheduler({ ...baseConfig, BOT_MODE: 'AI_ENHANCED', BOT_ENABLED: true }, db);
  schedulerAi.deepseek = {
    generateReply: async () => {
      aiCallCount++;
      return { reply: '确实太惨了，下次一定能赢！', category: 'general', language: 'zh', confidence: 0.95, learnablePhrases: [] };
    }
  } as any;

  const unknownComment3 = {
    ...unknownComment,
    commentId: 'cmt_unknown_ai_1'
  };
  const diagAi = await schedulerAi.processComment(unknownComment3, 1, { persistAndDispatch: true });
  assert.strictEqual(aiCallCount, 1, 'DeepSeek should be called once in AI_ENHANCED mode');
  assert.strictEqual(diagAi.action, 'REPLY_AI', 'Action should be REPLY_AI');
  assert.strictEqual(diagAi.replySource, 'DEEPSEEK', 'replySource should be DEEPSEEK');
  const taskAi = replyTasksRepo.findByCommentId('cmt_unknown_ai_1');
  assert.strictEqual(taskAi?.reply_text, '确实太惨了，下次一定能赢！');
  console.log('  -> Test 3 Passed: AI_ENHANCED correctly routed to DeepSeek.');

  // ============================================================
  // Test 4: DISABLED 模式不发送新回复
  // ============================================================
  console.log('--- Test 4: DISABLED mode skips new replies ---');
  const schedulerDisabled = new TaskScheduler({ ...baseConfig, BOT_MODE: 'DISABLED', BOT_ENABLED: false }, db);
  const diagDisabled = await schedulerDisabled.processComment({
    commentId: 'cmt_disabled_1',
    commenterName: 'Bob',
    commenterSteamId: '76561198000000002',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000002',
    content: '大佬求带！'
  }, 1, { persistAndDispatch: true });

  assert.strictEqual(diagDisabled.action, 'SKIP', 'Action in DISABLED mode must be SKIP');
  assert.strictEqual(diagDisabled.skipReason, 'BOT_DISABLED', 'skipReason must be BOT_DISABLED');

  const taskDisabled = replyTasksRepo.findByCommentId('cmt_disabled_1');
  assert.strictEqual(taskDisabled, undefined, 'No reply task should be dispatched in DISABLED mode');
  console.log('  -> Test 4 Passed: DISABLED mode cleanly skipped comment without creating tasks.');

  // ============================================================
  // Test 5: DISABLED 模式绝不删除已有任务和历史数据 (Constraint 2)
  // ============================================================
  console.log('--- Test 5: DISABLED mode preserves existing queue & history tasks ---');
  // Insert an existing pending task and an uncertain task
  const futureDate = new Date(Date.now() + 3600000).toISOString();
  replyTasksRepo.insert({
    task_id: 'task_existing_pending_1',
    steam_comment_id: 'cmt_existing_1',
    target_steam_id: '76561198000000003',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000003',
    reply_text: '感谢留言！',
    status: 'scheduled',
    scheduled_at: futureDate,
    attempt_count: 0,
    created_at: new Date().toISOString()
  });

  replyTasksRepo.insert({
    task_id: 'task_existing_uncertain_1',
    steam_comment_id: 'cmt_existing_2',
    target_steam_id: '76561198000000004',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000004',
    reply_text: '测试回复',
    status: 'uncertain_send_state',
    scheduled_at: futureDate,
    attempt_count: 1,
    created_at: new Date().toISOString()
  });

  // Switch mode to DISABLED
  schedulerDisabled.setBotMode('DISABLED');

  // Verify tasks still exist in DB completely intact
  const tPending = replyTasksRepo.findByTaskId('task_existing_pending_1');
  const tUncertain = replyTasksRepo.findByTaskId('task_existing_uncertain_1');
  assert.ok(tPending, 'Existing pending task must NOT be deleted');
  assert.ok(tUncertain, 'Existing uncertain task must NOT be deleted');
  assert.strictEqual(tPending?.status, 'scheduled', 'Pending task status must remain scheduled');
  assert.strictEqual(tUncertain?.status, 'uncertain_send_state', 'Uncertain status must remain unchanged');
  console.log('  -> Test 5 Passed: Existing reply tasks perfectly preserved in DISABLED mode.');

  // ============================================================
  // Test 6: 生命周期状态正确流转 (STARTING -> WAITING -> RUNNING -> WAITING -> STOPPING -> STOPPED)
  // ============================================================
  console.log('--- Test 6: Lifecycle State transitions ---');
  const schedulerLifecycle = new TaskScheduler({ ...baseConfig }, db);
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'STOPPED', 'Initial state must be STOPPED');

  schedulerLifecycle.setLifecycleState('STARTING');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'STARTING', 'State should be STARTING');

  schedulerLifecycle.setLifecycleState('WAITING');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'WAITING', 'State should be WAITING');

  schedulerLifecycle.setLifecycleState('RUNNING');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'RUNNING', 'State should be RUNNING');

  schedulerLifecycle.setLifecycleState('WAITING');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'WAITING', 'State should be WAITING');

  schedulerLifecycle.setLifecycleState('STOPPING');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'STOPPING', 'State should be STOPPING');

  schedulerLifecycle.setLifecycleState('STOPPED');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'STOPPED', 'State should be STOPPED');
  console.log('  -> Test 6 Passed: Lifecycle state transitions verified.');

  // ============================================================
  // Test 7: STOPPED 与 DISABLED 正交独立存在
  // ============================================================
  console.log('--- Test 7: STOPPED and DISABLED orthogonal coexistence ---');
  // State 1: DISABLED + WAITING (Daemon is running and monitoring, but bot replies are disabled)
  schedulerLifecycle.setBotMode('DISABLED');
  schedulerLifecycle.setLifecycleState('WAITING');
  assert.strictEqual(schedulerLifecycle.effectiveBotMode, 'DISABLED');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'WAITING');

  // State 2: AI_ENHANCED + STOPPED (Process/scheduler is stopped, but configured mode is AI_ENHANCED)
  schedulerLifecycle.setBotMode('AI_ENHANCED');
  schedulerLifecycle.setLifecycleState('STOPPED');
  assert.strictEqual(schedulerLifecycle.effectiveBotMode, 'AI_ENHANCED');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'STOPPED');

  // State 3: LOCAL_ONLY + RUNNING (Currently in cycle, local only)
  schedulerLifecycle.setBotMode('LOCAL_ONLY');
  schedulerLifecycle.setLifecycleState('RUNNING');
  assert.strictEqual(schedulerLifecycle.effectiveBotMode, 'LOCAL_ONLY');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'RUNNING');
  console.log('  -> Test 7 Passed: Distinct semantics between Mode and Lifecycle State confirmed.');

  // ============================================================
  // Test 8: ERROR 状态可记录
  // ============================================================
  console.log('--- Test 8: ERROR state and lastError recording ---');
  schedulerLifecycle.setLifecycleState('ERROR', 'FATAL_DATABASE_DISK_FULL');
  assert.strictEqual(schedulerLifecycle.lifecycleState, 'ERROR');
  assert.strictEqual(schedulerLifecycle.lastError, 'FATAL_DATABASE_DISK_FULL');

  const summary = schedulerLifecycle.getStatusSummary();
  assert.strictEqual(summary.lifecycleState, 'ERROR');
  assert.strictEqual(summary.lastError, 'FATAL_DATABASE_DISK_FULL');
  console.log('  -> Test 8 Passed: ERROR state and message successfully recorded.');

  // ============================================================
  // Test 9: 旧版 runtime-control.json 兼容性与互锁同步
  // ============================================================
  console.log('--- Test 9: Legacy runtime-control.json compatibility & bidirectional sync ---');
  // Write a purely legacy json without mode or lifecycleState
  const legacyRcContent = {
    botEnabled: true,
    emergencyStop: false,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(testRcPath, JSON.stringify(legacyRcContent, null, 2), 'utf8');

  const loadedRc = RuntimeControl.load();
  assert.strictEqual(loadedRc.mode, 'AI_ENHANCED', 'Legacy botEnabled: true should resolve to mode: AI_ENHANCED');
  assert.strictEqual(loadedRc.botEnabled, true, 'botEnabled should remain true');
  assert.strictEqual(loadedRc.emergencyStop, false);

  // Update mode to DISABLED -> botEnabled should automatically become false
  RuntimeControl.update({ mode: 'DISABLED' });
  const updatedRc1 = RuntimeControl.load();
  assert.strictEqual(updatedRc1.mode, 'DISABLED');
  assert.strictEqual(updatedRc1.botEnabled, false, 'botEnabled should sync to false when mode becomes DISABLED');

  // Update botEnabled to true -> mode should reconcile to AI_ENHANCED
  RuntimeControl.update({ botEnabled: true });
  const updatedRc2 = RuntimeControl.load();
  assert.strictEqual(updatedRc2.botEnabled, true);
  assert.strictEqual(updatedRc2.mode, 'AI_ENHANCED', 'mode should reconcile from DISABLED to AI_ENHANCED when botEnabled is set to true');

  // Update mode to LOCAL_ONLY -> botEnabled should remain true
  RuntimeControl.update({ mode: 'LOCAL_ONLY' });
  const updatedRc3 = RuntimeControl.load();
  assert.strictEqual(updatedRc3.mode, 'LOCAL_ONLY');
  assert.strictEqual(updatedRc3.botEnabled, true);
  console.log('  -> Test 9 Passed: Legacy runtime-control.json seamlessly migrated and synchronized.');

  // ============================================================
  // Test 10: getStatusSummary 全字段契约完整性
  // ============================================================
  console.log('--- Test 10: getStatusSummary schema contract ---');
  schedulerLifecycle.setBotMode('LOCAL_ONLY');
  schedulerLifecycle.setLifecycleState('WAITING');
  const finalSummary = schedulerLifecycle.getStatusSummary();

  assert.strictEqual(finalSummary.botMode, 'LOCAL_ONLY');
  assert.strictEqual(finalSummary.lifecycleState, 'WAITING');
  assert.strictEqual(typeof finalSummary.botEnabled, 'boolean');
  assert.strictEqual(typeof finalSummary.emergencyStop, 'boolean');
  assert.strictEqual(typeof finalSummary.uptimeSeconds, 'number');
  assert.strictEqual(typeof finalSummary.memoryMb, 'number');
  assert.ok(finalSummary.stats, 'Stats must be present');
  console.log('  -> Test 10 Passed: getStatusSummary contract fully compliant.');

  // Clean up
  db.close();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testRcPath); } catch {}

  console.log('\n====================================================');
  console.log('  All 10 Runtime Mode & State Tests PASSED!        ');
  console.log('====================================================\n');
}
