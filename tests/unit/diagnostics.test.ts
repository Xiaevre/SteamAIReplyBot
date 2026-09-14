const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runDiagnosticsTests() {
  console.log('--- Running Comprehensive Comment Diagnostic Logging Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { CommentDiagnosticLogger } = require('../../dist/utils/commentDiagnostics');

  const testDbPath = path.resolve(__dirname, 'test-diagnostics.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const mockConfig = {
    STEAM_PROFILE_URL: 'https://steamcommunity.com/id/my_bot_profile/',
    BOT_ENABLED: true,
    EMERGENCY_STOP: false,
    DRY_RUN: true,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-chat',
    MIN_REPLY_DELAY_SECONDS: 0,
    MAX_REPLY_DELAY_SECONDS: 0,
    MAX_REPLIES_PER_HOUR: 10,
    MAX_REPLIES_PER_DAY: 50
  };

  const scheduler = new TaskScheduler(mockConfig, db);

  // Mock DeepSeek for test 14
  scheduler.deepseek = {
    generateReply: async (content, commenterName) => {
      return {
        category: 'general_chat',
        language: 'en',
        confidence: 0.88,
        reply: 'That is quite interesting! Thanks for asking.',
        learnablePhrases: []
      };
    }
  };

  const visitor = 'https://steamcommunity.com/id/visitor_user/';
  const visitorSteamId = '76561198000000001';

  // 1. 正常问候 (Greeting)
  const diag1 = await scheduler.processComment({
    commentId: 'c_01',
    commenterName: 'Alice',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Hello! Good morning'
  }, 1, { persistAndDispatch: false });
  assert.strictEqual(diag1.action, 'REPLY_LOCAL');
  assert.strictEqual(diag1.classification, 'greeting');
  assert.strictEqual(diag1.aiDecision, 'NOT_NEEDED');
  assert.strictEqual(diag1.targetDirectionCheck, 'PASS');
  console.log('  -> Test 1 Passed: 正常问候 (Greeting) correctly diagnosed as LOCAL_RULE');

  // 2. +rep
  const diag2 = await scheduler.processComment({
    commentId: 'c_02',
    commenterName: 'Bob',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '+rep friendly trader'
  }, 2, { persistAndDispatch: false });
  assert.strictEqual(diag2.action, 'REPLY_LOCAL');
  assert.strictEqual(diag2.classification, 'rep');
  assert.strictEqual(diag2.aiDecision, 'NOT_NEEDED');
  console.log('  -> Test 2 Passed: +rep correctly diagnosed as LOCAL_RULE');

  // 3. compliment
  const diag3 = await scheduler.processComment({
    commentId: 'c_03',
    commenterName: 'Charlie',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Your profile background is awesome!'
  }, 3, { persistAndDispatch: false });
  assert.strictEqual(diag3.action, 'REPLY_LOCAL');
  assert.strictEqual(diag3.classification, 'compliment');
  assert.strictEqual(diag3.aiDecision, 'NOT_NEEDED');
  console.log('  -> Test 3 Passed: compliment correctly diagnosed as LOCAL_RULE');

  // 4. warm_social
  const diag4 = await scheduler.processComment({
    commentId: 'c_04',
    commenterName: 'David',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '来踩踩，留个脚印~'
  }, 4, { persistAndDispatch: false });
  assert.strictEqual(diag4.action, 'REPLY_LOCAL');
  assert.strictEqual(diag4.classification, 'warm_social');
  assert.strictEqual(diag4.aiDecision, 'NOT_NEEDED');
  console.log('  -> Test 4 Passed: warm_social correctly diagnosed as LOCAL_RULE');

  // 5. Emoji
  const diag5 = await scheduler.processComment({
    commentId: 'c_05',
    commenterName: 'Eve',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '😀🎉'
  }, 5, { persistAndDispatch: false });
  assert.strictEqual(diag5.action, 'REPLY_LOCAL');
  assert.strictEqual(diag5.classification, 'emoji');
  assert.strictEqual(diag5.aiDecision, 'BLOCKED');
  assert.strictEqual(diag5.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 5 Passed: Emoji correctly diagnosed as LOCAL_RULE & AI_BLOCKED_VISUAL_EXPRESSION');

  // 6. Kaomoji
  const diag6 = await scheduler.processComment({
    commentId: 'c_06',
    commenterName: 'Frank',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: '(^o^)/'
  }, 6, { persistAndDispatch: false });
  assert.strictEqual(diag6.action, 'REPLY_LOCAL');
  assert.strictEqual(diag6.classification, 'kaomoji');
  assert.strictEqual(diag6.aiDecision, 'BLOCKED');
  assert.strictEqual(diag6.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 6 Passed: Kaomoji correctly diagnosed as LOCAL_RULE & AI_BLOCKED_VISUAL_EXPRESSION');

  // 7. Steam Emoticon
  const diag7 = await scheduler.processComment({
    commentId: 'c_07',
    commenterName: 'Grace',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: ':steamhappy:'
  }, 7, { persistAndDispatch: false });
  assert.strictEqual(diag7.action, 'REPLY_LOCAL');
  assert.strictEqual(diag7.classification, 'steam_emoticon');
  assert.strictEqual(diag7.aiDecision, 'BLOCKED');
  assert.strictEqual(diag7.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 7 Passed: Steam Emoticon correctly diagnosed as LOCAL_RULE & AI_BLOCKED_VISUAL_EXPRESSION');

  // 8. Emoji Pixel Art
  const emojiPixelArt = [
    '🟧🟧🟧🟧🟧',
    '🟧🟩🟩🟩🟧',
    '🟧🟩⬛🟩🟧',
    '🟧🟩🟩🟩🟧',
    '🟧🟧🟧🟧🟧'
  ].join('\n');
  const diag8 = await scheduler.processComment({
    commentId: 'c_08',
    commenterName: 'Heidi',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: emojiPixelArt
  }, 8, { persistAndDispatch: false });
  assert.strictEqual(diag8.visualExpression, true);
  assert.strictEqual(diag8.visualExpressionSubtype, 'emoji_pixel_art');
  assert.strictEqual(diag8.action, 'REPLY_LOCAL');
  assert.strictEqual(diag8.aiDecision, 'BLOCKED');
  assert.strictEqual(diag8.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 8 Passed: Emoji Pixel Art correctly intercepted with AI_BLOCKED_VISUAL_EXPRESSION');

  // 9. Braille Art
  const brailleArt = [
    '⣿⣿⣿⣿⣿⣿⣿⣿⣿',
    '⣿⣿⣿⣿⣿⣿⣿⣿⣿',
    '⣿⣿⣿⣿⣿⣿⣿⣿⣿'
  ].join('\n');
  const diag9 = await scheduler.processComment({
    commentId: 'c_09',
    commenterName: 'Ivan',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: brailleArt
  }, 9, { persistAndDispatch: false });
  assert.strictEqual(diag9.visualExpression, true);
  assert.strictEqual(diag9.visualExpressionSubtype, 'braille_art');
  assert.strictEqual(diag9.action, 'REPLY_LOCAL');
  assert.strictEqual(diag9.aiDecision, 'BLOCKED');
  assert.strictEqual(diag9.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 9 Passed: Braille Art correctly intercepted with AI_BLOCKED_VISUAL_EXPRESSION');

  // 10. ASCII Art
  const asciiArt = [
    ' /\\_/\\ ',
    '( o.o )',
    ' > ^ < '
  ].join('\n');
  const diag10 = await scheduler.processComment({
    commentId: 'c_10',
    commenterName: 'Judy',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: asciiArt
  }, 10, { persistAndDispatch: false });
  assert.strictEqual(diag10.visualExpression, true);
  assert.strictEqual(diag10.action, 'REPLY_LOCAL');
  assert.strictEqual(diag10.aiDecision, 'BLOCKED');
  assert.strictEqual(diag10.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 10 Passed: ASCII Art correctly intercepted with AI_BLOCKED_VISUAL_EXPRESSION');

  // 11. Unicode Art
  const unicodeArt = [
    '██████████',
    '██░░░░░░██',
    '██░░██░░██',
    '██░░░░░░██',
    '██████████'
  ].join('\n');
  const diag11 = await scheduler.processComment({
    commentId: 'c_11',
    commenterName: 'Karl',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: unicodeArt
  }, 11, { persistAndDispatch: false });
  assert.strictEqual(diag11.visualExpression, true);
  assert.strictEqual(diag11.action, 'REPLY_LOCAL');
  assert.strictEqual(diag11.aiDecision, 'BLOCKED');
  assert.strictEqual(diag11.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  console.log('  -> Test 11 Passed: Unicode Art correctly intercepted with AI_BLOCKED_VISUAL_EXPRESSION');

  // 12. Spam
  const diag12 = await scheduler.processComment({
    commentId: 'c_12',
    commenterName: 'Scammer',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Claim free skins at http://csgo-free-skins.com ! Promo code: WIN'
  }, 12, { persistAndDispatch: false });
  assert.strictEqual(diag12.action, 'SKIP');
  assert.strictEqual(diag12.skipReason, 'SPAM');
  assert.strictEqual(diag12.replySource, 'NONE');
  assert.strictEqual(diag12.aiDecision, 'NOT_NEEDED');
  console.log('  -> Test 12 Passed: Spam correctly skipped with skipReason: SPAM');

  // 13. Already Replied
  const repliedId = 'c_replied_99';
  scheduler.commentsRepo.insert({
    steam_comment_id: repliedId,
    commenter_steam_id: visitorSteamId,
    commenter_name: 'ExistingUser',
    commenter_profile_url: visitor,
    content: 'Already seen message',
    status: 'replied',
    reply_source: 'LOCAL_TEMPLATE',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  const diag13 = await scheduler.processComment({
    commentId: repliedId,
    commenterName: 'ExistingUser',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Already seen message'
  }, 13, { persistAndDispatch: false });
  assert.strictEqual(diag13.databaseRecordExists, true);
  assert.strictEqual(diag13.databaseStatus, 'replied');
  assert.strictEqual(diag13.action, 'SKIP');
  assert.strictEqual(diag13.skipReason, 'ALREADY_REPLIED');
  console.log('  -> Test 13 Passed: Already Replied correctly recognized (databaseRecordExists: true, SKIP)');

  // 14. DeepSeek Fallback
  const diag14 = await scheduler.processComment({
    commentId: 'c_14',
    commenterName: 'Mallory',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'What is your opinion about cosmic string theory and dark matter?'
  }, 14, { persistAndDispatch: false });
  assert.strictEqual(diag14.aiDecision, 'CALLED');
  assert.strictEqual(diag14.aiReason, 'UNKNOWN_LOCAL_CLASSIFICATION');
  assert.strictEqual(diag14.action, 'REPLY_AI');
  assert.strictEqual(diag14.replySource, 'DEEPSEEK');
  assert.ok(diag14.aiLatencyMs !== undefined);
  console.log('  -> Test 14 Passed: DeepSeek Fallback correctly invoked with CALLED, REPLY_AI, DEEPSEEK');

  // 15. AI_BLOCKED_VISUAL_EXPRESSION explicit assertion
  assert.strictEqual(diag8.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION');
  assert.strictEqual(diag8.aiDecision, 'BLOCKED');
  console.log('  -> Test 15 Passed: AI_BLOCKED_VISUAL_EXPRESSION explicit verification passed');

  // 16. Missing SteamID
  const diag16 = await scheduler.processComment({
    commentId: 'c_16',
    commenterName: 'Nia',
    commenterSteamId: '',
    commenterProfileUrl: visitor,
    content: 'Hello without steam id'
  }, 16, { persistAndDispatch: false });
  assert.strictEqual(diag16.action, 'SKIP');
  assert.strictEqual(diag16.skipReason, 'MISSING_STEAM_ID');
  console.log('  -> Test 16 Passed: Missing SteamID correctly skipped with MISSING_STEAM_ID');

  // 17. Missing Profile URL
  const diag17 = await scheduler.processComment({
    commentId: 'c_17',
    commenterName: 'Oscar',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: '',
    content: 'Hello without profile url'
  }, 17, { persistAndDispatch: false });
  assert.strictEqual(diag17.action, 'SKIP');
  assert.strictEqual(diag17.skipReason, 'MISSING_PROFILE_URL');
  console.log('  -> Test 17 Passed: Missing Profile URL correctly skipped with MISSING_PROFILE_URL');

  // 18. Target Direction PASS
  const diag18 = await scheduler.processComment({
    commentId: 'c_18',
    commenterName: 'Peggy',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Hello from visitor'
  }, 18, { persistAndDispatch: false });
  assert.strictEqual(diag18.direction, 'INCOMING_FROM_B_TO_A');
  assert.strictEqual(diag18.targetDirectionCheck, 'PASS');
  console.log('  -> Test 18 Passed: Target Direction PASS (INCOMING_FROM_B_TO_A)');

  // 19. Target Direction FAIL
  const diag19 = await scheduler.processComment({
    commentId: 'c_19',
    commenterName: 'Self',
    commenterSteamId: '76561198000000000',
    commenterProfileUrl: mockConfig.STEAM_PROFILE_URL,
    content: 'Self comment'
  }, 19, { persistAndDispatch: false });
  assert.strictEqual(diag19.targetDirectionCheck, 'FAIL');
  assert.strictEqual(diag19.action, 'BLOCKED');
  assert.strictEqual(diag19.skipReason, 'INVALID_TARGET');
  console.log('  -> Test 19 Passed: Target Direction FAIL strictly BLOCKED with INVALID_TARGET');

  // 20. Rate Limited
  scheduler.rateLimiter = {
    canSendReply: () => ({ allowed: false, reason: 'Hourly limit reached (10/10)' })
  };
  const diag20 = await scheduler.processComment({
    commentId: 'c_20',
    commenterName: 'Quinn',
    commenterSteamId: visitorSteamId,
    commenterProfileUrl: visitor,
    content: 'Tell me more about quantum entanglement'
  }, 20, { persistAndDispatch: false });
  assert.strictEqual(diag20.action, 'SKIP');
  assert.strictEqual(diag20.skipReason, 'RATE_LIMITED');
  assert.strictEqual(diag20.aiDecision, 'SKIPPED');
  // 21. Real World Regression: pwn3d Emoji Pixel Art full pipeline test (New Comment)
  const pwn3dContent = '⬛⬛ㅤ ㅤ ㅤ ㅤ ㅤ ㅤ ㅤ ⬛⬛⬛🟨⬛ㅤ ㅤ ㅤ ㅤ ㅤ ⬛🟨⬛⬛🟨🟨🟨ㅤ ㅤ ㅤ 🟨🟨🟨⬛ㅤ 🟨🟨🟨🟨🟨🟨🟨🟨🟨ㅤ 🟨⬛⬛⬛⬛⬛⬛⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬛⬛⬛⬛⬛⬛🟨ㅤ ㅤ ㅤ 🟨🟨ㅤ 🟥🟨🟨🟨🟨🟨🟨🟨🟥ㅤ ㅤ 🟨🟨🟨ㅤ 🟥🟥🟨🟨🟨🟨🟨🟥🟥ㅤ ㅤ 🟨🟨🟨ㅤ 🟥🟨⬛🟨🟨🟨🟨⬛🟥ㅤ 🟨🟨🟨ㅤ 🟨⬛⬛⬛🟨🟨⬛🟨🟨🟫🟨🟨ㅤ 🟨🟨⬛🟨🟨🟨🟨🟨🟨🟫🟫ㅤ 🟨🟨🟨🟨🟨🟨🟨🟨🟨🟫ㅤ 🟨🟨🟨🟫🟨🟫🟨🟨🟨ㅤ ㅤ 🟨🟨🟨🟨🟨🟨🟨';
  const diag21 = await scheduler.processComment({
    commentId: 'c_pwn3d_real',
    commenterName: 'pwn3d',
    commenterSteamId: 'pwn3d_07',
    commenterProfileUrl: 'https://steamcommunity.com/id/pwn3d_07',
    content: pwn3dContent
  }, 21, { persistAndDispatch: false });
  assert.strictEqual(diag21.visualExpression, true, 'Real pwn3d comment must be visualExpression=true');
  assert.strictEqual(diag21.visualExpressionSubtype, 'emoji_pixel_art', 'Real pwn3d subtype must be emoji_pixel_art');
  assert.ok(diag21.visualExpressionConfidence >= 0.90, `Real pwn3d confidence (${diag21.visualExpressionConfidence}) must be >= 0.90`);
  assert.strictEqual(diag21.aiDecision, 'BLOCKED', 'AI must be BLOCKED');
  assert.strictEqual(diag21.blockReason, 'AI_BLOCKED_VISUAL_EXPRESSION', 'Block reason must be AI_BLOCKED_VISUAL_EXPRESSION');
  assert.ok(
    diag21.replySource === 'VISUAL_LIBRARY' || diag21.replySource === 'LOCAL_TEMPLATE',
    `Reply source must be VISUAL_LIBRARY or LOCAL_TEMPLATE, got: ${diag21.replySource}`
  );
  console.log('  -> Test 21 Passed: Real pwn3d Emoji Pixel Art full pipeline (visualExpression=true, conf=' + diag21.visualExpressionConfidence + ', AI_BLOCKED_VISUAL_EXPRESSION)');

  // Test Formatters
  const consoleOutput = CommentDiagnosticLogger.formatConsoleDiagnostic(diag1);
  assert.ok(consoleOutput.includes('[COMMENT 1]'));
  assert.ok(consoleOutput.includes('TargetDirectionCheck:\nPASS'));

  const summaryOutput = CommentDiagnosticLogger.formatSummary({
    totalComments: 20,
    newComments: 10,
    alreadyProcessed: 1,
    spam: 1,
    localReplies: 6,
    visualExpressionLocal: 4,
    deepseekReplies: 1,
    aiRequests: 1,
    aiRequestsBlocked: 4,
    aiRequestsSaved: 10,
    visualExpressionSaved: 4,
    rateLimited: 1,
    errors: 3
  });
  assert.ok(summaryOutput.includes('COMMENT SCAN SUMMARY'));
  assert.ok(summaryOutput.includes('Visual Expression AI Requests Saved:\n4'));
  console.log('  -> Formatters Test Passed: Console diagnostic and summary formats verified');

  // Clean up
  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('✅ Passed all 21 Diagnostic Logging test scenarios!');
}

module.exports = { runDiagnosticsTests };
if (require.main === module) runDiagnosticsTests();
