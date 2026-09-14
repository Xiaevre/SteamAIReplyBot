import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AppDatabase } from '../../src/db/database';
import { runMigrations } from '../../src/db/migrations';
import { TaskScheduler } from '../../src/scheduler/taskScheduler';
import { ReplyTasksRepository } from '../../src/db/repositories/replyTasks';
import { CommentsRepository } from '../../src/db/repositories/comments';
import { BotConfig } from '../../src/config/schema';
import { BrowserLifecycleError } from '../../src/steam/browser';

export async function runStartupRecoveryRaceTests(): Promise<void> {
  console.log('--- Running Startup Recovery & Interactive Login Race Tests (Suite 27) ---');

  const testDbPath = path.resolve(__dirname, 'test-recovery-race.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const replyTasksRepo = new ReplyTasksRepository(db);
  const commentsRepo = new CommentsRepository(db);

  const baseConfig: BotConfig = {
    STEAM_PROFILE_URL: 'https://steamcommunity.com/id/test_bot/',
    BOT_ENABLED: true,
    BOT_MODE: 'AI_ENHANCED',
    EMERGENCY_STOP: false,
    DRY_RUN: true,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-chat',
    CHECK_INTERVAL_MIN_SECONDS: 60,
    CHECK_INTERVAL_MAX_SECONDS: 120,
    MIN_REPLY_DELAY_SECONDS: 0,
    MAX_REPLY_DELAY_SECONDS: 0,
    MAX_REPLIES_PER_HOUR: 10,
    MAX_REPLIES_PER_DAY: 50,
    DEFAULT_LANGUAGE: 'zh',
    TIMEZONE: 'Asia/Tokyo',
    MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
    HOLIDAY_ACTIVE_DAYS: 30,
    HOLIDAY_SEND_START: '09:00',
    HOLIDAY_SEND_END: '22:00',
    AI_REQUEST_DELAY_MS: 0,
    MEMORY_WARNING_MB: 400,
    MEMORY_CRITICAL_MB: 600,
    BROWSER_MODE: 'AUTO',
    HEADLESS: true
  };

  const now = new Date().toISOString();

  // Insert test tasks into DB: 1 uncertain, 1 moderation pending
  commentsRepo.insert({
    steam_comment_id: 'cmt_race_uncertain_1',
    commenter_steam_id: '76561198000000001',
    commenter_name: 'UserUncertain',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
    content: 'hello test',
    status: 'uncertain_send_state',
    created_at: now,
    updated_at: now
  });

  replyTasksRepo.insert({
    task_id: 'task_race_uncertain_1',
    steam_comment_id: 'cmt_race_uncertain_1',
    target_steam_id: '76561198000000001',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000001',
    reply_text: 'reply uncertain',
    status: 'uncertain_send_state',
    scheduled_at: now,
    attempt_count: 1,
    created_at: now
  });

  commentsRepo.insert({
    steam_comment_id: 'cmt_race_mod_1',
    commenter_steam_id: '76561198000000002',
    commenter_name: 'UserMod',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
    content: 'hello moderation',
    status: 'submitted_moderation_pending',
    created_at: now,
    updated_at: now
  });

  replyTasksRepo.insert({
    task_id: 'task_race_mod_1',
    steam_comment_id: 'cmt_race_mod_1',
    target_steam_id: '76561198000000002',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198000000002',
    reply_text: 'reply mod pending',
    status: 'submitted_moderation_pending',
    scheduled_at: now,
    attempt_count: 1,
    created_at: now
  });

  const scheduler = new TaskScheduler(baseConfig, db);

  let pageOpenCount = 0;
  let sendReplyCount = 0;

  scheduler.browserManager = {
    ...scheduler.browserManager,
    getContext: async () => ({
      newPage: async () => {
        pageOpenCount++;
        return { close: async () => {}, goto: async () => {} };
      }
    }),
    close: async () => {},
    isContextActive: () => true,
    isBrowserClosing: () => false,
    openEphemeralPage: async () => {
      pageOpenCount++;
      return { close: async () => {}, goto: async () => {} };
    }
  } as any;

  scheduler.commentSender = {
    ...scheduler.commentSender,
    sendReply: async () => {
      sendReplyCount++;
      return { status: 'SUCCESS', message: 'OK' };
    },
    checkTargetProfileForExistingComment: async () => 'NOT_FOUND'
  } as any;

  try {
    // ============================================================
    // Test 1: Session requires login at startup -> recovery is safely deferred
    // ============================================================
    console.log('--- Test 1: Startup Session requires login -> recovery is safely deferred ---');
    scheduler.sessionManager = {
      ...scheduler.sessionManager,
      checkSessionHealth: async () => ({
        valid: false,
        hasLoginCookie: false,
        hasSessionIdCookie: false,
        reason: 'NO_COOKIES_ON_SERVER_FIRST_BOOT'
      })
    } as any;

    // Start scheduler when session is unauthenticated
    await scheduler.start();

    assert.strictEqual(scheduler.sessionState, 'waiting_for_login');
    assert.strictEqual(pageOpenCount, 0, 'Must not attempt to open pages for recovery when login is required');

    // Confirm tasks were NOT modified or deleted
    const tUncertain1 = replyTasksRepo.findByTaskId('task_race_uncertain_1');
    const tMod1 = replyTasksRepo.findByTaskId('task_race_mod_1');
    assert.strictEqual(tUncertain1?.status, 'uncertain_send_state', 'Task must remain in uncertain_send_state');
    assert.strictEqual(tMod1?.status, 'submitted_moderation_pending', 'Task must remain in submitted_moderation_pending');
    console.log('  -> Test 1 Passed: Recovery cleanly deferred, 0 pages opened, tasks untouched.');

    // ============================================================
    // Test 2: Interactive login active -> recovery steps immediately abort without crashing
    // ============================================================
    console.log('--- Test 2: Interactive login active -> recovery steps abort without crashing ---');
    scheduler.isInteractiveLoginActive = true;

    // Attempt to invoke recovery while interactive login is running
    await scheduler.runCrashRecovery();
    await scheduler.runUncertainStateRecoveryStep();
    await scheduler.runModerationPendingRecoveryStep();

    assert.strictEqual(pageOpenCount, 0, 'No pages should be opened while interactive login is active');
    console.log('  -> Test 2 Passed: Active login strictly halts recovery steps.');

    // ============================================================
    // Test 3: Browser closed / Protocol error during profile check -> isolated without bubbling
    // ============================================================
    console.log('--- Test 3: Browser lifecycle error in recovery -> safely isolated ---');
    scheduler.isInteractiveLoginActive = false;
    scheduler.sessionState = 'authenticated';

    // Simulate browser closing / protocol error
    scheduler.commentSender.checkTargetProfileForExistingComment = async () => {
      throw new BrowserLifecycleError('Protocol error (Target.createTarget): Failed to open a new tab');
    };

    // Neither call should throw or bubble to main()
    let threwError = false;
    try {
      await scheduler.runUncertainStateRecoveryStep();
      await scheduler.runModerationPendingRecoveryStep();
    } catch (err) {
      threwError = true;
    }

    assert.strictEqual(threwError, false, 'Recovery error must be caught and isolated, never bubble out');
    assert.strictEqual(sendReplyCount, 0, 'Must never trigger comment sending on recovery lifecycle error');

    // Verify task status was preserved in SQLite
    const tUncertainAfterErr = replyTasksRepo.findByTaskId('task_race_uncertain_1');
    const tModAfterErr = replyTasksRepo.findByTaskId('task_race_mod_1');
    assert.strictEqual(tUncertainAfterErr?.status, 'uncertain_send_state');
    assert.strictEqual(tModAfterErr?.status, 'submitted_moderation_pending');
    console.log('  -> Test 3 Passed: Lifecycle exception safely caught and task state preserved.');

    // ============================================================
    // Test 4: Session restored -> subsequent recovery succeeds and completes tasks
    // ============================================================
    console.log('--- Test 4: Post-login recovery resumption ---');
    // Now simulate Steam login completed and target profile has the moderation comment published
    scheduler.commentSender.checkTargetProfileForExistingComment = async () => 'FOUND';

    await scheduler.runModerationPendingRecoveryStep();

    const tModResolved = replyTasksRepo.findByTaskId('task_race_mod_1');
    const cModResolved = commentsRepo.findByCommentId('cmt_race_mod_1');
    assert.strictEqual(tModResolved?.status, 'replied', 'Task should be marked replied once verified on profile');
    assert.strictEqual(cModResolved?.status, 'replied');
    assert.strictEqual(sendReplyCount, 0, 'Must resolve without creating duplicate outgoing POST');
    console.log('  -> Test 4 Passed: Recovery successfully resumed and verified task as replied.');

    console.log('\n====================================================');
    console.log('  All Startup Recovery Race Tests PASSED!          ');
    console.log('====================================================\n');
  } finally {
    await scheduler.stopBot();
    db.close();
    try { fs.unlinkSync(testDbPath); } catch {}
  }
}
