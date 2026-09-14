const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runTodayStatsTests() {
  console.log('--- Running Today Stats & Total Replies Accounting Unit Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { HolidayRepository } = require('../../dist/db/repositories/holiday');

  const testDbPath = path.resolve(__dirname, 'test_today_stats.sqlite');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);
  const holidayRepo = new HolidayRepository(db);

  const now = new Date();
  const todayPrefix = now.toISOString().substring(0, 10);
  const todayAt10Am = `${todayPrefix}T10:00:00.000Z`;
  const yesterdayPrefix = new Date(now.getTime() - 86400000).toISOString().substring(0, 10);
  const yesterdayAt10Am = `${yesterdayPrefix}T10:00:00.000Z`;

  // ============================================================
  // Test 1: Local replied 3 + AI replied 2 => totalReplies = 5
  // ============================================================
  console.log('--- Test 1: Local replied 3 + AI replied 2 = 5 totalReplies ---');
  // Insert 3 local replied comments
  for (let i = 1; i <= 3; i++) {
    commentsRepo.insert({
      steam_comment_id: `comm_local_${i}`,
      commenter_steam_id: `7656119800000000${i}`,
      commenter_profile_url: `https://steamcommunity.com/profiles/7656119800000000${i}`,
      content: `Hello local ${i}`,
      reply_source: 'LOCAL_RULE',
      reply: `Local reply ${i}`,
      status: 'replied',
      created_at: todayAt10Am,
      updated_at: todayAt10Am,
      replied_at: todayAt10Am
    });
  }
  // Insert 2 AI replied comments
  for (let i = 1; i <= 2; i++) {
    commentsRepo.insert({
      steam_comment_id: `comm_ai_${i}`,
      commenter_steam_id: `7656119800000001${i}`,
      commenter_profile_url: `https://steamcommunity.com/profiles/7656119800000001${i}`,
      content: `Hello AI ${i}`,
      reply_source: 'DEEPSEEK',
      reply: `AI reply ${i}`,
      status: 'replied',
      created_at: todayAt10Am,
      updated_at: todayAt10Am,
      replied_at: todayAt10Am
    });
  }

  let stats = commentsRepo.getStatsToday();
  assert.strictEqual(stats.localReplies, 3, 'localReplies must be 3');
  assert.strictEqual(stats.aiReplies, 2, 'aiReplies must be 2');
  assert.strictEqual(stats.totalReplies, 5, 'totalReplies must be 5 (3 local + 2 AI)');
  console.log('  -> Test 1 Passed: 3 local + 2 AI correctly totals 5.');

  // ============================================================
  // Test 2: Task created / scheduled but not replied => NOT counted
  // ============================================================
  console.log('--- Test 2: Task created/scheduled but not yet sent must NOT be counted ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_pending_1',
    commenter_steam_id: '76561198000000020',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000020',
    content: 'Waiting for send',
    reply_source: 'LOCAL_TEMPLATE',
    reply: 'Will reply soon',
    status: 'waiting',
    created_at: todayAt10Am,
    updated_at: todayAt10Am
  });
  replyTasksRepo.insert({
    task_id: 'task_pending_1',
    steam_comment_id: 'comm_pending_1',
    target_steam_id: '76561198000000020',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000020',
    reply_text: 'Will reply soon',
    status: 'scheduled',
    scheduled_at: todayAt10Am,
    attempt_count: 0,
    created_at: todayAt10Am
  });

  stats = commentsRepo.getStatsToday();
  assert.strictEqual(stats.totalReplies, 5, 'totalReplies must still be 5');
  assert.strictEqual(stats.localReplies, 3, 'localReplies must still be 3');
  console.log('  -> Test 2 Passed: Pending/scheduled tasks are not counted in totalReplies.');

  // ============================================================
  // Test 3: POST uncertain / uncertain_send_state => NOT counted
  // ============================================================
  console.log('--- Test 3: uncertain_send_state must NOT be counted ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_uncertain_1',
    commenter_steam_id: '76561198000000030',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000030',
    content: 'Uncertain comment',
    reply_source: 'DEEPSEEK',
    reply: 'AI tentative reply',
    status: 'uncertain_send_state',
    created_at: todayAt10Am,
    updated_at: todayAt10Am
  });
  replyTasksRepo.insert({
    task_id: 'task_uncertain_1',
    steam_comment_id: 'comm_uncertain_1',
    target_steam_id: '76561198000000030',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000030',
    reply_text: 'AI tentative reply',
    status: 'uncertain_send_state',
    scheduled_at: todayAt10Am,
    attempt_count: 1,
    created_at: todayAt10Am
  });

  stats = commentsRepo.getStatsToday();
  assert.strictEqual(stats.totalReplies, 5, 'totalReplies must still be 5');
  assert.strictEqual(stats.aiReplies, 2, 'aiReplies must still be 2');
  console.log('  -> Test 3 Passed: uncertain_send_state is excluded from reply counts.');

  // ============================================================
  // Test 4: Send failed / status='failed' => NOT counted
  // ============================================================
  console.log('--- Test 4: Failed send tasks must NOT be counted ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_failed_1',
    commenter_steam_id: '76561198000000040',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000040',
    content: 'Failed comment',
    reply_source: 'LOCAL_RULE',
    reply: 'Local failed attempt',
    status: 'failed',
    created_at: todayAt10Am,
    updated_at: todayAt10Am,
    error_message: 'HTTP 500 error from Steam'
  });

  stats = commentsRepo.getStatsToday();
  assert.strictEqual(stats.totalReplies, 5, 'totalReplies must still be 5');
  assert.strictEqual(stats.localReplies, 3, 'localReplies must still be 3');
  console.log('  -> Test 4 Passed: Failed send is not counted.');

  // ============================================================
  // Test 5: Visual expression reply successful => counted in localReplies and totalReplies
  // ============================================================
  console.log('--- Test 5: Visual expression replied => counted in localReplies and totalReplies ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_visual_1',
    commenter_steam_id: '76561198000000050',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000050',
    content: '░█▀▀█░█▀▀█',
    classification: 'ascii_art',
    reply_source: 'VISUAL_GENERATOR',
    reply: '＼(＾▽＾)／',
    status: 'replied',
    created_at: todayAt10Am,
    updated_at: todayAt10Am,
    replied_at: todayAt10Am
  });

  stats = commentsRepo.getStatsToday();
  assert.strictEqual(stats.localReplies, 4, 'localReplies must increase from 3 to 4');
  assert.strictEqual(stats.totalReplies, 6, 'totalReplies must increase from 5 to 6');
  assert.strictEqual(stats.visualExpressionReplies, 1, 'visualExpressionReplies must be 1');
  console.log('  -> Test 5 Passed: Visual expression reply properly counted in local and total replies.');

  // ============================================================
  // Test 6: Holiday active reply sent => counted in holidayReplies and totalReplies
  // ============================================================
  console.log('--- Test 6: Holiday reply sent => counted in holidayReplies and totalReplies ---');
  holidayRepo.insert({
    holiday_id: 'mid_autumn',
    steam_id: '76561198000000060',
    profile_url: 'https://steamcommunity.com/profiles/76561198000000060',
    message: '🥮 中秋快乐！',
    status: 'sent',
    scheduled_at: todayAt10Am,
    sent_at: todayAt10Am,
    created_at: todayAt10Am
  });

  const holidayCountToday = holidayRepo.getCountSentToday(todayPrefix);
  assert.strictEqual(holidayCountToday, 1, 'Holiday count today must be 1');

  stats = commentsRepo.getStatsToday(holidayCountToday);
  assert.strictEqual(stats.localReplies, 4, 'localReplies remains 4');
  assert.strictEqual(stats.aiReplies, 2, 'aiReplies remains 2');
  assert.strictEqual(stats.totalReplies, 7, 'totalReplies must be 7 (4 local + 2 AI + 1 holiday)');
  console.log('  -> Test 6 Passed: Holiday reply added to totalReplies seamlessly.');

  // ============================================================
  // Test 7: Replies from yesterday => NOT counted in today stats
  // ============================================================
  console.log('--- Test 7: Replies from yesterday must NOT be counted today ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_yesterday_1',
    commenter_steam_id: '76561198000000070',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000070',
    content: 'Yesterday comment',
    reply_source: 'LOCAL_RULE',
    reply: 'Yesterday local reply',
    status: 'replied',
    created_at: yesterdayAt10Am,
    updated_at: yesterdayAt10Am,
    replied_at: yesterdayAt10Am
  });

  // Also test a comment created yesterday but replied TODAY: should be counted TODAY!
  commentsRepo.insert({
    steam_comment_id: 'comm_created_yesterday_replied_today',
    commenter_steam_id: '76561198000000071',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000071',
    content: 'Comment arrived yesterday night',
    reply_source: 'LOCAL_ONLY',
    reply: 'Replied this morning',
    status: 'replied',
    created_at: yesterdayAt10Am,
    updated_at: todayAt10Am,
    replied_at: todayAt10Am
  });

  stats = commentsRepo.getStatsToday(holidayCountToday);
  // comm_yesterday_1 (replied_at yesterday) is NOT counted
  // comm_created_yesterday_replied_today (replied_at today) IS counted (+1 local)
  assert.strictEqual(stats.localReplies, 5, 'localReplies must be 5 (4 previous + 1 replied today)');
  assert.strictEqual(stats.totalReplies, 8, 'totalReplies must be 8 (5 local + 2 AI + 1 holiday)');
  console.log('  -> Test 7 Passed: replied_at correctly boundaries today vs yesterday.');

  // ============================================================
  // Test 8: Baseline import comments on initial scan => NEVER counted
  // ============================================================
  console.log('--- Test 8: Baseline imports on initial scan must NOT be counted as replies ---');
  commentsRepo.insert({
    steam_comment_id: 'comm_baseline_import_1',
    commenter_steam_id: '76561198000000080',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000080',
    content: 'Scanned historical comment on bot startup',
    reply_source: 'IMPORT_EXISTING',
    reply: '[Baseline Imported on Initial Scan - Duplicate Reply Protection]',
    status: 'replied',
    created_at: todayAt10Am,
    updated_at: todayAt10Am,
    replied_at: todayAt10Am
  });

  stats = commentsRepo.getStatsToday(holidayCountToday);
  assert.strictEqual(stats.localReplies, 5, 'localReplies must NOT include baseline imports');
  assert.strictEqual(stats.totalReplies, 8, 'totalReplies must NOT include baseline imports');
  console.log('  -> Test 8 Passed: Baseline imports strictly excluded from total reply counts.');

  // Cleanup test database
  try {
    db.close();
    fs.unlinkSync(testDbPath);
  } catch {}

  console.log('\n====================================================');
  console.log('  All 8 Today Stats Accounting Tests PASSED!        ');
  console.log('====================================================\n');
}

module.exports = { runTodayStatsTests };
if (require.main === module) {
  runTodayStatsTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
