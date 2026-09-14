const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runHolidayTests() {
  console.log('--- Running Holiday Eligibility & Scheduling Tests ---');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { InteractionUsersRepository } = require('../../dist/db/repositories/interactionUsers');
  const { HolidayRepository } = require('../../dist/db/repositories/holiday');
  const { HolidayEngine } = require('../../dist/scheduler/holidayEngine');
  const { DEFAULT_CONFIG } = require('../../dist/config/schema');

  const testDbPath = path.resolve(__dirname, 'test-holiday.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const interactionRepo = new InteractionUsersRepository(db);
  const holidayRepo = new HolidayRepository(db);

  const newYearDate = new Date(2026, 0, 1, 10, 0, 0); // Jan 1 10:00 AM
  const tenDaysAgo = new Date(newYearDate.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const fortyDaysAgo = new Date(newYearDate.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

  // User 1: Active commenter 10 days ago -> ELIGIBLE
  interactionRepo.recordInteraction({
    steamId: 'user_active',
    profileUrl: 'https://steamcommunity.com/id/active_user',
    displayName: 'Active Guy'
  });
  db.prepare("UPDATE interaction_users SET last_interaction_at = ? WHERE steam_id = 'user_active'").run(tenDaysAgo);

  // User 2: Old commenter 40 days ago (> 30 days) -> NOT ELIGIBLE
  interactionRepo.recordInteraction({
    steamId: 'user_inactive',
    profileUrl: 'https://steamcommunity.com/id/inactive_user',
    displayName: 'Old Guy'
  });
  db.prepare("UPDATE interaction_users SET last_interaction_at = ? WHERE steam_id = 'user_inactive'").run(fortyDaysAgo);

  // User 3: Spammer -> NOT ELIGIBLE
  interactionRepo.recordInteraction({
    steamId: 'user_spammer',
    profileUrl: 'https://steamcommunity.com/id/spammer',
    isSpam: true
  });
  db.prepare("UPDATE interaction_users SET last_interaction_at = ? WHERE steam_id = 'user_spammer'").run(tenDaysAgo);

  // Test active cutoff filter (30 days)
  const cutoffIso = new Date(newYearDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const eligible = interactionRepo.getEligibleHolidayUsers(cutoffIso, 10);

  assert.strictEqual(eligible.length, 1, 'Only 1 user should be eligible');
  assert.strictEqual(eligible[0].steam_id, 'user_active');
  console.log('  -> Test 1 Passed: Only active past commenters within 30 days qualify (spammers & inactive excluded).');

  // Test holiday scheduling engine on New Year (Jan 1)
  const holidayEngine = new HolidayEngine(interactionRepo, holidayRepo, {
    ...DEFAULT_CONFIG,
    MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
    HOLIDAY_ACTIVE_DAYS: 30,
    HOLIDAY_SEND_START: '09:00',
    HOLIDAY_SEND_END: '22:00'
  });

  const scheduledCount = holidayEngine.planHolidayGreetingsForToday(newYearDate);
  assert.strictEqual(scheduledCount, 1, 'Should schedule exactly 1 holiday greeting for eligible user');

  const pending = holidayRepo.getPendingScheduled(new Date(2026, 0, 1, 23, 59, 59).toISOString());
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].steam_id, 'user_active');
  assert.ok(pending[0].message.length > 5);
  console.log('  -> Test 2 Passed: Holiday greeting successfully planned with staggered send time.');

  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  console.log('✅ Passed all Holiday Eligibility & Scheduling tests!');
}

module.exports = { runHolidayTests };
if (require.main === module) runHolidayTests();
