const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runSafeRetryAndCircuitBreakerTests() {
  console.log('====================================================');
  console.log('  Running Safe Retry & Global Circuit Breaker Tests  ');
  console.log('====================================================\n');

  const { CommentCircuitBreaker } = require('../../dist/scheduler/commentCircuitBreaker');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { Logger } = require('../../dist/utils/logger');
  const { loadConfig } = require('../../dist/config/env');

  const logger = new Logger('test', { quiet: true });
  const testDbPath = path.resolve(__dirname, 'test-retry-circuit-breaker.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);
  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  function clearDb() {
    db.prepare("DELETE FROM reply_tasks").run();
    db.prepare("DELETE FROM comments").run();
  }

  function createScheduler(circuitOptions, skipClear = false) {
    if (!skipClear) clearDb();
    const config = loadConfig();
    config.STEAM_PROFILE_URL = 'https://steamcommunity.com/id/my_bot/';
    config.DRY_RUN = false;
    const scheduler = new TaskScheduler(config, db, logger);
    if (circuitOptions) {
      scheduler.circuitBreaker = new CommentCircuitBreaker(logger, circuitOptions);
    }
    scheduler.sessionState = 'running';
    scheduler.isRunning = true;
    // Mock sessionManager so it doesn't open browser
    scheduler.sessionManager = {
      checkSessionHealth: async () => ({
        valid: true,
        status: 'SESSION_VALID',
        steamId64: '76561198000000001',
        accountName: 'my_bot',
        profileUrl: 'https://steamcommunity.com/id/my_bot/',
        hasSessionIdCookie: true,
        hasSteamLoginSecure: true,
        redirectedToLogin: false,
        reason: null,
        checkedAt: new Date().toISOString()
      }),
      runInteractiveLogin: async () => ({ success: true })
    };
    return scheduler;
  }

  // -------------------------------------------------------------
  // Test 1: CONFIRMED_NOT_SENT -> retry scheduled (delay 2~4m)
  // -------------------------------------------------------------
  console.log('--- TEST 1: CONFIRMED_NOT_SENT -> retry scheduled ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t1';
    const commentId = 'comment_t1';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000001',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
      content: 'hello test 1',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000001',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
      reply_text: 'reply 1',
      status: 'waiting',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    scheduler.commentSender = {
      sendReply: async () => ({
        status: 'FAILED_RETRYABLE',
        postAttempted: false,
        error: 'Navigation timeout before POST',
        confirmationStatus: 'CONFIRMED_NOT_SENT'
      })
    };

    const beforeDispatch = Date.now();
    await scheduler.dispatchPendingRepliesStep();

    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'waiting', 'Task must remain waiting for retry');
    assert.strictEqual(task.attempt_count, 1, 'Attempt count must be incremented to 1');
    const scheduledTime = new Date(task.scheduled_at).getTime();
    const delaySec = Math.round((scheduledTime - beforeDispatch) / 1000);
    assert.strictEqual(delaySec >= 115 && delaySec <= 250, true, `Delay must be 2~4m, got ${delaySec}s`);
    console.log('  -> TEST 1 PASSED: CONFIRMED_NOT_SENT safely scheduled for retry with 2~4m delay.');
  }

  // -------------------------------------------------------------
  // Test 2: CONFIRMED_NOT_SENT -> max 3 attempts total (3rd fail -> failed)
  // -------------------------------------------------------------
  console.log('--- TEST 2: CONFIRMED_NOT_SENT -> max 3 attempts total ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t2';
    const commentId = 'comment_t2';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000002',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
      content: 'hello test 2',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    // Task already attempted twice (attempt_count = 2)
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000002',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
      reply_text: 'reply 2',
      status: 'waiting',
      attempt_count: 2,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'NOT_FOUND',
      sendReply: async () => ({
        status: 'FAILED_RETRYABLE',
        postAttempted: false,
        error: 'Third consecutive navigation timeout',
        confirmationStatus: 'CONFIRMED_NOT_SENT'
      })
    };

    await scheduler.dispatchPendingRepliesStep();

    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'failed', 'Task must be marked failed after 3rd attempt');
    assert.strictEqual(task.attempt_count, 3, 'Attempt count must be 3');
    console.log('  -> TEST 2 PASSED: CONFIRMED_NOT_SENT capped at exactly 3 attempts.');
  }

  // -------------------------------------------------------------
  // Test 3: TRANSIENT_COMMENT_REJECTION -> max 1 retry (initial + 1 retry = 2 total)
  // -------------------------------------------------------------
  console.log('--- TEST 3: TRANSIENT -> max 1 retry ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t3';
    const commentId = 'comment_t3';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000003',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000003',
      content: 'hello test 3',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000003',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000003',
      reply_text: 'reply 3',
      status: 'waiting',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postCalls = 0;
    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'NOT_FOUND',
      sendReply: async () => {
        postCalls++;
        return {
          status: 'TRANSIENT_COMMENT_REJECTION',
          postAttempted: true,
          error: 'Transient steam rejection',
          confirmationStatus: 'TRANSIENT_COMMENT_REJECTION'
        };
      }
    };

    // Attempt 1: fails with TRANSIENT -> scheduled for 1 retry
    const beforeA1 = Date.now();
    await scheduler.dispatchPendingRepliesStep();
    const taskAfterA1 = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(taskAfterA1.status, 'waiting', 'Attempt 1 TRANSIENT must be scheduled waiting for retry');
    assert.strictEqual(taskAfterA1.attempt_count, 1, 'Attempt count must be 1');
    const scheduledA1 = new Date(taskAfterA1.scheduled_at).getTime();
    const delayA1Sec = Math.round((scheduledA1 - beforeA1) / 1000);
    assert.strictEqual(delayA1Sec >= 295 && delayA1Sec <= 610, true, `Delay must be 5~10m, got ${delayA1Sec}s`);

    // Simulate delay expired for Attempt 2 (the 1 allowed retry)
    replyTasksRepo.updateStatus(taskId, 'waiting', { scheduled_at: new Date(Date.now() - 1000).toISOString() });
    await scheduler.dispatchPendingRepliesStep();

    const taskAfterA2 = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(taskAfterA2.status, 'failed', 'Attempt 2 TRANSIENT failure must permanently fail (max 1 retry)');
    assert.strictEqual(taskAfterA2.attempt_count, 2, 'Attempt count capped at 2');
    assert.strictEqual(postCalls, 2, 'Total POST calls must strictly equal 2');
    console.log('  -> TEST 3 PASSED: TRANSIENT_COMMENT_REJECTION permits strictly 1 retry (2 POSTs max).');
  }

  // -------------------------------------------------------------
  // Test 4: TRANSIENT -> retry pre-check finds own comment -> mark replied, NO POST
  // -------------------------------------------------------------
  console.log('--- TEST 4: TRANSIENT -> retry pre-check finds own comment -> mark replied ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t4';
    const commentId = 'comment_t4';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000004',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000004',
      content: 'hello test 4',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000004',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000004',
      reply_text: 'reply 4',
      status: 'waiting',
      attempt_count: 1, // Ready for retry
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'FOUND',
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'Pre-check found comment: must NEVER dispatch POST!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'replied', 'Task marked replied');
    console.log('  -> TEST 4 PASSED: Retry pre-check found existing comment, marked replied with 0 duplicate POST.');
  }

  // -------------------------------------------------------------
  // Test 5: TRANSIENT -> retry pre-check finds moderation -> submitted_moderation_pending, NO POST
  // -------------------------------------------------------------
  console.log('--- TEST 5: TRANSIENT -> retry pre-check finds moderation -> submitted_moderation_pending ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t5';
    const commentId = 'comment_t5';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000005',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000005',
      content: 'hello test 5',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000005',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000005',
      reply_text: 'reply 5',
      status: 'waiting',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'MODERATION_PENDING',
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'Pre-check found moderation: must NEVER dispatch POST!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'submitted_moderation_pending', 'Task marked submitted_moderation_pending');
    console.log('  -> TEST 5 PASSED: Retry pre-check found moderation pending, safely transitioned without POST.');
  }

  // -------------------------------------------------------------
  // Test 6: TRANSIENT -> retry pre-check finds restriction -> failed, NO POST
  // -------------------------------------------------------------
  console.log('--- TEST 6: TRANSIENT -> retry pre-check finds restriction -> failed ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t6';
    const commentId = 'comment_t6';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000006',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000006',
      content: 'hello test 6',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000006',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000006',
      reply_text: 'reply 6',
      status: 'waiting',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'RESTRICTED',
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'Pre-check found restriction: must NEVER dispatch POST!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'failed', 'Task marked failed');
    console.log('  -> TEST 6 PASSED: Retry pre-check found restriction, marked failed without POST.');
  }

  // -------------------------------------------------------------
  // Test 7: TRANSIENT -> retry pre-check page error/timeout -> uncertain_send_state, NO POST
  // -------------------------------------------------------------
  console.log('--- TEST 7: TRANSIENT -> retry pre-check page error/timeout -> UNCERTAIN ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t7';
    const commentId = 'comment_t7';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000007',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000007',
      content: 'hello test 7',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000007',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000007',
      reply_text: 'reply 7',
      status: 'waiting',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      checkTargetProfileForExistingComment: async () => 'UNCERTAIN',
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'Pre-check uncertain: must NEVER dispatch POST!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'uncertain_send_state', 'Task protected as uncertain_send_state');
    console.log('  -> TEST 7 PASSED: Pre-check error cleanly mapped to uncertain_send_state with 0 POST.');
  }

  // -------------------------------------------------------------
  // Test 8: UNCERTAIN -> NEVER auto-retried
  // -------------------------------------------------------------
  console.log('--- TEST 8: UNCERTAIN -> NEVER auto-retried ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t8';
    const commentId = 'comment_t8';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000008',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000008',
      content: 'hello test 8',
      status: 'uncertain_send_state',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000008',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000008',
      reply_text: 'reply 8',
      status: 'uncertain_send_state',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'UNCERTAIN task must NEVER be dispatched!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'uncertain_send_state', 'Status unchanged');
    console.log('  -> TEST 8 PASSED: UNCERTAIN status strictly protected against auto-retry.');
  }

  // -------------------------------------------------------------
  // Test 9: CONFIRMED_SENT -> NEVER auto-retried
  // -------------------------------------------------------------
  console.log('--- TEST 9: CONFIRMED_SENT -> NEVER auto-retried ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t9';
    const commentId = 'comment_t9';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000009',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000009',
      content: 'hello test 9',
      status: 'replied',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000009',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000009',
      reply_text: 'reply 9',
      status: 'replied',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();
    assert.strictEqual(postDispatched, false, 'CONFIRMED_SENT task must never be resent!');
    console.log('  -> TEST 9 PASSED: CONFIRMED_SENT never retried.');
  }

  // -------------------------------------------------------------
  // Test 10: MODERATION_PENDING -> NEVER auto-retried
  // -------------------------------------------------------------
  console.log('--- TEST 10: MODERATION_PENDING -> NEVER auto-retried ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t10';
    const commentId = 'comment_t10';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000010',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000010',
      content: 'hello test 10',
      status: 'submitted_moderation_pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000010',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000010',
      reply_text: 'reply 10',
      status: 'submitted_moderation_pending',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();
    assert.strictEqual(postDispatched, false, 'MODERATION_PENDING must never be retried via send dispatch!');
    console.log('  -> TEST 10 PASSED: MODERATION_PENDING never retried.');
  }

  // -------------------------------------------------------------
  // Test 11: TARGET_REJECTION_CONFIRMED -> NEVER auto-retried
  // -------------------------------------------------------------
  console.log('--- TEST 11: TARGET_REJECTION_CONFIRMED -> NEVER auto-retried ---');
  {
    const scheduler = createScheduler();
    const taskId = 'task_t11';
    const commentId = 'comment_t11';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000011',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000011',
      content: 'hello test 11',
      status: 'failed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000011',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000011',
      reply_text: 'reply 11',
      status: 'failed',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let postDispatched = false;
    scheduler.commentSender = {
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS', postAttempted: true };
      }
    };

    await scheduler.dispatchPendingRepliesStep();
    assert.strictEqual(postDispatched, false, 'failed task must never be retried!');
    console.log('  -> TEST 11 PASSED: TARGET_REJECTION_CONFIRMED never retried.');
  }

  // -------------------------------------------------------------
  // Test 12: 连续两个不同目标 TRANSIENT -> Circuit Breaker OPEN
  // -------------------------------------------------------------
  console.log('--- TEST 12: 连续两个不同目标 TRANSIENT -> Circuit Breaker OPEN ---');
  {
    const cb = new CommentCircuitBreaker(logger, { minCooldownMs: 15 * 60 * 1000, maxCooldownMs: 30 * 60 * 1000 });
    assert.strictEqual(cb.isClosed(), true, 'Initial state must be CLOSED');

    cb.recordTransientRejection('76561198000000001', 'task_1');
    assert.strictEqual(cb.isClosed(), true, 'First target transient must keep CLOSED');

    cb.recordTransientRejection('76561198000000002', 'task_2');
    assert.strictEqual(cb.isOpen(), true, 'Second distinct target transient must trip to OPEN');
    assert.strictEqual(cb.getCooldownUntil() > Date.now(), true, 'Cooldown timestamp must be in future');
    console.log('  -> TEST 12 PASSED: 2 distinct SteamIDs with TRANSIENT tripped Circuit Breaker to OPEN.');
  }

  // -------------------------------------------------------------
  // Test 13: Circuit Breaker OPEN -> does NOT consume attempt_count, does NOT fail tasks
  // -------------------------------------------------------------
  console.log('--- TEST 13: Circuit Breaker OPEN -> preserves attempt_count & does NOT fail tasks ---');
  {
    const scheduler = createScheduler();
    scheduler.circuitBreaker.tripToOpen('task_t13', '76561198000000013', 0, 'TEST_MANUAL_TRIP');

    const taskId = 'task_t13';
    const commentId = 'comment_t13';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000013',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000013',
      content: 'hello test 13',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000013',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000013',
      reply_text: 'reply 13',
      status: 'waiting',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    let sendCalled = false;
    scheduler.commentSender = {
      sendReply: async () => {
        sendCalled = true;
        return { status: 'SUCCESS' };
      }
    };

    await scheduler.dispatchPendingRepliesStep();

    assert.strictEqual(sendCalled, false, 'Dispatch must be halted while Circuit Breaker is OPEN');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'waiting', 'Task must remain waiting');
    assert.strictEqual(task.attempt_count, 0, 'Task attempt count must NOT be incremented');
    console.log('  -> TEST 13 PASSED: OPEN breaker cleanly halted queue without consuming attempt_count.');
  }

  // -------------------------------------------------------------
  // Test 14: Cooldown expiration -> transitions to HALF_OPEN
  // -------------------------------------------------------------
  console.log('--- TEST 14: Cooldown expiration -> transitions to HALF_OPEN ---');
  {
    // Configure small cooldown for test
    const cb = new CommentCircuitBreaker(logger, { minCooldownMs: 20, maxCooldownMs: 50 });
    cb.recordTransientRejection('76561198000000001');
    cb.recordTransientRejection('76561198000000002');
    assert.strictEqual(cb.isOpen(), true);

    await new Promise(resolve => setTimeout(resolve, 70));
    assert.strictEqual(cb.isHalfOpen(), true, 'Breaker must transition to HALF_OPEN after cooldown expires');
    console.log('  -> TEST 14 PASSED: Cooldown expiration transitions to HALF_OPEN.');
  }

  // -------------------------------------------------------------
  // Test 15: Successful probe send in HALF_OPEN -> closes Circuit Breaker (CLOSED)
  // -------------------------------------------------------------
  console.log('--- TEST 15: Successful probe send in HALF_OPEN -> closes Circuit Breaker ---');
  {
    const cb = new CommentCircuitBreaker(logger, { minCooldownMs: 10, maxCooldownMs: 20 });
    cb.recordTransientRejection('76561198000000001');
    cb.recordTransientRejection('76561198000000002');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(cb.isHalfOpen(), true);

    cb.recordSuccess();
    assert.strictEqual(cb.isClosed(), true, 'Successful probe send must reset breaker to CLOSED');
    console.log('  -> TEST 15 PASSED: Success in HALF_OPEN resets breaker to CLOSED.');
  }

  // -------------------------------------------------------------
  // Test 16: Same SteamID repeated TRANSIENT does NOT trip cross-target Circuit Breaker
  // -------------------------------------------------------------
  console.log('--- TEST 16: Same SteamID repeated TRANSIENT does NOT trip cross-target Breaker ---');
  {
    const cb = new CommentCircuitBreaker(logger);
    const sameSteamId = '76561198999999999';

    cb.recordTransientRejection(sameSteamId, 'task_a');
    cb.recordTransientRejection(sameSteamId, 'task_b');
    cb.recordTransientRejection(sameSteamId, 'task_c');

    assert.strictEqual(cb.isClosed(), true, 'Same target SteamID must NOT trip global circuit breaker');
    console.log('  -> TEST 16 PASSED: Same SteamID repeated rejections do not trip cross-target breaker.');
  }

  // -------------------------------------------------------------
  // Test 17: Different SteamIDs required to trip cross-target threshold
  // -------------------------------------------------------------
  console.log('--- TEST 17: Different SteamIDs required to trip cross-target threshold ---');
  {
    const cb = new CommentCircuitBreaker(logger);
    cb.recordTransientRejection('76561198111111111');
    assert.strictEqual(cb.isClosed(), true);

    // Another event from same ID
    cb.recordTransientRejection('76561198111111111');
    assert.strictEqual(cb.isClosed(), true);

    // Finally an event from a different ID
    cb.recordTransientRejection('76561198222222222');
    assert.strictEqual(cb.isOpen(), true, 'Trips only when second target is distinct');
    console.log('  -> TEST 17 PASSED: Different SteamID strictly required to trip breaker.');
  }

  // -------------------------------------------------------------
  // Test 18: Restart preserves uncertain_send_state and NEVER blindly auto-resends
  // -------------------------------------------------------------
  console.log('--- TEST 18: Restart preserves uncertain_send_state and NEVER blindly auto-resends ---');
  {
    clearDb();
    const taskId = 'task_t18';
    const commentId = 'comment_t18';
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000018',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000018',
      content: 'hello test 18',
      status: 'uncertain_send_state',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: commentId,
      target_steam_id: '76561198000000018',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000018',
      reply_text: 'reply 18',
      status: 'uncertain_send_state',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 5000).toISOString(),
      created_at: new Date().toISOString()
    });

    // Simulate complete process restart: instantiate new scheduler instance without wiping DB
    const restartedScheduler = createScheduler(null, true);
    let postDispatched = false;
    restartedScheduler.commentSender = {
      sendReply: async () => {
        postDispatched = true;
        return { status: 'SUCCESS' };
      }
    };

    await restartedScheduler.dispatchPendingRepliesStep();

    assert.strictEqual(postDispatched, false, 'Restarted scheduler must NEVER auto-resend uncertain task!');
    const task = replyTasksRepo.findByTaskId(taskId);
    assert.strictEqual(task.status, 'uncertain_send_state', 'Task remains strictly uncertain_send_state');
    console.log('  -> TEST 18 PASSED: Restart preserved uncertain_send_state with 0 blind re-sends.');
  }

  console.log('\n====================================================');
  console.log('  All 18 Safe Retry & Circuit Breaker Tests PASSED!  ');
  console.log('====================================================\n');
}

if (require.main === module) {
  runSafeRetryAndCircuitBreakerTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Test Failed:', err);
      process.exit(1);
    });
}

module.exports = { runSafeRetryAndCircuitBreakerTests };
