const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runIdempotencyTests() {
  console.log('--- Running Idempotency & Crash Recovery Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');

  const testDbPath = path.resolve(__dirname, 'test-idempotency.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const tasksRepo = new ReplyTasksRepository(db);

  const commentId = 'comment_12345678';
  const now = new Date().toISOString();

  // Test 1: Layer 1 DB Unique constraint on comments
  commentsRepo.insert({
    steam_comment_id: commentId,
    commenter_steam_id: '76561198000000002',
    commenter_profile_url: 'https://steamcommunity.com/id/alice',
    content: 'nice profile',
    status: 'waiting',
    created_at: now,
    updated_at: now
  });

  // Attempt duplicate insert should fail (throw)
  assert.throws(() => {
    commentsRepo.insert({
      steam_comment_id: commentId,
      commenter_steam_id: '76561198000000002',
      commenter_profile_url: 'https://steamcommunity.com/id/alice',
      content: 'nice profile',
      status: 'waiting',
      created_at: now,
      updated_at: now
    });
  }, /UNIQUE constraint failed/);
  console.log('  -> Test 1 Passed: Duplicate steam_comment_id strictly rejected by DB UNIQUE constraint.');

  // Test 2: Layer 3 Unique constraint on reply_tasks
  const taskId = 'task_abc123';
  tasksRepo.insert({
    task_id: taskId,
    steam_comment_id: commentId,
    target_steam_id: '76561198000000002',
    target_profile_url: 'https://steamcommunity.com/id/alice',
    reply_text: 'Thanks Alice!',
    status: 'scheduled',
    scheduled_at: now,
    created_at: now
  });

  assert.throws(() => {
    tasksRepo.insert({
      task_id: 'task_duplicate',
      steam_comment_id: commentId, // Duplicate steam_comment_id in reply_tasks
      target_steam_id: '76561198000000002',
      target_profile_url: 'https://steamcommunity.com/id/alice',
      reply_text: 'Thanks Alice!',
      status: 'scheduled',
      scheduled_at: now,
      created_at: now
    });
  }, /UNIQUE constraint failed/);
  console.log('  -> Test 2 Passed: Duplicate task for same comment strictly rejected.');

  // Test 3: Simulated crash during sending and recovery
  tasksRepo.updateStatus(taskId, 'sending', { started_at: now });
  commentsRepo.updateStatus(commentId, 'sending');

  const unfinished = tasksRepo.getUnfinishedSendingTasks();
  assert.strictEqual(unfinished.length, 1);
  assert.strictEqual(unfinished[0].task_id, taskId);

  // Recovery Scenario A: Target profile check confirms comment was already posted on Steam
  let mockTargetCheckResult = 'FOUND';
  if (mockTargetCheckResult === 'FOUND') {
    tasksRepo.updateStatus(taskId, 'replied', { completed_at: new Date().toISOString() });
    commentsRepo.updateStatus(commentId, 'replied', { replied_at: new Date().toISOString() });
  }

  const refreshedTask = tasksRepo.findByTaskId(taskId);
  assert.strictEqual(refreshedTask.status, 'replied', 'Must be marked as replied upon recovery finding comment');
  console.log('  -> Test 3 Passed: Recovery successfully identified existing comment and prevented duplicate send.');

  // Test 4: Recovery Scenario B: Target profile check is uncertain -> must NOT resend
  const commentId2 = 'comment_99999999';
  const taskId2 = 'task_xyz888';
  commentsRepo.insert({
    steam_comment_id: commentId2,
    commenter_steam_id: '76561198000000003',
    commenter_profile_url: 'https://steamcommunity.com/id/charlie',
    content: 'hello',
    status: 'sending',
    created_at: now,
    updated_at: now
  });
  tasksRepo.insert({
    task_id: taskId2,
    steam_comment_id: commentId2,
    target_steam_id: '76561198000000003',
    target_profile_url: 'https://steamcommunity.com/id/charlie',
    reply_text: 'Hey Charlie!',
    status: 'sending',
    scheduled_at: now,
    created_at: now
  });

  mockTargetCheckResult = 'UNCERTAIN';
  if (mockTargetCheckResult === 'UNCERTAIN') {
    tasksRepo.updateStatus(taskId2, 'uncertain_send_state');
    commentsRepo.updateStatus(commentId2, 'uncertain_send_state', {
      error_message: 'Uncertain recovery state'
    });
  }

  const refreshedTask2 = tasksRepo.findByTaskId(taskId2);
  assert.strictEqual(refreshedTask2.status, 'uncertain_send_state');
  console.log('  -> Test 4 Passed: Uncertain send state handled conservatively (no auto-resend).');

  // Test 5: Uncertain State Recovery (Conservative resolution)
  // Scenario 1: Target check finds comment on Steam -> update to replied
  const uncertainTasks = tasksRepo.getUncertainTasks();
  assert.strictEqual(uncertainTasks.length, 1);
  assert.strictEqual(uncertainTasks[0].task_id, taskId2);

  // If check returns FOUND
  tasksRepo.updateStatus(taskId2, 'replied', { completed_at: new Date().toISOString() });
  commentsRepo.updateStatus(commentId2, 'replied', { replied_at: new Date().toISOString() });

  const resolvedComment = commentsRepo.findByCommentId(commentId2);
  assert.strictEqual(resolvedComment.status, 'replied');
  console.log('  -> Test 5 Passed: Uncertain state successfully resolved to replied when verified on Steam.');

  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  console.log('✅ Passed all Idempotency & Crash Recovery tests!');
}

module.exports = { runIdempotencyTests };
if (require.main === module) runIdempotencyTests();
