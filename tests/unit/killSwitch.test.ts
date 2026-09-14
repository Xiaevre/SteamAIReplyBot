const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runKillSwitchTests() {
  console.log('--- Running Kill Switch & Emergency Stop Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');

  const testDbPath = path.resolve(__dirname, 'test-killswitch.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);
  const tasksRepo = new ReplyTasksRepository(db);

  const now = new Date().toISOString();

  // Create pending scheduled tasks
  tasksRepo.insert({
    task_id: 'task_1',
    steam_comment_id: 'comment_1',
    target_steam_id: '76561198000000001',
    target_profile_url: 'https://steamcommunity.com/id/user1',
    reply_text: 'Hello 1',
    status: 'scheduled',
    scheduled_at: now,
    created_at: now
  });

  tasksRepo.insert({
    task_id: 'task_2',
    steam_comment_id: 'comment_2',
    target_steam_id: '76561198000000002',
    target_profile_url: 'https://steamcommunity.com/id/user2',
    reply_text: 'Hello 2',
    status: 'waiting',
    scheduled_at: now,
    created_at: now
  });

  // Verify pending tasks exist
  const pendingBefore = tasksRepo.getPendingScheduledTasks(new Date(Date.now() + 10000).toISOString());
  assert.strictEqual(pendingBefore.length, 2);

  // Trigger EMERGENCY STOP -> cancelAllPendingTasks()
  const canceledCount = tasksRepo.cancelAllPendingTasks();
  assert.strictEqual(canceledCount, 2);

  const pendingAfter = tasksRepo.getPendingScheduledTasks(new Date(Date.now() + 10000).toISOString());
  assert.strictEqual(pendingAfter.length, 0, 'No pending tasks should remain after EMERGENCY_STOP');

  const t1 = tasksRepo.findByTaskId('task_1');
  assert.strictEqual(t1.status, 'skipped', 'Task 1 status must be skipped');

  const t2 = tasksRepo.findByTaskId('task_2');
  assert.strictEqual(t2.status, 'skipped', 'Task 2 status must be skipped');

  console.log('  -> Test 1 Passed: EMERGENCY_STOP successfully canceled all pending/scheduled tasks.');

  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  console.log('✅ Passed all Kill Switch & Emergency Stop tests!');
}

module.exports = { runKillSwitchTests };
if (require.main === module) runKillSwitchTests();
