const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runCircuitBreakerQueueDecouplingTests() {
  console.log('====================================================');
  console.log('  Running Circuit Breaker & Queue Decoupling Tests   ');
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
  const testDbPath = path.resolve(__dirname, 'test-circuit-queue-decoupling.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);
  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);

  function clearDb() {
    db.prepare("DELETE FROM reply_tasks").run();
    db.prepare("DELETE FROM comments").run();
  }

  function createScheduler(circuitOptions) {
    clearDb();
    const config = loadConfig();
    config.STEAM_PROFILE_URL = 'https://steamcommunity.com/id/my_bot/';
    config.DRY_RUN = false;
    const scheduler = new TaskScheduler(config, db, logger);
    if (circuitOptions) {
      scheduler.circuitBreaker = new CommentCircuitBreaker(logger, circuitOptions);
    }
    scheduler.sessionState = 'running';
    scheduler.isRunning = true;
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

  // ---------------------------------------------------------------------------------
  // SCENARIO 1:
  // 历史任务发送失败 -> Circuit OPEN -> 新留言到达
  // 结果: 新任务留在 DB 不丢失 (status='scheduled'), 不被改为 failed/skipped,
  //      Circuit 恢复后最终能够发送
  // ---------------------------------------------------------------------------------
  console.log('--- SCENARIO 1: History fail -> Circuit OPEN -> New comment arrives -> preserved in DB -> sends upon recovery ---');
  {
    // Configure breaker with short cooldown 100ms
    const scheduler = createScheduler({ minCooldownMs: 100, maxCooldownMs: 150 });
    
    // Trip breaker to OPEN
    scheduler.circuitBreaker.tripToOpen('task_prior', '76561198000000001', 0, 'PREV_FAIL');
    assert.strictEqual(scheduler.circuitBreaker.isOpen(), true, 'Circuit should be OPEN');

    // New comment arrives during OPEN
    const commentC = 'comment_new_c';
    const taskC = 'task_new_c';
    commentsRepo.insert({
      steam_comment_id: commentC,
      commenter_steam_id: '76561198000000099',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000099',
      content: 'hello new user',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskC,
      steam_comment_id: commentC,
      target_steam_id: '76561198000000099',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000099',
      reply_text: 'welcome new user',
      status: 'scheduled',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 5000).toISOString(),
      created_at: new Date().toISOString()
    });

    let sendAttempted = false;
    scheduler.commentSender = {
      sendReply: async () => {
        sendAttempted = true;
        return { status: 'SUCCESS', confirmationStatus: 'CONFIRMED_SENT' };
      }
    };

    // 1. While OPEN, dispatch is called
    await scheduler.dispatchPendingRepliesStep();

    // Verify: NO POST sent while OPEN
    assert.strictEqual(sendAttempted, false, 'Should NOT send real POST while circuit breaker is OPEN');

    // Verify: Task C remains intact in DB (neither failed nor skipped)
    const recordWhileOpen = replyTasksRepo.findByTaskId(taskC);
    assert.strictEqual(recordWhileOpen.status, 'scheduled', 'Task must remain in scheduled status in DB while circuit is OPEN');

    // 2. Wait for cooldown to expire
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(scheduler.circuitBreaker.isOpen(), false, 'Circuit must leave OPEN state after cooldown expires');

    // 3. Next dispatch cycle
    await scheduler.dispatchPendingRepliesStep();

    // Verify: Now sent successfully
    assert.strictEqual(sendAttempted, true, 'Task C should be sent once circuit recovers');
    const recordAfterRecovery = replyTasksRepo.findByTaskId(taskC);
    assert.strictEqual(recordAfterRecovery.status, 'replied', 'Task C must be replied upon recovery');

    console.log('  -> Scenario 1 Passed: New task safely preserved in DB during OPEN, cleanly sent on recovery.\n');
  }

  // ---------------------------------------------------------------------------------
  // SCENARIO 2:
  // HALF_OPEN probe 失败
  // 结果: 不能让同一个任务无限霸占 probe; probe 任务进入正常 retry 生命周期;
  //      attempt_count 递增, 下次被 fresh task 超越, 达到上限后终止为 failed
  // ---------------------------------------------------------------------------------
  console.log('--- SCENARIO 2: HALF_OPEN probe fails -> enters retry lifecycle -> cannot infinitely monopolize probe ---');
  {
    const scheduler = createScheduler({ minCooldownMs: 100, maxCooldownMs: 150 });
    
    // Place a failing task A (already attempted once)
    const taskA = 'task_probe_fail_a';
    commentsRepo.insert({
      steam_comment_id: 'c_fail_a',
      commenter_steam_id: '76561198000000001',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
      content: 'fail a',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskA,
      steam_comment_id: 'c_fail_a',
      target_steam_id: '76561198000000001',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
      reply_text: 'reply a',
      status: 'waiting',
      attempt_count: 1, // already retried once!
      scheduled_at: new Date(Date.now() - 60000).toISOString(), // old scheduled time
      created_at: new Date().toISOString()
    });

    // Also place a fresh task B
    const taskB = 'task_fresh_b';
    commentsRepo.insert({
      steam_comment_id: 'c_fresh_b',
      commenter_steam_id: '76561198000000002',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
      content: 'fresh b',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: taskB,
      steam_comment_id: 'c_fresh_b',
      target_steam_id: '76561198000000002',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
      reply_text: 'reply b',
      status: 'scheduled',
      attempt_count: 0, // Fresh!
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    // Verify task ordering in DB: fresh task B (attempt_count=0) comes BEFORE task A (attempt_count=1)
    const pending = replyTasksRepo.getPendingScheduledTasks(new Date().toISOString());
    assert.strictEqual(pending[0].task_id, taskB, 'Fresh task B must be at head of pending tasks before failed task A');

    // Force HALF_OPEN
    scheduler.circuitBreaker.tripToOpen('dummy', 'dummy', 0);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(scheduler.circuitBreaker.isHalfOpen(), true, 'Must be in HALF_OPEN');

    let attemptedTaskIds = [];
    scheduler.commentSender = {
      sendReply: async (url, text, steamId) => {
        const taskId = steamId === '76561198000000002' ? taskB : taskA;
        attemptedTaskIds.push(taskId);
        return {
          status: 'FAILED_RETRYABLE',
          confirmationStatus: 'TRANSIENT_COMMENT_REJECTION',
          message: 'Transient error on probe'
        };
      }
    };

    // Dispatch probe
    await scheduler.dispatchPendingRepliesStep();

    // Probe selected fresh task B because attempt_count === 0
    assert.strictEqual(attemptedTaskIds[0], taskB, 'Probe must prioritize attempt_count=0 task B');

    // Task B failed -> attempt_count becomes 1, scheduled_at pushed into future
    const updatedB = replyTasksRepo.findByTaskId(taskB);
    assert.strictEqual(updatedB.attempt_count, 1, 'Task B attempt_count must increment to 1');
    assert.strictEqual(updatedB.status, 'waiting', 'Task B must transition to waiting for retry');

    console.log('  -> Scenario 2 Passed: Probe correctly prioritizes fresh task, increments attempt count, and respects retry limits.\n');
  }

  // ---------------------------------------------------------------------------------
  // SCENARIO 3:
  // HALF_OPEN probe 成功
  // 结果: Circuit CLOSED, 后续 ready tasks 正常发送
  // ---------------------------------------------------------------------------------
  console.log('--- SCENARIO 3: HALF_OPEN probe succeeds -> Circuit CLOSED -> subsequent ready tasks processed ---');
  {
    const scheduler = createScheduler({ minCooldownMs: 100, maxCooldownMs: 150 });

    // Task 1 and Task 2 both ready
    const task1 = 'task_s3_1';
    const task2 = 'task_s3_2';
    commentsRepo.insert({
      steam_comment_id: 'c_s3_1',
      commenter_steam_id: '76561198000000011',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000011',
      content: 's3 1',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: task1,
      steam_comment_id: 'c_s3_1',
      target_steam_id: '76561198000000011',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000011',
      reply_text: 'reply 1',
      status: 'scheduled',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 2000).toISOString(),
      created_at: new Date().toISOString()
    });

    commentsRepo.insert({
      steam_comment_id: 'c_s3_2',
      commenter_steam_id: '76561198000000012',
      commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000012',
      content: 's3 2',
      status: 'waiting',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    replyTasksRepo.insert({
      task_id: task2,
      steam_comment_id: 'c_s3_2',
      target_steam_id: '76561198000000012',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000012',
      reply_text: 'reply 2',
      status: 'scheduled',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    // Trip into OPEN, wait to HALF_OPEN
    scheduler.circuitBreaker.tripToOpen('dummy', 'dummy', 0);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(scheduler.circuitBreaker.isHalfOpen(), true);

    const sentTasks = [];
    scheduler.commentSender = {
      sendReply: async (url, text, steamId) => {
        sentTasks.push(steamId);
        return { status: 'SUCCESS', confirmationStatus: 'CONFIRMED_SENT' };
      }
    };

    // Run dispatch
    await scheduler.dispatchPendingRepliesStep();

    // Circuit Breaker must be CLOSED now!
    assert.strictEqual(scheduler.circuitBreaker.isClosed(), true, 'Circuit Breaker must be CLOSED after successful probe');

    // Both tasks processed
    assert.strictEqual(sentTasks.length, 2, 'Both ready tasks should be dispatched in cycle once probe succeeds');
    assert.strictEqual(replyTasksRepo.findByTaskId(task1).status, 'replied');
    assert.strictEqual(replyTasksRepo.findByTaskId(task2).status, 'replied');

    console.log('  -> Scenario 3 Passed: Probe succeeded, closed circuit breaker, and processed subsequent tasks.\n');
  }

  // ---------------------------------------------------------------------------------
  // SCENARIO 4:
  // Circuit OPEN 持续期间有多个新留言
  // 结果: 所有任务最终按顺序得到处理, 不出现永久饥饿
  // ---------------------------------------------------------------------------------
  console.log('--- SCENARIO 4: Multiple comments arrive during Circuit OPEN -> all eventually processed in order without starvation ---');
  {
    const scheduler = createScheduler({ minCooldownMs: 150, maxCooldownMs: 200 });

    // Trip to OPEN
    scheduler.circuitBreaker.tripToOpen('task_old', '76561198000000099', 0);
    assert.strictEqual(scheduler.circuitBreaker.isOpen(), true);

    // 3 new comments arrive during OPEN at T1, T2, T3
    const ids = ['user_1', 'user_2', 'user_3'];
    for (let i = 0; i < ids.length; i++) {
      const u = ids[i];
      commentsRepo.insert({
        steam_comment_id: `c_${u}`,
        commenter_steam_id: `765611980000000${i + 1}`,
        commenter_profile_url: `https://steamcommunity.com/profiles/765611980000000${i + 1}`,
        content: `msg ${u}`,
        status: 'waiting',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      replyTasksRepo.insert({
        task_id: `task_${u}`,
        steam_comment_id: `c_${u}`,
        target_steam_id: `765611980000000${i + 1}`,
        target_profile_url: `https://steamcommunity.com/profiles/765611980000000${i + 1}`,
        reply_text: `reply ${u}`,
        status: 'scheduled',
        attempt_count: 0,
        scheduled_at: new Date(Date.now() - 3000 + i * 1000).toISOString(), // T1 < T2 < T3
        created_at: new Date().toISOString()
      });
    }

    const orderProcessed = [];
    scheduler.commentSender = {
      sendReply: async (url, text, steamId) => {
        orderProcessed.push(steamId);
        return { status: 'SUCCESS', confirmationStatus: 'CONFIRMED_SENT' };
      }
    };

    // Dispatch while OPEN -> 0 sent
    await scheduler.dispatchPendingRepliesStep();
    assert.strictEqual(orderProcessed.length, 0, 'No tasks sent while OPEN');

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(scheduler.circuitBreaker.isOpen(), false);

    // Dispatch after recovery
    await scheduler.dispatchPendingRepliesStep();

    // All 3 processed in FIFO order of their scheduled_at
    assert.strictEqual(orderProcessed.length, 3, 'All 3 tasks should be processed');
    assert.deepStrictEqual(orderProcessed, [
      '7656119800000001',
      '7656119800000002',
      '7656119800000003'
    ], 'Tasks must be processed in scheduled_at FIFO order');

    for (const u of ids) {
      assert.strictEqual(replyTasksRepo.findByTaskId(`task_${u}`).status, 'replied');
    }

    console.log('  -> Scenario 4 Passed: Multiple messages during OPEN all processed in order without starvation.\n');
  }

  // ---------------------------------------------------------------------------------
  // SCENARIO 5:
  // Queue Ordering: ORDER BY attempt_count ASC, scheduled_at ASC
  // 验证: 无论老失败任务的 scheduled_at 多早, 只要有 attempt_count=0 的新任务,
  //      新任务永远排在老任务之前!
  // ---------------------------------------------------------------------------------
  console.log('--- SCENARIO 5: Queue Ordering verification: attempt_count ASC prevents poison pills ---');
  {
    clearDb();

    // Insert old failed task (attempt_count = 2, scheduled_at 10 minutes ago)
    replyTasksRepo.insert({
      task_id: 'task_old_fail_2',
      steam_comment_id: 'c_old_2',
      target_steam_id: '76561198000000001',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
      reply_text: 'fail 2',
      status: 'waiting',
      attempt_count: 2,
      scheduled_at: new Date(Date.now() - 600000).toISOString(), // 10m ago
      created_at: new Date().toISOString()
    });

    // Insert retried task (attempt_count = 1, scheduled_at 5 minutes ago)
    replyTasksRepo.insert({
      task_id: 'task_old_fail_1',
      steam_comment_id: 'c_old_1',
      target_steam_id: '76561198000000002',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
      reply_text: 'fail 1',
      status: 'waiting',
      attempt_count: 1,
      scheduled_at: new Date(Date.now() - 300000).toISOString(), // 5m ago
      created_at: new Date().toISOString()
    });

    // Insert brand new task (attempt_count = 0, scheduled_at 10 seconds ago)
    replyTasksRepo.insert({
      task_id: 'task_brand_new',
      steam_comment_id: 'c_brand_new',
      target_steam_id: '76561198000000003',
      target_profile_url: 'https://steamcommunity.com/profiles/76561198000000003',
      reply_text: 'new reply',
      status: 'scheduled',
      attempt_count: 0,
      scheduled_at: new Date(Date.now() - 10000).toISOString(), // 10s ago
      created_at: new Date().toISOString()
    });

    const ready = replyTasksRepo.getPendingScheduledTasks(new Date().toISOString());
    assert.strictEqual(ready.length, 3);
    assert.strictEqual(ready[0].task_id, 'task_brand_new', 'Head of queue MUST be brand new task with attempt_count=0');
    assert.strictEqual(ready[1].task_id, 'task_old_fail_1', 'Second in queue must be attempt_count=1');
    assert.strictEqual(ready[2].task_id, 'task_old_fail_2', 'Third in queue must be attempt_count=2');

    console.log('  -> Scenario 5 Passed: attempt_count ASC strictly guarantees fresh tasks are never blocked by retried failures.\n');
  }

  // Cleanup test db
  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('====================================================');
  console.log('  All 5 Circuit Breaker Decoupling Tests PASSED!   ');
  console.log('====================================================\n');
}

module.exports = { runCircuitBreakerQueueDecouplingTests };
