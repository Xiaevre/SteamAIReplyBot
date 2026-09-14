const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runHybridSenderTests() {
  console.log('--- Running Hybrid Comment Sender & Lifecycle Verification Tests ---');

  const { CommentSender } = require('../../dist/steam/commentSender');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');

  const testDbPath = path.resolve(__dirname, 'test-hybrid-sender.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  const myProfileUrl = 'https://steamcommunity.com/id/test_bot_user/';
  const targetProfileUrl = 'https://steamcommunity.com/profiles/76561198000000002/';
  const targetSteamId = '76561198000000002';

  const mockLogger = {
    info: (tag, data) => {},
    warn: (tag, data) => {},
    error: (tag, data) => {}
  };

  // Helper to create a mock browser manager with programmable evaluate/verification responses
  function createMockBrowserManager({
    fetchResult = { httpStatus: 200, networkError: null, rawJson: { success: true, comments_html: '<div id="comment_99999">test</div>' } },
    commentsRestricted = false,
    sessionReady = true,
    verificationResult = 'FOUND',
    foundText = 'hello reply 123'
  }) {
    return {
      openEphemeralPage: async () => ({
        context: () => ({
          cookies: async () => sessionReady ? [
            { name: 'sessionid', value: 'sess_valid_123' },
            { name: 'steamLoginSecure', value: '76561198000000000%7C%7CvalidToken12345678' }
          ] : []
        }),
        goto: async () => {},
        $eval: async (sel) => {
          if (sel.includes('commentthread_restricted') || sel.includes('profile_comment_area_restricted')) {
            return commentsRestricted;
          }
          return false;
        },
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            // Lightweight session check
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return sessionReady ? {
                sessionId: 'sess_valid_123',
                steamId: '76561198000000000',
                accountPulldown: 'test_bot_user',
                hasLoginCookieInDoc: true
              } : {
                sessionId: null,
                steamId: null,
                accountPulldown: null,
                hasLoginCookieInDoc: false
              };
            }
            // Session readiness check
            if (fnStr.includes('g_sessionID') && !fnStr.includes('fetch')) {
              return sessionReady;
            }
            // Fetch evaluation
            if (fnStr.includes('fetch')) {
              return fetchResult;
            }
          }
          return {};
        },
        $$eval: async (sel, fn) => {
          if (verificationResult === 'FOUND') {
            return [{
              id: 'comment_99999',
              text: foundText,
              author: 'test_bot_user',
              profileUrl: myProfileUrl
            }];
          } else if (verificationResult === 'MODERATION_PENDING') {
            return [{
              id: 'comment_mod_1',
              text: '此留言正在等待我们的自动内容检查系统分析。',
              author: 'test_bot_user',
              profileUrl: myProfileUrl
            }];
          } else if (verificationResult === 'EMPTY') {
            return [];
          } else {
            // NOT_FOUND
            return [{
              id: 'comment_other_1',
              text: 'unrelated comment',
              author: 'OtherUser',
              profileUrl: 'https://steamcommunity.com/id/other'
            }];
          }
        },
        close: async () => {}
      })
    };
  }

  // =========================================================================
  // Test A: HTTP success + target verification -> status: SUCCESS / replied
  // =========================================================================
  {
    console.log('--- Case A: HTTP Success + Target Verification Confirmed ---');
    const mockBm = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_581681621355377777">hello reply 123</div>'
        }
      },
      verificationResult: 'FOUND'
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'hello reply 123', targetSteamId);

    assert.strictEqual(result.status, 'SUCCESS', 'Case A must return SUCCESS');
    assert.strictEqual(result.commentId, 'comment_581681621355377777', 'Parsed comment ID must match server response');
    console.log('  -> Case A Passed: HTTP 200 + target verification -> SUCCESS');
  }

  // =========================================================================
  // Test B: HTTP success + moderation pending placeholder -> MODERATION_PENDING
  // =========================================================================
  {
    console.log('--- Case B: HTTP Success + Moderation Pending Placeholder ---');
    // Scenario B1: returned comments_html contains moderation placeholder
    const mockBm1 = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_mod_888">此留言正在等待我们的自动内容检查系统分析。</div>'
        }
      },
      verificationResult: 'FOUND'
    });

    const sender1 = new CommentSender(mockBm1, myProfileUrl, mockLogger);
    const result1 = await sender1.sendReply(targetProfileUrl, 'hello mod', targetSteamId);
    assert.strictEqual(result1.status, 'MODERATION_PENDING', 'Comments HTML moderation pending must map to MODERATION_PENDING');

    // Scenario B2: comments_html clean, but target profile reload shows moderation pending
    const mockBm2 = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_mod_889">clean</div>'
        }
      },
      verificationResult: 'MODERATION_PENDING'
    });

    const sender2 = new CommentSender(mockBm2, myProfileUrl, mockLogger);
    const result2 = await sender2.sendReply(targetProfileUrl, 'hello mod', targetSteamId);
    assert.strictEqual(result2.status, 'MODERATION_PENDING', 'Target page moderation pending must map to MODERATION_PENDING');
    console.log('  -> Case B Passed: Moderation placeholder correctly mapped to MODERATION_PENDING');
  }

  // =========================================================================
  // Test C: HTTP failure + rate limit -> RATE_LIMITED
  // =========================================================================
  {
    console.log('--- Case C: HTTP Failure + Rate Limit ---');
    const mockBm = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: false,
          error: "You've been posting too frequently, and can't post again right now."
        }
      }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'hello rate limit', targetSteamId);
    assert.strictEqual(result.status, 'RATE_LIMITED', 'Posting too frequently must map to RATE_LIMITED');
    assert.ok(result.message.includes('frequently'), 'Error message must be preserved');
    console.log('  -> Case C Passed: "posting too frequently" correctly classified as RATE_LIMITED');
  }

  // =========================================================================
  // Test D: HTTP failure + permission denied -> PERMISSION_DENIED
  // =========================================================================
  {
    console.log('--- Case D: HTTP Failure + Permission Denied ---');
    // Scenario D1: Server returns success: false with privacy/friend message
    const mockBm1 = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: false,
          error: "This user's settings only allow friends to post comments."
        }
      }
    });

    const sender1 = new CommentSender(mockBm1, myProfileUrl, mockLogger);
    const result1 = await sender1.sendReply(targetProfileUrl, 'hello priv', targetSteamId);
    assert.strictEqual(result1.status, 'PERMISSION_DENIED', 'Friend setting error must map to PERMISSION_DENIED');

    // Scenario D2: Target profile has .commentthread_restricted
    const mockBm2 = createMockBrowserManager({
      commentsRestricted: true
    });
    const sender2 = new CommentSender(mockBm2, myProfileUrl, mockLogger);
    const result2 = await sender2.sendReply(targetProfileUrl, 'hello priv', targetSteamId);
    assert.strictEqual(result2.status, 'PERMISSION_DENIED', 'commentthread_restricted must map to PERMISSION_DENIED');
    console.log('  -> Case D Passed: Comment restriction correctly mapped to PERMISSION_DENIED');
  }

  // =========================================================================
  // Test E: Network error / timeout -> UNCERTAIN
  // =========================================================================
  {
    console.log('--- Case E: Network Error / Timeout ---');
    const mockBm = createMockBrowserManager({
      fetchResult: {
        httpStatus: 0,
        networkError: 'Failed to fetch (net::ERR_CONNECTION_RESET)',
        rawJson: null
      }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'hello net err', targetSteamId);
    assert.strictEqual(result.status, 'UNCERTAIN', 'Network error must be marked as UNCERTAIN');
    console.log('  -> Case E Passed: Network error strictly mapped to UNCERTAIN');
  }

  // =========================================================================
  // Test F: Scheduler Uncertain Recovery finds reply on target -> REPLIED
  // =========================================================================
  {
    console.log('--- Case F: Uncertain Recovery Finds Existing Reply ---');
    const taskIdF = 'task_unc_recovery_found';
    const commentIdF = 'comment_unc_f';

    commentsRepo.insert({
      steam_comment_id: commentIdF,
      commenter_steam_id: targetSteamId,
      commenter_profile_url: targetProfileUrl,
      content: 'hello F',
      status: 'uncertain_send_state',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    replyTasksRepo.insert({
      task_id: taskIdF,
      steam_comment_id: commentIdF,
      target_steam_id: targetSteamId,
      target_profile_url: targetProfileUrl,
      reply_text: 'Reply to F',
      status: 'uncertain_send_state',
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      attempt_count: 0
    });

    const mockBmF = createMockBrowserManager({
      verificationResult: 'FOUND',
      foundText: 'Reply to F'
    });

    const config = {
      STEAM_PROFILE_URL: myProfileUrl,
      DRY_RUN: false,
      HEADLESS: true,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 100,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0
    };

    const scheduler = new TaskScheduler(config, db, mockLogger);
    scheduler.commentSender = new CommentSender(mockBmF, myProfileUrl, mockLogger);

    await scheduler.runUncertainStateRecoveryStep();

    const taskAfter = replyTasksRepo.findByTaskId(taskIdF);
    const commentAfter = commentsRepo.findByCommentId(commentIdF);

    assert.strictEqual(taskAfter.status, 'replied', 'Task must transition from uncertain to replied when comment found');
    assert.strictEqual(commentAfter.status, 'replied', 'Comment must transition to replied when comment found');
    console.log('  -> Case F Passed: Uncertain recovery verified existing reply and updated status to replied');
  }

  // =========================================================================
  // Test G: Uncertain Recovery confirms NOT sent -> exactly ONE safe retry allowed
  // =========================================================================
  {
    console.log('--- Case G: Uncertain Recovery Confirms Not Sent ---');
    const taskIdG = 'task_unc_recovery_notsent';
    const commentIdG = 'comment_unc_g';

    commentsRepo.insert({
      steam_comment_id: commentIdG,
      commenter_steam_id: targetSteamId,
      commenter_profile_url: targetProfileUrl,
      content: 'hello G',
      status: 'uncertain_send_state',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    replyTasksRepo.insert({
      task_id: taskIdG,
      steam_comment_id: commentIdG,
      target_steam_id: targetSteamId,
      target_profile_url: targetProfileUrl,
      reply_text: 'Reply to G',
      status: 'uncertain_send_state',
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      attempt_count: 0
    });

    const mockBmG = createMockBrowserManager({
      verificationResult: 'NOT_FOUND'
    });

    const config = {
      STEAM_PROFILE_URL: myProfileUrl,
      DRY_RUN: false,
      HEADLESS: true,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 100,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0
    };

    const scheduler = new TaskScheduler(config, db, mockLogger);
    scheduler.commentSender = new CommentSender(mockBmG, myProfileUrl, mockLogger);

    await scheduler.runUncertainStateRecoveryStep();

    const taskAfter = replyTasksRepo.findByTaskId(taskIdG);
    const commentAfter = commentsRepo.findByCommentId(commentIdG);

    assert.strictEqual(taskAfter.status, 'uncertain_send_state', 'Task must maintain uncertain_send_state to prevent duplicate send');
    assert.strictEqual(commentAfter.status, 'uncertain_send_state', 'Comment must maintain uncertain_send_state');

    // Run recovery again: must strictly maintain uncertain_send_state and zero resend
    await scheduler.runUncertainStateRecoveryStep();
    const taskAfter2 = replyTasksRepo.findByTaskId(taskIdG);
    assert.strictEqual(taskAfter2.status, 'uncertain_send_state', 'Task must remain uncertain_send_state with zero auto-retry');
    console.log('  -> Case G Passed: Uncertain state strictly maintained to prevent duplicate comment');
  }

  // =========================================================================
  // Test H: Successful reply on next polling cycle must NOT duplicate
  // =========================================================================
  {
    console.log('--- Case H: Idempotency Prevention on Next Polling Cycle ---');
    const commentIdH = 'comment_h_duplicate_check';

    // Comment already exists and is marked replied
    commentsRepo.insert({
      steam_comment_id: commentIdH,
      commenter_steam_id: targetSteamId,
      commenter_profile_url: targetProfileUrl,
      content: 'hello H duplicate test',
      status: 'replied',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      replied_at: new Date().toISOString()
    });

    const config = {
      STEAM_PROFILE_URL: myProfileUrl,
      DRY_RUN: false,
      HEADLESS: true,
      MAX_REPLIES_PER_HOUR: 10,
      MAX_REPLIES_PER_DAY: 100,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0
    };

    let sendCalled = false;
    const scheduler = new TaskScheduler(config, db, mockLogger);
    scheduler.commentSender = {
      sendReply: async () => {
        sendCalled = true;
        return { status: 'SUCCESS' };
      }
    };

    // Simulate processComment encountering commentIdH again
    const commentData = {
      commentId: commentIdH,
      commenterName: 'UserH',
      commenterProfileUrl: targetProfileUrl,
      commenterSteamId: targetSteamId,
      content: 'hello H duplicate test'
    };

    await scheduler.processComment(commentData);

    assert.strictEqual(sendCalled, false, 'sendReply must NEVER be called for an already replied comment');
    const existingTask = replyTasksRepo.findByCommentId(commentIdH);
    assert.strictEqual(existingTask, undefined, 'No duplicate reply task should ever be inserted');
    console.log('  -> Case H Passed: Already replied comment on next polling cycle strictly ignored (zero duplicate send)');
  }

  // Cleanup
  try {
    db.close();
  } catch {}
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch {}
  console.log('✅ Passed all 8 Hybrid Comment Sender Lifecycle tests (Cases A-H)!\n');
}

module.exports = { runHybridSenderTests };
if (require.main === module) runHybridSenderTests();
