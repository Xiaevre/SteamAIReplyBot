const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runModerationTests() {
  console.log('--- Running Steam Moderation Pending Detection Tests ---');

  const { SteamModerationDetector } = require('../../dist/rules/moderationDetector');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');

  // ==========================================
  // Detector Unit Verification (Exact + Fuzzy)
  // ==========================================
  const zhOfficial = '此留言正在等待我们的自动内容检查系统分析。在我们证实其内容无害（例如并非试图窃取信息的钓鱼站点链接）之前，留言将暂时隐藏。';
  const enOfficial = 'This comment is awaiting analysis by our automated content check system. It is temporarily hidden until we\'ve verified that it does not contain harmful content (e.g. links to malicious phishing sites).';
  const zhSlightChange = '此留言正在等待自动内容检查系统分析，内容暂时隐藏。';
  const enSlightChange = 'This comment is awaiting analysis by content check system.';
  const normalComment = 'Hi! Nice Steam profile, let us play CS2 together.';

  const detZh = SteamModerationDetector.detect(zhOfficial);
  assert.strictEqual(detZh.isModerationPending, true, 'Official Chinese placeholder must be detected');
  assert.ok(detZh.confidence >= 0.95, 'Official Chinese placeholder confidence >= 0.95');

  const detEn = SteamModerationDetector.detect(enOfficial);
  assert.strictEqual(detEn.isModerationPending, true, 'Official English placeholder must be detected');
  assert.ok(detEn.confidence >= 0.95, 'Official English placeholder confidence >= 0.95');

  const detZhFuzzy = SteamModerationDetector.detect(zhSlightChange);
  assert.strictEqual(detZhFuzzy.isModerationPending, true, 'Fuzzy Chinese placeholder must be detected');
  assert.ok(detZhFuzzy.confidence >= 0.90, 'Fuzzy Chinese placeholder confidence >= 0.90');

  const detEnFuzzy = SteamModerationDetector.detect(enSlightChange);
  assert.strictEqual(detEnFuzzy.isModerationPending, true, 'Fuzzy English placeholder must be detected');

  const detNormal = SteamModerationDetector.detect(normalComment);
  assert.strictEqual(detNormal.isModerationPending, false, 'Normal text must not be detected as moderation');
  console.log('✓ SteamModerationDetector unit tests passed');

  // Setup DB for integration tests
  const testDbPath = path.resolve(__dirname, 'test-moderation.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  let aiCallCount = 0;
  const mockConfig = {
    STEAM_PROFILE_URL: 'https://steamcommunity.com/id/test_bot_profile/',
    BOT_ENABLED: true,
    EMERGENCY_STOP: false,
    DRY_RUN: false,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-chat',
    MIN_REPLY_DELAY_SECONDS: 0,
    MAX_REPLY_DELAY_SECONDS: 0,
    MAX_REPLIES_PER_HOUR: 10,
    MAX_REPLIES_PER_DAY: 50
  };

  const scheduler = new TaskScheduler(mockConfig, db);
  scheduler.deepseek = {
    generateReply: async () => {
      aiCallCount++;
      return {
        category: 'general_chat',
        language: 'en',
        confidence: 0.9,
        reply: 'AI generated response',
        learnablePhrases: []
      };
    }
  };

  const targetProfile = 'https://steamcommunity.com/id/user_b/';
  const targetSteamId = '76561198000000002';

  // ==========================================
  // Case A: 普通真实评论 (Normal real comment)
  // ==========================================
  console.log('--- Testing Case A: Normal real comment ---');
  const commentA = {
    commentId: 'comment_norm_01',
    commenterName: 'UserNormal',
    commenterSteamId: targetSteamId,
    commenterProfileUrl: targetProfile,
    content: 'Hello! Nice profile!'
  };

  const diagA = await scheduler.processComment(commentA, 1, { persistAndDispatch: true });
  assert.strictEqual(diagA.action, 'REPLY_LOCAL', 'Normal greeting should generate local reply');
  assert.strictEqual(diagA.skipReason, 'NONE');
  assert.strictEqual(diagA.databaseStatus, 'NEW');
  assert.strictEqual(aiCallCount, 0, 'No AI needed for standard greeting');

  const recordA = scheduler.commentsRepo.findByCommentId('comment_norm_01');
  assert.ok(recordA, 'Record A must be inserted into DB');
  assert.strictEqual(recordA.status, 'waiting');
  console.log('✓ Case A passed');

  // ==========================================
  // Case B: Moderation placeholder
  // ==========================================
  console.log('--- Testing Case B: Moderation placeholder initial scan ---');
  const commentB = {
    commentId: 'comment_mod_02',
    commenterName: 'UserMod',
    commenterSteamId: targetSteamId,
    commenterProfileUrl: targetProfile,
    content: zhOfficial
  };

  const initialAiCalls = aiCallCount;
  const diagB = await scheduler.processComment(commentB, 2, { persistAndDispatch: true });

  assert.strictEqual(diagB.action, 'STEAM_MODERATION_PENDING', 'Action must be STEAM_MODERATION_PENDING');
  assert.strictEqual(diagB.skipReason, 'STEAM_MODERATION_PENDING', 'SkipReason must be STEAM_MODERATION_PENDING');
  assert.strictEqual(diagB.classification, 'steam_moderation_pending');
  assert.strictEqual(diagB.databaseStatus, 'STEAM_MODERATION_PENDING');
  assert.strictEqual(aiCallCount, initialAiCalls, 'DeepSeek AI must NOT be called for moderation placeholder');

  // Check DB state
  const recordB = scheduler.commentsRepo.findByCommentId('comment_mod_02');
  assert.ok(recordB, 'Record B must exist in DB');
  assert.strictEqual(recordB.status, 'STEAM_MODERATION_PENDING', 'DB status must be STEAM_MODERATION_PENDING');
  assert.strictEqual(recordB.reply, '', 'No reply text should be saved');

  // Ensure next poll does NOT skip as ALREADY_PROCESSED, but reports STEAM_MODERATION_PENDING again
  const diagB2 = await scheduler.processComment(commentB, 2, { persistAndDispatch: true });
  assert.strictEqual(diagB2.action, 'STEAM_MODERATION_PENDING', 'Subsequent poll must remain STEAM_MODERATION_PENDING');
  assert.strictEqual(diagB2.skipReason, 'STEAM_MODERATION_PENDING', 'Subsequent poll must NOT be ALREADY_PROCESSED');
  assert.strictEqual(diagB2.databaseRecordExists, true);
  console.log('✓ Case B passed');

  // ==========================================
  // Case C: Placeholder -> 后续变成真实评论
  // ==========================================
  console.log('--- Testing Case C: Placeholder released into real comment ---');
  const commentCReleased = {
    commentId: 'comment_mod_02', // Same commentId!
    commenterName: 'UserMod',
    commenterSteamId: targetSteamId,
    commenterProfileUrl: targetProfile,
    content: '早上好！来踩踩你的个人主页～' // Now real warm_social comment!
  };

  const diagC = await scheduler.processComment(commentCReleased, 2, { persistAndDispatch: true });
  assert.strictEqual(diagC.action, 'REPLY_LOCAL', 'Released comment should be processed normally');
  assert.strictEqual(diagC.classification, 'warm_social');
  assert.strictEqual(diagC.databaseRecordExists, true);
  assert.strictEqual(diagC.databaseStatus, 'STEAM_MODERATION_RELEASED', 'Should indicate transition from moderation');

  const recordC = scheduler.commentsRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(recordC.content, commentCReleased.content, 'DB content must be updated with real comment');
  assert.strictEqual(recordC.status, 'waiting', 'DB status must be updated from STEAM_MODERATION_PENDING to waiting');
  assert.ok(recordC.reply.length > 0, 'Reply must be set for released comment');

  const taskC = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.ok(taskC, 'Reply task must be enqueued for released comment');
  assert.strictEqual(taskC.target_steam_id, targetSteamId);
  console.log('✓ Case C passed');

  // ==========================================
  // Case D: 自己发送后目标页面暂时显示 moderation placeholder
  // ==========================================
  console.log('--- Testing Case D: Post-send moderation placeholder verification ---');
  // 1. Mock sender returning MODERATION_PENDING
  let mockTargetCheckResult = 'MODERATION_PENDING';
  scheduler.commentSender = {
    sendReply: async (target, reply) => {
      return {
        status: 'MODERATION_PENDING',
        message: 'Comment submitted but target profile displays moderation pending placeholder'
      };
    },
    checkTargetProfileForExistingComment: async () => {
      return mockTargetCheckResult;
    }
  };

  // Ensure task is ready for dispatch
  scheduler.isRunning = true;
  scheduler.sessionState = 'authenticated';
  db.prepare("UPDATE reply_tasks SET scheduled_at = ? WHERE steam_comment_id = 'comment_mod_02'").run(new Date(Date.now() - 1000).toISOString());

  // Dispatch task C (currently waiting)
  await scheduler.dispatchPendingRepliesStep();

  const taskDAfterSend = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(taskDAfterSend.status, 'submitted_moderation_pending', 'Status should be submitted_moderation_pending');
  const commentDAfterSend = scheduler.commentsRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(commentDAfterSend.status, 'submitted_moderation_pending', 'Comment status should be submitted_moderation_pending');

  // 2. Recovery check while still pending
  await scheduler.runModerationPendingRecoveryStep();
  const taskStillPending = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(taskStillPending.status, 'submitted_moderation_pending', 'Should remain submitted_moderation_pending while check is MODERATION_PENDING');

  // 3. Recovery check when Steam releases bot's comment -> FOUND
  mockTargetCheckResult = 'FOUND';
  await scheduler.runModerationPendingRecoveryStep();
  const taskReleasedAndVerified = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(taskReleasedAndVerified.status, 'replied', 'Should become replied once FOUND on target profile');
  const commentVerified = scheduler.commentsRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(commentVerified.status, 'replied', 'Comment status should become replied');

  // 4. Test safe idempotency when check is NOT_FOUND: must strictly remain submitted_moderation_pending (NO RESEND)
  scheduler.replyTasksRepo.updateStatus(taskReleasedAndVerified.task_id, 'submitted_moderation_pending', { attempt_count: 0 });
  mockTargetCheckResult = 'NOT_FOUND';
  await scheduler.runModerationPendingRecoveryStep();
  const taskAfterNotFound = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(taskAfterNotFound.status, 'submitted_moderation_pending', 'Must remain submitted_moderation_pending and NEVER resend when NOT_FOUND');

  // 5. Test check is UNCERTAIN: retains moderation pending state
  scheduler.replyTasksRepo.updateStatus(taskAfterNotFound.task_id, 'submitted_moderation_pending');
  mockTargetCheckResult = 'UNCERTAIN';
  await scheduler.runModerationPendingRecoveryStep();
  const taskAfterUncertain = scheduler.replyTasksRepo.findByCommentId('comment_mod_02');
  assert.strictEqual(taskAfterUncertain.status, 'submitted_moderation_pending', 'Should remain submitted_moderation_pending if check is UNCERTAIN');
  console.log('✓ Case D passed');

  // ==========================================
  // Case E: Moderation placeholder 长时间不释放
  // ==========================================
  console.log('--- Testing Case E: Moderation placeholder prolonged pending ---');
  const commentE = {
    commentId: 'comment_prolonged_03',
    commenterName: 'UserProlonged',
    commenterSteamId: targetSteamId,
    commenterProfileUrl: targetProfile,
    content: enOfficial
  };

  // Poll 1
  const diagE1 = await scheduler.processComment(commentE, 3, { persistAndDispatch: true });
  assert.strictEqual(diagE1.action, 'STEAM_MODERATION_PENDING');

  // Poll 2
  const diagE2 = await scheduler.processComment(commentE, 3, { persistAndDispatch: true });
  assert.strictEqual(diagE2.action, 'STEAM_MODERATION_PENDING');
  assert.strictEqual(diagE2.skipReason, 'STEAM_MODERATION_PENDING');

  // Poll 3
  const diagE3 = await scheduler.processComment(commentE, 3, { persistAndDispatch: true });
  assert.strictEqual(diagE3.action, 'STEAM_MODERATION_PENDING');
  assert.strictEqual(diagE3.skipReason, 'STEAM_MODERATION_PENDING');

  // Poll 4
  const diagE4 = await scheduler.processComment(commentE, 3, { persistAndDispatch: true });
  assert.strictEqual(diagE4.action, 'STEAM_MODERATION_PENDING');
  assert.strictEqual(diagE4.skipReason, 'STEAM_MODERATION_PENDING');

  const recordE = scheduler.commentsRepo.findByCommentId('comment_prolonged_03');
  assert.strictEqual(recordE.status, 'STEAM_MODERATION_PENDING');
  assert.strictEqual(recordE.reply, '');
  assert.strictEqual(scheduler.replyTasksRepo.findByCommentId('comment_prolonged_03'), undefined, 'Zero reply tasks created for prolonged moderation');
  console.log('✓ Case E passed');

  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  console.log('All Steam Moderation Pending Tests (Case A, B, C, D, E) PASSED!\n');
}

module.exports = { runModerationTests };

if (require.main === module) {
  runModerationTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
