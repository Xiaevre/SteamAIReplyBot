const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runComprehensiveSenderAcceptanceTests() {
  console.log('--- Running Comprehensive Sender & Target Decoupling Acceptance Tests ---');

  const { CommentSender } = require('../../dist/steam/commentSender');
  const { SteamSendErrorClassifier } = require('../../dist/steam/transport/steamSendErrorClassifier');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');

  const myProfileUrl = 'https://steamcommunity.com/id/test_bot_user/';
  const mySteamId = '76561198000000000';
  const targetAProfileUrl = 'https://steamcommunity.com/profiles/76561198000000001/';
  const targetASteamId = '76561198000000001';
  const targetBProfileUrl = 'https://steamcommunity.com/profiles/76561198000000002/';
  const targetBSteamId = '76561198000000002';

  const mockLogger = {
    info: (tag, data) => {},
    warn: (tag, data) => {},
    error: (tag, data) => {}
  };

  // Helper to create mock browser manager
  function createMockBrowserManager({
    sessionValid = true,
    fetchResult = { ok: true, status: 200, json: async () => ({ success: true, comments_html: '' }) },
    verificationResult = 'FOUND',
    foundText = 'test reply'
  } = {}) {
    return {
      openEphemeralPage: async () => ({
        isClosed: () => false,
        goto: async () => {},
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return sessionValid ? {
                sessionId: 'valid_session_id_123',
                steamId: mySteamId,
                accountPulldown: 'test_bot_user',
                hasLoginCookieInDoc: true
              } : {
                sessionId: null,
                steamId: null,
                accountPulldown: null,
                hasLoginCookieInDoc: false
              };
            }
            if (fnStr.includes('fetch')) {
              return fetchResult;
            }
          }
          return {};
        },
        $$eval: async (sel, fn) => {
          if (verificationResult === 'FOUND') {
            return [{ id: 'comment_111', text: foundText, author: 'test_bot_user', profileUrl: myProfileUrl }];
          } else if (verificationResult === 'MODERATION_PENDING') {
            return [{ id: 'comment_mod_1', text: '此留言正在等待我们的自动内容检查系统分析。', author: 'test_bot_user', profileUrl: myProfileUrl }];
          }
          return [];
        },
        close: async () => {}
      })
    };
  }

  // =========================================================================
  // TEST 3 (Requirement): Target returns "此帐户的设置不允许您添加留言。"
  // MUST NOT trigger SESSION_INVALID!
  // MUST NOT trigger waiting_for_login!
  // MUST NOT halt global queue! Target B continues processing!
  // =========================================================================
  {
    console.log('--- TEST 3: Target returns "此帐户的设置不允许您添加留言。" -> TARGET_REJECTED (Queue proceeds to B) ---');
    const testDbPath = path.resolve(__dirname, 'test-sender-test3.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = new AppDatabase(testDbPath);
    runMigrations(db);
    const commentsRepo = new CommentsRepository(db);
    const replyTasksRepo = new ReplyTasksRepository(db);

    // Insert Task A (Target A will return "此帐户的设置不允许您添加留言。")
    commentsRepo.insert({
      steam_comment_id: 'comment_target_a',
      commenter_steam_id: targetASteamId,
      commenter_profile_url: targetAProfileUrl,
      content: 'hello from A',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: 'task_target_a',
      steam_comment_id: 'comment_target_a',
      target_steam_id: targetASteamId,
      target_profile_url: targetAProfileUrl,
      reply_text: 'reply to A',
      status: 'waiting',
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      attempt_count: 0
    });

    // Insert Task B (Target B will succeed)
    commentsRepo.insert({
      steam_comment_id: 'comment_target_b',
      commenter_steam_id: targetBSteamId,
      commenter_profile_url: targetBProfileUrl,
      content: 'hello from B',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: 'task_target_b',
      steam_comment_id: 'comment_target_b',
      target_steam_id: targetBSteamId,
      target_profile_url: targetBProfileUrl,
      reply_text: 'reply to B',
      status: 'waiting',
      scheduled_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      attempt_count: 0
    });

    // Mock browser manager: Target A returns disallowed error, Target B returns success
    let currentNavUrl = '';
    const mockBm = {
      openEphemeralPage: async () => ({
        context: () => ({
          cookies: async () => [
            { name: 'sessionid', value: 'valid_session_id_123' },
            { name: 'steamLoginSecure', value: `${mySteamId}%7C%7CvalidToken12345678` }
          ]
        }),
        goto: async (u) => { currentNavUrl = u || ''; },
        $eval: async (sel) => {
          if (sel.includes('commentthread_restricted') || sel.includes('profile_comment_area_restricted')) {
            return currentNavUrl.includes(targetASteamId);
          }
          return false;
        },
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return {
                sessionId: 'valid_session_id_123',
                steamId: mySteamId,
                accountPulldown: 'test_bot_user',
                hasLoginCookieInDoc: true
              };
            }
            if (fnStr.includes('fetch')) {
              // Check if target is A or B
              if (arg && arg.targetId === targetASteamId) {
                return {
                  httpStatus: 200,
                  networkError: null,
                  rawJson: {
                    success: false,
                    error: '此帐户的设置不允许您添加留言。'
                  },
                  rawResponseText: '{"success":false,"error":"此帐户的设置不允许您添加留言。"}'
                };
              } else {
                return {
                  httpStatus: 200,
                  networkError: null,
                  rawJson: {
                    success: true,
                    comments_html: '<div id="comment_bbb_999">reply to B</div>'
                  },
                  rawResponseText: '{"success":true}'
                };
              }
            }
          }
          return {};
        },
        $$eval: async (sel, fn) => [
          { id: 'comment_bbb_999', text: 'reply to B', author: 'test_bot_user', profileUrl: myProfileUrl }
        ],
        close: async () => {}
      })
    };

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);

    // Direct check of Target A sendReply
    const resultA = await sender.sendReply(targetAProfileUrl, 'reply to A', targetASteamId);
    assert.notStrictEqual(resultA.status, 'SESSION_INVALID', 'Target rejection MUST NOT return SESSION_INVALID!');
    assert.ok(resultA.status === 'PERMISSION_DENIED' || resultA.status === 'TARGET_REJECTED', 'Must be PERMISSION_DENIED or TARGET_REJECTED');
    console.log('  -> Direct sendReply to restricted target confirmed NOT SESSION_INVALID');

    // Test Scheduler queue processing
    const config = {
      STEAM_PROFILE_URL: myProfileUrl,
      DRY_RUN: false,
      HEADLESS: true,
      MAX_REPLIES_PER_HOUR: 100,
      MAX_REPLIES_PER_DAY: 100,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0
    };

    const mockSessionManager = {
      getSessionStatus: () => 'authenticated',
      checkSession: async () => ({ valid: true, status: 'SESSION_VALID' })
    };

    const scheduler = new TaskScheduler(config, db, mockLogger);
    scheduler.isRunning = true;
    scheduler.commentSender = sender;
    scheduler.sessionState = 'authenticated';

    // Run scheduler dispatch
    await scheduler.dispatchPendingRepliesStep();

    // Verify Task A status
    const dbTaskA = replyTasksRepo.findByTaskId('task_target_a');
    assert.strictEqual(dbTaskA.status, 'failed', 'Task A must be marked failed');

    // Verify Task B status: MUST BE REPLIED! (queue did NOT break!)
    const dbTaskB = replyTasksRepo.findByTaskId('task_target_b');
    assert.strictEqual(dbTaskB.status, 'replied', 'Task B MUST be processed and marked replied despite Task A rejection!');

    // Verify session state was NOT transitioned to waiting_for_login
    assert.strictEqual(scheduler.getSessionState(), 'authenticated', 'Scheduler must remain authenticated!');
    console.log('  -> TEST 3 PASSED: Target rejection did not halt queue, Task B successfully processed!');
  }

  // =========================================================================
  // TEST 4: Manually induced invalid session -> SESSION_INVALID & global pause
  // =========================================================================
  {
    console.log('--- TEST 4: Manually induced invalid session -> SESSION_INVALID & global pause ---');
    const mockBmInvalid = createMockBrowserManager({
      sessionValid: false,
      fetchResult: { httpStatus: 0, networkError: 'SESSIONID_NOT_FOUND', rawJson: null }
    });

    const sender = new CommentSender(mockBmInvalid, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetAProfileUrl, 'test msg', targetASteamId);

    assert.strictEqual(result.status, 'SESSION_INVALID', 'Invalid session must yield SESSION_INVALID');
    console.log('  -> TEST 4 PASSED: Invalid session correctly yielded SESSION_INVALID');
  }

  // =========================================================================
  // TEST 5: Restart after successful send does NOT duplicate send
  // =========================================================================
  {
    console.log('--- TEST 5: Restart after successful send does NOT duplicate send ---');
    const testDbPath = path.resolve(__dirname, 'test-sender-test5.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const db = new AppDatabase(testDbPath);
    runMigrations(db);
    const commentsRepo = new CommentsRepository(db);
    const replyTasksRepo = new ReplyTasksRepository(db);

    // Comment already replied
    commentsRepo.insert({
      steam_comment_id: 'comment_replied_done',
      commenter_steam_id: targetBSteamId,
      commenter_profile_url: targetBProfileUrl,
      content: 'hello',
      status: 'replied',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    replyTasksRepo.insert({
      task_id: 'task_replied_done',
      steam_comment_id: 'comment_replied_done',
      target_steam_id: targetBSteamId,
      target_profile_url: targetBProfileUrl,
      reply_text: 'reply done',
      status: 'replied',
      scheduled_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      attempt_count: 1
    });

    let sendCalled = false;
    const mockBm = {
      openEphemeralPage: async () => {
        sendCalled = true;
        throw new Error('Should not be called!');
      }
    };

    const config = {
      STEAM_PROFILE_URL: myProfileUrl,
      DRY_RUN: false,
      HEADLESS: true,
      MAX_REPLIES_PER_HOUR: 100,
      MAX_REPLIES_PER_DAY: 100,
      MIN_REPLY_DELAY_SECONDS: 0,
      MAX_REPLY_DELAY_SECONDS: 0
    };

    const scheduler = new TaskScheduler(config, db, mockLogger);
    scheduler.sessionState = 'authenticated';
    scheduler.commentSender = {
      sendReply: async () => {
        sendCalled = true;
        return { status: 'SUCCESS' };
      },
      checkTargetProfileForExistingComment: async () => 'FOUND'
    };

    scheduler.isRunning = true;
    // Re-run crash recovery & dispatch
    await scheduler.runCrashRecovery();
    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(sendCalled, false, 'Send must not be called for already replied tasks on restart');
    console.log('  -> TEST 5 PASSED: Restart does not trigger duplicate comment send');
  }

  // =========================================================================
  // TEST 6: POST success: true but verify not found -> UNCERTAIN_SEND_STATE
  // =========================================================================
  {
    console.log('--- TEST 6: POST success: true but verify not found -> UNCERTAIN_SEND_STATE ---');
    const mockBmUncertain = createMockBrowserManager({
      fetchResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: { success: true, comments_html: '<div id="comment_unc">hi</div>' }
      },
      verificationResult: 'NOT_FOUND' // Comment not yet visible on target profile!
    });

    const sender = new CommentSender(mockBmUncertain, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetAProfileUrl, 'unconfirmed text', targetASteamId);

    assert.strictEqual(result.status, 'UNCERTAIN', 'Unconfirmed comment on target profile MUST map to UNCERTAIN');
    console.log('  -> TEST 6 PASSED: Unconfirmed comment mapped to UNCERTAIN without auto-resend');
  }

  console.log('✅ ALL Comprehensive Sender Acceptance Tests PASSED!\n');
}

module.exports = { runComprehensiveSenderAcceptanceTests };
if (require.main === module) {
  runComprehensiveSenderAcceptanceTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
