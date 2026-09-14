const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runModerationIdempotencyAcceptanceTests() {
  console.log('\n--- Running Moderation Idempotency & Zero-Resend Acceptance Tests ---');

  const { SteamModerationDetector } = require('../../dist/rules/moderationDetector');
  const { SteamSendVerifier } = require('../../dist/steam/transport/steamSendVerifier');
  const { CommentSender } = require('../../dist/steam/commentSender');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { Logger } = require('../../dist/utils/logger');
  const { loadConfig } = require('../../dist/config/env');

  const logger = new Logger('test', { quiet: true });
  const myProfileUrl = 'https://steamcommunity.com/id/test_bot_user/';
  const targetProfileUrl = 'https://steamcommunity.com/profiles/76561198000000002';
  const sampleReply = '⢀⡤⣄⡀⠀⠀⠀⠀⣀⣤⡀\n⢠⡏⠀⠈⠳⡄⢠⠞⠁⠀⢹⡄';
  const moderationPlaceholderText =
    '此留言正在等待我们的自动内容检查系统分析。在我们证实其内容无害之前，留言将暂时隐藏。';

  // -------------------------------------------------------------
  // Test 1: SteamModerationDetector Detection Coverage
  // -------------------------------------------------------------
  console.log('--- TEST 1: SteamModerationDetector Detection Coverage ---');
  const check1 = SteamModerationDetector.detect(moderationPlaceholderText);
  assert.strictEqual(check1.isModerationPending, true, 'Exact Chinese moderation notice must be detected');

  const checkHtml = SteamModerationDetector.detect(
    `<div class="commentthread_comment_text">  ${moderationPlaceholderText}  <br></div>`
  );
  assert.strictEqual(checkHtml.isModerationPending, true, 'HTML wrapped moderation notice must be detected');

  const checkEn = SteamModerationDetector.detect(
    'This comment is awaiting analysis by our automated content check system. It will be temporarily hidden until we have verified its content.'
  );
  assert.strictEqual(checkEn.isModerationPending, true, 'English moderation notice must be detected');
  console.log('  -> TEST 1 PASSED: Moderation placeholder phrases accurately detected in text and HTML.');

  // -------------------------------------------------------------
  // Test 2: SteamSendVerifier with Moderation Placeholder
  // -------------------------------------------------------------
  console.log('--- TEST 2: SteamSendVerifier Identifies Moderation Placeholder on Page ---');
  const verifier = new SteamSendVerifier(myProfileUrl, logger);

  // Mock page simulating target profile with moderation placeholder
  const mockPageWithModeration = {
    $: async (selector) => {
      if (selector === '#comment_581681621355473062') {
        return {
          textContent: async () => moderationPlaceholderText
        };
      }
      return null;
    },
    $$eval: async (selector, fn) => {
      return [
        {
          id: 'comment_581681621355473062',
          author: 'MockPlayer',
          profileUrl: myProfileUrl,
          text: '', // Empty in .commentthread_comment_text
          fullText: `MockPlayer ${moderationPlaceholderText}` // Full element has the notice
        }
      ];
    },
    $eval: async (selector, fn) => moderationPlaceholderText,
    evaluate: async (fn) => moderationPlaceholderText
  };

  const vResult = await verifier.verifyCommentInPage(
    mockPageWithModeration,
    sampleReply,
    'comment_581681621355473062'
  );
  assert.strictEqual(vResult, 'MODERATION_PENDING', 'Verifier must return MODERATION_PENDING, NOT NOT_FOUND!');
  console.log('  -> TEST 2 PASSED: Verifier successfully returned MODERATION_PENDING for placeholder element.');

  // -------------------------------------------------------------
  // Test 3: Core Real-World Incident Simulation (Strictly POST count = 1)
  // -------------------------------------------------------------
  console.log('--- TEST 3: Core Incident Simulation - Post count MUST strictly equal 1 ---');
  const testDbPath = path.resolve(__dirname, 'test-moderation-incident.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);
  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  let postCount = 0;

  // Mock browser manager & transport
  const mockBrowserManager = {
    openEphemeralPage: async () => {
      return {
        goto: async () => {},
        waitForSelector: async () => {},
        close: async () => {},
        evaluate: async (fn) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return {
                sessionId: 'sess_valid_123',
                steamId: '76561198000000002',
                accountPulldown: 'test_bot_user',
                hasLoginCookieInDoc: true
              };
            }
            if (fnStr.includes('g_rgProfileData')) {
              return '76561199202573055';
            }
          }
          return { steamid: '76561199202573055' };
        },
        $: async (selector) => {
          if (postCount > 0 && selector === '#comment_581681621355473062') {
            return {
              textContent: async () => moderationPlaceholderText
            };
          }
          return null;
        },
        $$eval: async (selector, fn) => {
          if (postCount > 0) {
            return [
              {
                id: 'comment_581681621355473062',
                author: 'MockPlayer',
                profileUrl: myProfileUrl,
                text: '',
                fullText: `MockPlayer ${moderationPlaceholderText}`
              }
            ];
          }
          return [];
        },
        $eval: async (selector, fn) => {
          if (selector && selector.includes('restricted')) {
            throw new Error('Error: failed to find element matching selector');
          }
          if (typeof fn === 'function') {
            return fn({ textContent: postCount > 0 ? moderationPlaceholderText : '' });
          }
          return postCount > 0 ? moderationPlaceholderText : '';
        }
      };
    }
  };

  const config = loadConfig();
  config.STEAM_PROFILE_URL = myProfileUrl;
  config.DRY_RUN = false;

  const scheduler = new TaskScheduler(config, db, logger);

  // Mock CommentSender transport dispatch
  scheduler.commentSender = new CommentSender(mockBrowserManager, myProfileUrl, logger);
  scheduler.commentSender.transport = {
    postComment: async () => {
      postCount++;
      return {
        httpStatus: 200,
        rawJson: {
          success: true,
          comments_html: `<div class="commentthread_comment" id="comment_581681621355473062">${moderationPlaceholderText}</div>`
        }
      };
    }
  };

  // Create initial comment and reply task
  const commentId = 'comment_589562920377282645';
  const taskId = 'task_4171a306e8596740';
  commentsRepo.insert({
    steam_comment_id: commentId,
    commenter_steam_id: '76561199202573055',
    commenter_name: '菜鸟快递',
    commenter_profile_url: targetProfileUrl,
    content: '测试评论',
    content_hash: 'hash123',
    language: 'zh',
    classification: 'braille_art',
    classification_confidence: 0.99,
    reply_source: 'LOCAL_TEMPLATE',
    reply: sampleReply,
    status: 'waiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  replyTasksRepo.insert({
    task_id: taskId,
    steam_comment_id: commentId,
    target_steam_id: '76561199202573055',
    target_profile_url: targetProfileUrl,
    reply_text: sampleReply,
    status: 'waiting',
    attempt_count: 0,
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString()
  });

  // 1. First Dispatch: Live send
  scheduler.isRunning = true;
  scheduler.sessionState = 'authenticated';
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(postCount, 1, 'First dispatch must POST once');

  const taskAfterSend = replyTasksRepo.findByTaskId(taskId);
  assert.strictEqual(
    taskAfterSend.status,
    'submitted_moderation_pending',
    'Task must be classified as submitted_moderation_pending'
  );

  // 2. Next Poll Cycle: Run Uncertain recovery & Moderation pending recovery
  await scheduler.runUncertainStateRecoveryStep();
  await scheduler.runModerationPendingRecoveryStep();

  const taskAfterRecovery = replyTasksRepo.findByTaskId(taskId);
  assert.strictEqual(
    taskAfterRecovery.status,
    'submitted_moderation_pending',
    'Task must remain submitted_moderation_pending'
  );

  // 3. Next Dispatch: Must NOT resend
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(postCount, 1, 'CRITICAL: Post count MUST STRICTLY EQUAL 1, no duplicate POST!');
  console.log('  -> TEST 3 PASSED: Core incident simulated. POST count strictly equals 1!');

  // -------------------------------------------------------------
  // Test 4: Scheduler Restart with Moderation Pending Task
  // -------------------------------------------------------------
  console.log('--- TEST 4: Scheduler Restart with Moderation Pending Task ---');
  const restartedScheduler = new TaskScheduler(config, db, logger);
  restartedScheduler.commentSender = scheduler.commentSender;
  restartedScheduler.isRunning = true;
  restartedScheduler.sessionState = 'authenticated';

  await restartedScheduler.runCrashRecovery();
  await restartedScheduler.runModerationPendingRecoveryStep();
  await restartedScheduler.dispatchPendingRepliesStep();

  assert.strictEqual(postCount, 1, 'Restart must not trigger duplicate POST for moderation pending task');
  console.log('  -> TEST 4 PASSED: Restart preserved moderation pending state with zero re-POST.');

  // -------------------------------------------------------------
  // Test 5: Pre-send Idempotency Safe Gate in Scheduler
  // -------------------------------------------------------------
  console.log('--- TEST 5: Pre-send Idempotency Safe Gate in Scheduler ---');
  // Even if an external bug manually forces a task back to 'waiting',
  // the pre-send safety gate in dispatchPendingRepliesStep inspects the target page and refuses to send!
  replyTasksRepo.updateStatus(taskId, 'waiting', { attempt_count: 1 });
  db.prepare("UPDATE reply_tasks SET scheduled_at = ? WHERE task_id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    taskId
  );
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(postCount, 1, 'Pre-send safe gate strictly blocked POST from dispatching!');
  const taskAfterSafeGate = replyTasksRepo.findByTaskId(taskId);
  assert.strictEqual(taskAfterSafeGate.status, 'submitted_moderation_pending');
  console.log('  -> TEST 5 PASSED: Pre-send safe gate intercepted send before POST dispatch.');

  // -------------------------------------------------------------
  // Test 6: Network Failure with 0 comments allows safe retry
  // -------------------------------------------------------------
  console.log('--- TEST 6: Network Connection Failure Allows Retry ---');
  let failPostCount = 0;
  const failCommentSender = new CommentSender(mockBrowserManager, myProfileUrl, logger);
  failCommentSender.verifier = {
    checkTargetDomRestricted: async () => false,
    verifyCommentInPage: async () => 'NOT_FOUND'
  };
  failCommentSender.transport = {
    postComment: async () => {
      failPostCount++;
      return {
        httpStatus: 0,
        success: false,
        networkError: 'ECONNRESET',
        rawError: 'ECONNRESET'
      };
    }
  };

  const failResult = await failCommentSender.sendReply(
    'https://steamcommunity.com/id/randomuser',
    'hello',
    '76561198000000000'
  );
  assert.strictEqual(failResult.status, 'UNCERTAIN');
  console.log('  -> TEST 6 PASSED: Genuine transport errors appropriately classified.');

  // -------------------------------------------------------------
  // Test 7: Direct Replay of Case A (Pre-POST timeout) & Case B (Moderation Pending)
  // -------------------------------------------------------------
  console.log('--- TEST 7: Direct Replay of Case A & Case B ---');
  
  // Case A: Pre-POST navigation timeout -> FAILED_RETRYABLE -> Retry succeeds -> Total POST = 1
  let caseAPostCount = 0;
  let caseANavCount = 0;
  const caseABrowserManager = {
    openEphemeralPage: async () => {
      return {
        goto: async () => {
          caseANavCount++;
          if (caseANavCount === 1) {
            throw new Error('page.goto: Timeout 30000ms exceeded\nnavigating to "https://steamcommunity.com/profiles/76561199888310132", waiting until "domcontentloaded"');
          }
        },
        waitForSelector: async () => {},
        close: async () => {},
        evaluate: async (fn) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return { sessionId: 'sess_1', steamId: '76561199888310132', accountPulldown: 'User', hasLoginCookieInDoc: true };
            }
            if (fnStr.includes('g_rgProfileData')) return '76561198888310132';
          }
          return { steamid: '76561198888310132' };
        }
      };
    }
  };

  const caseASender = new CommentSender(caseABrowserManager, myProfileUrl, logger);
  caseASender.transport = {
    postComment: async () => {
      caseAPostCount++;
      return {
        httpStatus: 200,
        rawJson: { success: true, comments_html: '<div id="comment_111">test reply</div>' }
      };
    }
  };
  caseASender.verifier = {
    checkTargetDomRestricted: async () => false,
    verifyOnTargetProfile: async () => 'FOUND',
    verifyCommentInPage: async () => (caseAPostCount > 0 ? 'FOUND' : 'NOT_FOUND')
  };

  const caseACommentId = 'comment_case_a_001';
  const caseATaskId = 'task_case_a_001';
  commentsRepo.insert({
    steam_comment_id: caseACommentId,
    commenter_steam_id: '76561198888310132',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198888310132',
    content: 'hello test case a',
    status: 'waiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  replyTasksRepo.insert({
    task_id: caseATaskId,
    steam_comment_id: caseACommentId,
    target_steam_id: '76561198888310132',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198888310132',
    reply_text: 'test reply',
    status: 'waiting',
    attempt_count: 0,
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString()
  });

  scheduler.commentSender = caseASender;

  // Dispatch attempt 1: triggers page.goto timeout
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(caseAPostCount, 0, 'Case A attempt 1: POST must NOT be called on pre-POST timeout');
  const taskAfterA1 = replyTasksRepo.findByTaskId(caseATaskId);
  assert.strictEqual(taskAfterA1.status, 'waiting', 'Case A attempt 1: must be retried as waiting');
  assert.strictEqual(taskAfterA1.attempt_count, 1, 'Case A attempt 1: attempt count incremented to 1');

  // Dispatch attempt 2: simulate scheduled retry delay expired
  replyTasksRepo.updateStatus(caseATaskId, 'waiting', { scheduled_at: new Date(Date.now() - 1000).toISOString() });
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(caseAPostCount, 1, 'Case A attempt 2: POST must be called exactly once');
  const taskAfterA2 = replyTasksRepo.findByTaskId(caseATaskId);
  assert.strictEqual(taskAfterA2.status, 'replied', 'Case A attempt 2: task completed as replied');

  // Case B: Post succeeds -> moderation pending -> 10 recovery loops -> POST strictly = 1
  let caseBPostCount = 0;
  const caseBSender = new CommentSender(mockBrowserManager, myProfileUrl, logger);
  caseBSender.transport = {
    postComment: async () => {
      caseBPostCount++;
      return {
        httpStatus: 200,
        rawJson: { success: true, comments_html: `<div id="comment_222">${moderationPlaceholderText}</div>` }
      };
    }
  };
  caseBSender.verifier = {
    checkTargetDomRestricted: async () => false,
    verifyOnTargetProfile: async () => 'MODERATION_PENDING',
    verifyCommentInPage: async () => 'MODERATION_PENDING'
  };
  caseBSender.checkTargetProfileForExistingComment = async () => 'MODERATION_PENDING';

  const caseBCommentId = 'comment_case_b_001';
  const caseBTaskId = 'task_case_b_001';
  commentsRepo.insert({
    steam_comment_id: caseBCommentId,
    commenter_steam_id: '76561199202573055',
    commenter_profile_url: targetProfileUrl,
    content: 'hello test case b',
    status: 'waiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  replyTasksRepo.insert({
    task_id: caseBTaskId,
    steam_comment_id: caseBCommentId,
    target_steam_id: '76561199202573055',
    target_profile_url: targetProfileUrl,
    reply_text: 'sample reply b',
    status: 'waiting',
    attempt_count: 0,
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString()
  });

  scheduler.commentSender = caseBSender;

  // First dispatch: POST executes
  await scheduler.dispatchPendingRepliesStep();
  assert.strictEqual(caseBPostCount, 1, 'Case B: First send must POST once');
  const taskAfterB1 = replyTasksRepo.findByTaskId(caseBTaskId);
  assert.strictEqual(taskAfterB1.status, 'submitted_moderation_pending');

  // Run 10 recovery cycles: POST count MUST stay strictly 1
  for (let cycle = 1; cycle <= 10; cycle++) {
    await scheduler.runUncertainStateRecoveryStep();
    await scheduler.runModerationPendingRecoveryStep();
    await scheduler.runCrashRecovery();
    await scheduler.dispatchPendingRepliesStep();
    assert.strictEqual(caseBPostCount, 1, `Case B Cycle ${cycle}: POST count MUST strictly remain 1!`);
  }
  const taskAfterB10 = replyTasksRepo.findByTaskId(caseBTaskId);
  assert.strictEqual(taskAfterB10.status, 'submitted_moderation_pending');
  console.log('  -> TEST 7 PASSED: Case A (1 retry -> POST=1) and Case B (10 recovery cycles -> POST=1) verified.');

  // Clean up
  db.close();
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  console.log('✅ ALL Moderation Idempotency & Zero-Resend Acceptance Tests PASSED!\n');
}

module.exports = { runModerationIdempotencyAcceptanceTests };

if (require.main === module) {
  runModerationIdempotencyAcceptanceTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
}
