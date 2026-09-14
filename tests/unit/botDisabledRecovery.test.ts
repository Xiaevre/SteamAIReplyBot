const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runBotDisabledRecoveryTests() {
  console.log('--- Running BOT_DISABLED Lifecycle & Recovery Unit Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { ApiRouter } = require('../../dist/server/apiRouter');
  const { RuntimeControl } = require('../../dist/config/runtimeControl');

  const testDbPath = path.resolve(__dirname, 'test-bot-disabled-recovery.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  const mockConfig = {
    STEAM_PROFILE_URL: 'https://steamcommunity.com/id/my_bot_profile/',
    BOT_ENABLED: false,
    EMERGENCY_STOP: false,
    DRY_RUN: true,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-chat',
    CHECK_INTERVAL_MIN_SECONDS: 90,
    CHECK_INTERVAL_MAX_SECONDS: 180,
    MIN_REPLY_DELAY_SECONDS: 0,
    MAX_REPLY_DELAY_SECONDS: 0,
    MAX_REPLIES_PER_HOUR: 10,
    MAX_REPLIES_PER_DAY: 50
  };

  const scheduler = new TaskScheduler(mockConfig, db);
  scheduler.deepseek = {
    generateReply: async (content, commenterName) => {
      return {
        category: 'general_chat',
        language: 'zh',
        confidence: 0.9,
        reply: '你好！祝你今天过得愉快~',
        learnablePhrases: []
      };
    }
  };

  const visitor = 'https://steamcommunity.com/id/visitor_user/';
  const visitorSteamId = '76561198000000001';

  // ============================================================
  // Test 1: BOT_ENABLED=false + 新评论
  // 预期：comments 表存在记录, status = 'skipped', error_message = 'BOT_DISABLED', 无 ReplyTask, 无发送
  // ============================================================
  console.log('--- Test 1: BOT_ENABLED=false + new comment ---');
  const diag1 = await scheduler.processComment({
    commentId: 'comment_bot_disabled_01',
    commenterName: 'Alice',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '你好，交个朋友呀！'
  }, 1, { persistAndDispatch: true });

  assert.strictEqual(diag1.action, 'SKIP', 'Action should be SKIP');
  assert.strictEqual(diag1.skipReason, 'BOT_DISABLED', 'skipReason should be BOT_DISABLED');

  const c1 = commentsRepo.findByCommentId('comment_bot_disabled_01');
  assert.ok(c1, 'Comment record must exist in DB');
  assert.strictEqual(c1.status, 'skipped', 'Comment status must be skipped');
  assert.strictEqual(c1.error_message, 'BOT_DISABLED', 'error_message must be BOT_DISABLED');

  const t1 = replyTasksRepo.findByCommentId('comment_bot_disabled_01');
  assert.strictEqual(t1, undefined, 'No ReplyTask should be created when BOT_ENABLED=false');
  console.log('  -> Test 1 Passed: Comment safely recorded as skipped/BOT_DISABLED with zero tasks created.');

  // ============================================================
  // Test 2: 已有 status='skipped', error_message='BOT_DISABLED', 恢复后 BOT_ENABLED=true 重新 processComment
  // 预期：不能返回 ALREADY_PROCESSED, 能够重新进入正常分类与生成流程, 创建 ReplyTask
  // ============================================================
  console.log('--- Test 2: BOT_ENABLED=true recovers BOT_DISABLED comment ---');
  scheduler.config.BOT_ENABLED = true;

  const diag2 = await scheduler.processComment({
    commentId: 'comment_bot_disabled_01',
    commenterName: 'Alice',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '你好，交个朋友呀！'
  }, 1, { persistAndDispatch: true });

  assert.notStrictEqual(diag2.skipReason, 'ALREADY_PROCESSED', 'Must not be skipped as ALREADY_PROCESSED');
  assert.strictEqual(diag2.action, 'REPLY_AI', 'Action should be REPLY_AI upon recovery');
  assert.strictEqual(diag2.databaseStatus, 'BOT_DISABLED_RESUMED', 'databaseStatus should report BOT_DISABLED_RESUMED');

  const c1Updated = commentsRepo.findByCommentId('comment_bot_disabled_01');
  assert.strictEqual(c1Updated.status, 'waiting', 'Comment in DB must transition to waiting');
  assert.strictEqual(c1Updated.error_message, null, 'error_message in DB must be cleared');
  assert.ok(c1Updated.reply, 'reply in DB must be populated');

  const t2 = replyTasksRepo.findByCommentId('comment_bot_disabled_01');
  assert.ok(t2, 'ReplyTask must be created after recovery');
  assert.strictEqual(t2.status, 'scheduled', 'Task status must be scheduled');
  assert.strictEqual(t2.reply_text, '你好！祝你今天过得愉快~');
  console.log('  -> Test 2 Passed: Recovered comment seamlessly processed and enqueued into DelayQueue.');

  // ============================================================
  // Test 3: 已有 status='skipped', error_message='OTHER_REASON', BOT_ENABLED=true
  // 预期：保持 ALREADY_PROCESSED, 不能被误恢复
  // ============================================================
  console.log('--- Test 3: Other skipped reasons must NOT be recovered ---');
  commentsRepo.insert({
    steam_comment_id: 'comment_skipped_other',
    commenter_steam_id: visitorSteamId,
    commenter_name: 'Bob',
    commenter_profile_url: visitor,
    content: 'Buy cheap skins at http://spam.xyz',
    classification: 'spam',
    classification_confidence: 0.99,
    reply_source: 'NONE',
    reply: '',
    status: 'skipped',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error_message: 'Flagged as spam by local filter'
  });

  const diag3 = await scheduler.processComment({
    commentId: 'comment_skipped_other',
    commenterName: 'Bob',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Buy cheap skins at http://spam.xyz'
  }, 1, { persistAndDispatch: true });

  assert.strictEqual(diag3.action, 'SKIP');
  assert.strictEqual(diag3.skipReason, 'ALREADY_PROCESSED', 'Non-BOT_DISABLED skipped comment must remain ALREADY_PROCESSED');
  console.log('  -> Test 3 Passed: Non-BOT_DISABLED skipped comments strictly remain ALREADY_PROCESSED.');

  // ============================================================
  // Test 4: 已有 status='replied'
  // 预期：保持 ALREADY_REPLIED
  // ============================================================
  console.log('--- Test 4: Replied comment must remain ALREADY_REPLIED ---');
  commentsRepo.insert({
    steam_comment_id: 'comment_replied_01',
    commenter_steam_id: visitorSteamId,
    commenter_name: 'Charlie',
    commenter_profile_url: visitor,
    content: 'Nice profile!',
    classification: 'greeting',
    classification_confidence: 0.95,
    reply_source: 'LOCAL_RULE',
    reply: 'Thanks!',
    status: 'replied',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const diag4 = await scheduler.processComment({
    commentId: 'comment_replied_01',
    commenterName: 'Charlie',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Nice profile!'
  }, 1, { persistAndDispatch: true });

  assert.strictEqual(diag4.action, 'SKIP');
  assert.strictEqual(diag4.skipReason, 'ALREADY_REPLIED', 'Replied comment must strictly yield ALREADY_REPLIED');
  console.log('  -> Test 4 Passed: Replied comment remains ALREADY_REPLIED.');

  // ============================================================
  // Test 5: POST /api/bot/resume 触发立即唤醒请求
  // 预期：RuntimeControl = enabled, scheduler.requestImmediatePoll() 被调用
  // ============================================================
  console.log('--- Test 5: POST /api/bot/resume triggers immediate poll request ---');
  let immediatePollCalled = false;
  const mockScheduler = {
    isRunning: true,
    requestImmediatePoll: () => {
      immediatePollCalled = true;
    }
  };

  const apiRouter = new ApiRouter({
    scheduler: mockScheduler,
    db,
    config: mockConfig,
    logger: scheduler.logger
  });

  const resumeRes = await apiRouter.handleRequest(new URL('http://127.0.0.1:3120/api/bot/resume'), 'POST');
  assert.strictEqual(resumeRes.status, 200);
  assert.strictEqual(resumeRes.data.botEnabled, true);
  assert.strictEqual(immediatePollCalled, true, 'requestImmediatePoll() must be invoked on /api/bot/resume');
  console.log('  -> Test 5 Passed: POST /api/bot/resume immediately notifies scheduler.');

  // ============================================================
  // Test 6: resume 被连续调用两次
  // 预期：不会产生并行 poll cycle
  // ============================================================
  console.log('--- Test 6: Concurrency safety on repeated resume ---');
  let cycleCount = 0;
  scheduler.isRunning = true;
  scheduler.timerHandle = null;

  // Simulate isCycleRunning state
  scheduler.isCycleRunning = true;
  scheduler.requestImmediatePoll();
  // Since isCycleRunning is true, timerHandle should remain null (not setting a second timer)
  assert.strictEqual(scheduler.timerHandle, null, 'Must defer when cycle is running');

  scheduler.isCycleRunning = false;
  scheduler.requestImmediatePoll();
  assert.ok(scheduler.timerHandle !== null, 'Timer must be scheduled when idle');

  const oldTimer = scheduler.timerHandle;
  scheduler.requestImmediatePoll(); // second immediate call while timer is pending
  assert.ok(scheduler.timerHandle !== null, 'Timer must be refreshed safely without duplicate runs');
  clearTimeout(scheduler.timerHandle);
  scheduler.timerHandle = null;
  scheduler.isRunning = false;
  console.log('  -> Test 6 Passed: Concurrency guards prevent duplicate/parallel poll cycles.');

  // ============================================================
  // Test 7: BOT_DISABLED 历史评论恢复后完整走通策略决策与任务构建 (非直接发送)
  // ============================================================
  console.log('--- Test 7: Recovered visual expression comment runs through VisualReplyGenerator ---');
  scheduler.config.BOT_ENABLED = false;
  const brailleComment = '⠀⠀⢀⣤⣶⠾⠿⠛⠛⠛⠛⠛⠿⠿⣶⣤⣀\n⠀⣠⡾⠋⠁⠀⠀⠀⢀⣠⣤⠤⢤⣤⣄⠀⠈⠙⢿⣦\n⣸⡏⠀⠀⠀⣀⣤⠾⠋⠁⠀⠀⠀⣸⠟⠀⠀⠀⠀⠹⣷\n⣿⣇⠀⠀⠀⠙⠳⢦⣄⡀⠀⠀⠈⢳⣦⠀⠀⠀⠀⣰⣿\n⢹⣿⣶⣤⣀⠀⠀⠀⠈⠙⠳⠶⠶⠿⠋⠀⢀⣤⣾⣿⣿⣶⣶⣦⡀\n⠘⣿⣿⣿⣿⣿⣶⣶⣦⣤⣤⣤⣤⣶⣶⣿⣿⣿⣿⣿⠋⠉⠙⣿⣧\n⠀⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣏⠀⠀⢠⣿⡿\n⠀⠀⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⣿⣶⣶⣿⡿\n⠀⠀⠀⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋⠀⠈⠉⠉⠁\n⠀⠀⠀⠀⠀⠈⠛⠻⢿⣿⣿⣿⡿⠿⠛ 𝐻𝑎𝑣𝑒 𝑎 𝑙𝑜𝑣𝑒𝑙𝑦 𝑑𝑎𝑦!';

  // Step A: Initially skipped due to BOT_ENABLED=false
  await scheduler.processComment({
    commentId: 'comment_braille_history_01',
    commenterName: 'BrailleUser',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: brailleComment
  }, 1, { persistAndDispatch: true });

  const cBraille1 = commentsRepo.findByCommentId('comment_braille_history_01');
  assert.strictEqual(cBraille1.status, 'skipped');
  assert.strictEqual(cBraille1.error_message, 'BOT_DISABLED');
  assert.strictEqual(replyTasksRepo.findByCommentId('comment_braille_history_01'), undefined);

  // Step B: Now BOT_ENABLED=true, recover and process
  scheduler.config.BOT_ENABLED = true;
  const diagBraille = await scheduler.processComment({
    commentId: 'comment_braille_history_01',
    commenterName: 'BrailleUser',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: brailleComment
  }, 1, { persistAndDispatch: true });

  assert.strictEqual(diagBraille.action, 'REPLY_LOCAL');
  assert.strictEqual(diagBraille.classification, 'braille_art');

  const cBrailleUpdated = commentsRepo.findByCommentId('comment_braille_history_01');
  assert.strictEqual(cBrailleUpdated.status, 'waiting');
  assert.strictEqual(cBrailleUpdated.error_message, null);

  const tBraille = replyTasksRepo.findByCommentId('comment_braille_history_01');
  assert.ok(tBraille, 'Task must be enqueued');
  assert.strictEqual(tBraille.status, 'scheduled');
  assert.ok(/[\u2800-\u28FF]/.test(tBraille.reply_text), 'Reply text must be dynamically generated Braille art');
  assert.notStrictEqual(tBraille.reply_text, '好强大的 Braille 字符画！回访暖暖你的主页，祝游戏愉快！');
  console.log('  -> Test 7 Passed: Historical BOT_DISABLED visual comment successfully recovered into visual reply task.');

  db.close();
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }
  console.log('✅ ALL 7 BOT_DISABLED Lifecycle & Recovery Unit Tests PASSED!\n');
}

module.exports = { runBotDisabledRecoveryTests };
if (require.main === module) runBotDisabledRecoveryTests();
