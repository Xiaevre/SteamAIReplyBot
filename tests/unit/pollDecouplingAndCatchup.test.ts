const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runPollDecouplingAndCatchupTests() {
  console.log('====================================================');
  console.log('  Running Suite 31: Poll Decoupling & Catch-up Tests');
  console.log('====================================================\n');

  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { CommentsRepository } = require('../../dist/db/repositories/comments');
  const { ReplyTasksRepository } = require('../../dist/db/repositories/replyTasks');
  const { MonitorStateRepository } = require('../../dist/db/repositories/monitorState');
  const { TransportCircuitBreaker } = require('../../dist/steam/transport/transportCircuitBreaker');
  const { CommentMonitor } = require('../../dist/steam/commentMonitor');
  const { computeReplyFingerprint } = require('../../dist/steam/commentSender');
  const { sanitizeDiagnosticText, sanitizeDiagnosticObject } = require('../../dist/utils/sanitizer');
  const { createZipArchive } = require('../../dist/utils/zip');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { ApiRouter } = require('../../dist/server/apiRouter');
  const { Logger } = require('../../dist/utils/logger');
  const { loadConfig } = require('../../dist/config/env');

  const logger = new Logger('test', { quiet: true });
  const testDbPath = path.resolve(__dirname, 'test-poll-catchup.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const commentsRepo = new CommentsRepository(db);
  const replyTasksRepo = new ReplyTasksRepository(db);
  const monitorStateRepo = new MonitorStateRepository(db);

  function clearDb() {
    db.prepare('DELETE FROM reply_tasks').run();
    db.prepare('DELETE FROM comments').run();
    db.prepare('DELETE FROM comment_monitor_state').run();
  }

  function enqueueTask(data) {
    const taskId = data.task_id || ('task_' + Math.random().toString(36).substring(2, 9));
    replyTasksRepo.insert({
      task_id: taskId,
      steam_comment_id: data.steam_comment_id || ('comm_' + taskId),
      target_steam_id: data.target_steam_id || '76561198000000001',
      target_profile_url: data.target_profile_url || 'https://steamcommunity.com/id/target/',
      reply_text: data.reply_text || 'Test reply',
      status: data.status || 'waiting',
      attempt_count: data.attempt_count ?? 0,
      scheduled_at: data.scheduled_at || new Date().toISOString(),
      created_at: new Date().toISOString()
    });
    return replyTasksRepo.findByTaskId(taskId);
  }

  // =========================================================================
  // Test 1: Monitor State Persistence (comment_monitor_state)
  // =========================================================================
  console.log('--- Test 1: Monitor State Persistence ---');
  clearDb();
  assert.strictEqual(monitorStateRepo.getLastSeenCommentId(), null, 'Initial cursor should be null');

  monitorStateRepo.setLastSeenCommentId('comment_1001');
  assert.strictEqual(monitorStateRepo.getLastSeenCommentId(), 'comment_1001', 'Cursor should be updated to comment_1001');

  monitorStateRepo.setLastSeenCommentId('comment_2002');
  assert.strictEqual(monitorStateRepo.getLastSeenCommentId(), 'comment_2002', 'Cursor should be updated to comment_2002');
  console.log('✓ Test 1 Passed: Monitor state cursor persists and updates cleanly.');

  // =========================================================================
  // Test 2: Schema v3 Reply Tasks Tracking Columns
  // =========================================================================
  console.log('--- Test 2: Schema v3 Reply Tasks Columns ---');
  clearDb();
  const taskRow = enqueueTask({
    steam_comment_id: 'comm_schema_v3',
    target_steam_id: '76561198012345678',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198012345678',
    reply_text: 'Test Schema v3 reply',
    scheduled_at: new Date().toISOString()
  });

  const nowIso = new Date().toISOString();
  replyTasksRepo.updateStatus(taskRow.task_id, 'uncertain_send_state', {
    transport_retry_count: 2,
    uncertain_resend_count: 1,
    uncertain_verify_count: 2,
    uncertain_last_checked_at: nowIso,
    reply_fingerprint: 'fp_abc123'
  });

  const fetchedTask = replyTasksRepo.findByTaskId(taskRow.task_id);
  assert.strictEqual(fetchedTask.status, 'uncertain_send_state');
  assert.strictEqual(fetchedTask.transport_retry_count, 2);
  assert.strictEqual(fetchedTask.uncertain_resend_count, 1);
  assert.strictEqual(fetchedTask.uncertain_verify_count, 2);
  assert.strictEqual(fetchedTask.uncertain_last_checked_at, nowIso);
  assert.strictEqual(fetchedTask.reply_fingerprint, 'fp_abc123');
  console.log('✓ Test 2 Passed: Schema v3 reply_tasks tracking columns successfully verified.');

  // =========================================================================
  // Test 3: Bounded SQL Query Limits for Recovery Steps
  // =========================================================================
  console.log('--- Test 3: Bounded SQL Query Limits for Recovery Steps ---');
  clearDb();
  for (let i = 1; i <= 10; i++) {
    const t = enqueueTask({
      steam_comment_id: `mod_${i}`,
      target_steam_id: `7656119800000000${i}`,
      target_profile_url: `https://steamcommunity.com/profiles/7656119800000000${i}`,
      reply_text: `Mod task ${i}`,
      scheduled_at: new Date().toISOString()
    });
    replyTasksRepo.updateStatus(t.task_id, 'submitted_moderation_pending');
  }

  for (let i = 1; i <= 8; i++) {
    const t = enqueueTask({
      steam_comment_id: `unc_${i}`,
      target_steam_id: `7656119800000001${i}`,
      target_profile_url: `https://steamcommunity.com/profiles/7656119800000001${i}`,
      reply_text: `Uncertain task ${i}`,
      scheduled_at: new Date().toISOString()
    });
    replyTasksRepo.updateStatus(t.task_id, 'uncertain_send_state');
  }

  assert.strictEqual(replyTasksRepo.getModerationPendingTasksCount(), 10, 'Total moderation count must be 10');
  const boundedMod = replyTasksRepo.getModerationPendingTasks(3);
  assert.strictEqual(boundedMod.length, 3, 'getModerationPendingTasks(3) must return at most 3 items');

  assert.strictEqual(replyTasksRepo.getUncertainTasksCount(), 8, 'Total uncertain count must be 8');
  const boundedUnc = replyTasksRepo.getUncertainTasks(3);
  assert.strictEqual(boundedUnc.length, 3, 'getUncertainTasks(3) must return at most 3 items');
  console.log('✓ Test 3 Passed: Recovery queries bounded to batch size 3 in SQL.');

  // =========================================================================
  // Test 4: Incremental Backwards Catch-Up Pagination & Safety Cap
  // =========================================================================
  console.log('--- Test 4: Incremental Catch-Up Pagination & Safety Cap ---');
  const dummyBrowser = {
    openEphemeralPage: async () => ({
      context: () => ({ newCDPSession: async () => ({ send: async () => {} }) }),
      goto: async () => {},
      waitForSelector: async () => {},
      url: () => 'https://steamcommunity.com/id/test/',
      waitForTimeout: async () => {},
      close: async () => {}
    })
  };

  const monitor = new CommentMonitor(dummyBrowser, 'https://steamcommunity.com/id/test/', logger);

  // Mock extractCommentsFromPage and triggerNextPage to simulate 3 pages of comments:
  // Page 1: [c10, c9, c8]
  // Page 2: [c7, c6, c5]
  // Page 3: [c4, c3, c2, c1]
  let pageIdx = 1;
  monitor.extractCommentsFromPage = async () => {
    if (pageIdx === 1) return [{ commentId: 'c10' }, { commentId: 'c9' }, { commentId: 'c8' }];
    if (pageIdx === 2) return [{ commentId: 'c7' }, { commentId: 'c6' }, { commentId: 'c5' }];
    if (pageIdx === 3) return [{ commentId: 'c4' }, { commentId: 'c3' }, { commentId: 'c2' }, { commentId: 'c1' }];
    return [];
  };
  monitor.triggerNextPage = async () => {
    if (pageIdx < 3) {
      pageIdx++;
      return true;
    }
    return false;
  };

  // Scenario A: Cursor at 'c6' (located on page 2). Monitor should fetch page 1 and page 2, stop at c6, and return [c10, c9, c8, c7].
  pageIdx = 1;
  const catchupResult = await monitor.fetchComments('c6');
  assert.strictEqual(catchupResult.length, 4, 'Should return exactly 4 comments newer than c6');
  assert.deepStrictEqual(catchupResult.map(c => c.commentId), ['c10', 'c9', 'c8', 'c7']);
  assert.strictEqual(monitor.lastCatchupStats.pageCount, 2, 'Should stop after page 2 where cursor was reached');

  // Scenario B: Safety cap 500
  pageIdx = 1;
  let counter = 1000;
  monitor.extractCommentsFromPage = async () => {
    const page = [];
    for (let j = 0; j < 100; j++) {
      page.push({ commentId: `c_${counter--}` });
    }
    return page;
  };
  monitor.triggerNextPage = async () => true;

  const cappedResult = await monitor.fetchComments('never_seen_cursor', 500);
  assert.strictEqual(monitor.catchupLimitExceeded, true, 'catchupLimitExceeded must be flagged');
  assert.strictEqual(cappedResult.length, 500, 'Comments fetched must be capped at 500');
  console.log('✓ Test 4 Passed: Incremental catch-up pagination and 500 cap verified.');

  // =========================================================================
  // Test 5: Reply Fingerprint Computation & Consistency
  // =========================================================================
  console.log('--- Test 5: Reply Fingerprint Computation ---');
  const fp1 = computeReplyFingerprint('76561198000000001', 'Hello  world!  ');
  const fp2 = computeReplyFingerprint('76561198000000001', 'Hello world!');
  const fp3 = computeReplyFingerprint('76561198000000002', 'Hello world!');
  const fp4 = computeReplyFingerprint('76561198000000001', 'Different message');

  assert.strictEqual(fp1, fp2, 'Normalized whitespace must produce identical fingerprints');
  assert.notStrictEqual(fp1, fp3, 'Different targetSteamId must produce different fingerprint');
  assert.notStrictEqual(fp1, fp4, 'Different message must produce different fingerprint');
  assert.strictEqual(typeof fp1, 'string');
  assert.strictEqual(fp1.length, 64, 'SHA-256 fingerprint must be 64-char hex');
  console.log('✓ Test 5 Passed: Reply fingerprinting multi-factor consistency verified.');

  // =========================================================================
  // Test 6: Network Transport Circuit Breaker Mechanics
  // =========================================================================
  console.log('--- Test 6: Transport Circuit Breaker Mechanics ---');
  const tcb = new TransportCircuitBreaker(logger, { failureThreshold: 3, cooldownSeconds: 1 });
  assert.strictEqual(tcb.isOpen(), false);
  assert.strictEqual(tcb.getState(), 'CLOSED');

  tcb.recordFailure();
  tcb.recordFailure();
  assert.strictEqual(tcb.getState(), 'CLOSED');

  tcb.recordFailure(); // 3rd failure trips breaker
  assert.strictEqual(tcb.getState(), 'OPEN');
  assert.strictEqual(tcb.isOpen(), true);

  // Wait for cooldown
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.strictEqual(tcb.isHalfOpen(), true);
  assert.strictEqual(tcb.isOpen(), false); // Half-open allows probe

  // Probe succeeds -> Closed
  tcb.recordSuccess();
  assert.strictEqual(tcb.getState(), 'CLOSED');
  assert.strictEqual(tcb.isOpen(), false);
  console.log('✓ Test 6 Passed: Transport Circuit Breaker state transitions verified.');

  // =========================================================================
  // Test 7: Transport Pre-Send Failure Retries vs Business Attempt Count
  // =========================================================================
  console.log('--- Test 7: Transport Pre-Send Failure Retries Decoupled ---');
  clearDb();
  const config = loadConfig();
  config.STEAM_PROFILE_URL = 'https://steamcommunity.com/id/testbot/';
  config.DRY_RUN = false;

  const scheduler = new TaskScheduler(config, db, logger);
  scheduler.sessionState = 'authenticated';
  scheduler.isRunning = true;

  // Seed ready task
  const testTask = enqueueTask({
    steam_comment_id: 'comm_presend_fail',
    target_steam_id: '76561198099999999',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198099999999',
    reply_text: 'Hello pre-send retry',
    scheduled_at: new Date(Date.now() - 1000).toISOString()
  });
  commentsRepo.insert({
    steam_comment_id: 'comm_presend_fail',
    commenter_steam_id: '76561198099999999',
    commenter_profile_url: 'https://steamcommunity.com/profiles/76561198099999999',
    content: 'original comment',
    language: 'zh',
    classification: 'warm_social',
    classification_confidence: 1.0,
    reply_source: 'LOCAL_RULE',
    reply: 'Hello pre-send retry',
    status: 'waiting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // Mock commentSender.sendReply to return TRANSPORT_PRE_SEND_FAILURE
  scheduler.commentSender.sendReply = async () => ({
    status: 'SEND_FAILED',
    confirmationStatus: 'CONFIRMED_NOT_SENT',
    failureClass: 'TRANSPORT_PRE_SEND_FAILURE',
    message: 'DNS lookup failed for steamcommunity.com'
  });

  // Run dispatch step
  await (scheduler as any).dispatchPendingRepliesStep();

  const taskAfter1stFail = replyTasksRepo.findByTaskId(testTask.task_id);
  assert.strictEqual(taskAfter1stFail.status, 'waiting', 'Task must remain in waiting state');
  assert.strictEqual(taskAfter1stFail.transport_retry_count, 1, 'transport_retry_count must increment to 1');
  assert.strictEqual(taskAfter1stFail.attempt_count, 0, 'business attempt_count must remain 0!');

  // Simulate 3rd pre-send fail exceeding limit
  replyTasksRepo.updateStatus(testTask.task_id, 'waiting', {
    transport_retry_count: 3,
    scheduled_at: new Date(Date.now() - 1000).toISOString()
  });
  await (scheduler as any).dispatchPendingRepliesStep();

  const taskAfterLimitExceeded = replyTasksRepo.findByTaskId(testTask.task_id);
  assert.strictEqual(taskAfterLimitExceeded.status, 'failed', 'Exceeding 3 transport retries must transition to failed');
  assert.strictEqual(taskAfterLimitExceeded.transport_retry_count, 4);
  console.log('✓ Test 7 Passed: Pre-send transport retries decoupled from business attempts.');

  // =========================================================================
  // Test 8: UNCERTAIN 2-Phase Spaced Dual Verification & SAFE_TO_RESEND
  // =========================================================================
  console.log('--- Test 8: UNCERTAIN 2-Phase Spaced Verification & SAFE_TO_RESEND ---');
  clearDb();
  const uncTask = enqueueTask({
    steam_comment_id: 'comm_unc_dual',
    target_steam_id: '76561198088888888',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198088888888',
    reply_text: 'Uncertain dual verify reply',
    scheduled_at: new Date().toISOString()
  });
  replyTasksRepo.updateStatus(uncTask.task_id, 'uncertain_send_state', {
    uncertain_verify_count: 0,
    uncertain_resend_count: 0,
    uncertain_last_checked_at: null
  });

  // Mock checkTargetProfileForExistingComment to return NOT_FOUND (clean profile check)
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => 'NOT_FOUND';

  // Phase 1 Check:
  await scheduler.runUncertainStateRecoveryStep();
  let uncRecord = replyTasksRepo.findByTaskId(uncTask.task_id);
  assert.strictEqual(uncRecord.status, 'uncertain_send_state', 'Phase 1 must not resend; remains uncertain');
  assert.strictEqual(uncRecord.uncertain_verify_count, 1, 'uncertain_verify_count must be 1 after 1st check');
  assert.strictEqual(uncRecord.uncertain_resend_count, 0, 'No resend allowed in Phase 1');

  // Cooldown test: Running immediately within 180s should skip
  let checkCalled = false;
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => {
    checkCalled = true;
    return 'NOT_FOUND';
  };
  await scheduler.runUncertainStateRecoveryStep();
  assert.strictEqual(checkCalled, false, 'Recovery check must be skipped during 180s cooldown');

  // Advance time past 180s for Phase 2 Check
  replyTasksRepo.updateStatus(uncTask.task_id, 'uncertain_send_state', {
    uncertain_last_checked_at: new Date(Date.now() - 200 * 1000).toISOString()
  });

  // Phase 2 Check: 2nd clean inspection -> triggers SAFE_TO_RESEND (resend_count = 1)
  await scheduler.runUncertainStateRecoveryStep();
  uncRecord = replyTasksRepo.findByTaskId(uncTask.task_id);
  assert.strictEqual(uncRecord.status, 'waiting', 'Phase 2 consistent NOT_FOUND must trigger SAFE_TO_RESEND into waiting');
  assert.strictEqual(uncRecord.uncertain_verify_count, 2);
  assert.strictEqual(uncRecord.uncertain_resend_count, 1, 'uncertain_resend_count must increment to 1');
  assert.strictEqual(uncRecord.attempt_count, 1, 'Business attempt count incremented for resend');

  // Terminal Stop: If resent task fails again to UNCERTAIN, and verify passes again:
  replyTasksRepo.updateStatus(uncTask.task_id, 'uncertain_send_state', {
    uncertain_verify_count: 1,
    uncertain_resend_count: 1, // already resent once
    uncertain_last_checked_at: new Date(Date.now() - 200 * 1000).toISOString()
  });
  await scheduler.runUncertainStateRecoveryStep();
  uncRecord = replyTasksRepo.findByTaskId(uncTask.task_id);
  assert.strictEqual(uncRecord.status, 'failed', 'Max 1 resend reached: must strictly terminate to failed');
  console.log('✓ Test 8 Passed: UNCERTAIN 2-phase dual verification & 1-resend maximum limit verified.');

  // =========================================================================
  // Test 9: Verification Network Error Safety Invariant
  // =========================================================================
  console.log('--- Test 9: Verification Network Error Safety Invariant ---');
  clearDb();
  const netErrorTask = enqueueTask({
    steam_comment_id: 'comm_net_err',
    target_steam_id: '76561198077777777',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198077777777',
    reply_text: 'Net error reply',
    scheduled_at: new Date().toISOString()
  });
  replyTasksRepo.updateStatus(netErrorTask.task_id, 'uncertain_send_state', {
    uncertain_verify_count: 1,
    uncertain_resend_count: 0,
    uncertain_last_checked_at: new Date(Date.now() - 200 * 1000).toISOString()
  });

  // Mock network timeout during verification check
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => 'UNCERTAIN';
  await scheduler.runUncertainStateRecoveryStep();

  const netErrorRecord = replyTasksRepo.findByTaskId(netErrorTask.task_id);
  assert.strictEqual(netErrorRecord.status, 'uncertain_send_state', 'Verification error MUST NOT trigger resend');
  assert.strictEqual(netErrorRecord.uncertain_resend_count, 0, 'Resend count must remain 0');
  console.log('✓ Test 9 Passed: Verification network error invariant strictly maintained.');

  // =========================================================================
  // Test 10: Task-Level Cooldown for Moderation Recovery
  // =========================================================================
  console.log('--- Test 10: Task-Level Cooldown for Moderation Recovery ---');
  clearDb();
  const modTask = enqueueTask({
    steam_comment_id: 'comm_mod_cooldown',
    target_steam_id: '76561198066666666',
    target_profile_url: 'https://steamcommunity.com/profiles/76561198066666666',
    reply_text: 'Moderation pending reply',
    scheduled_at: new Date().toISOString()
  });
  replyTasksRepo.updateStatus(modTask.task_id, 'submitted_moderation_pending', {
    uncertain_last_checked_at: new Date(Date.now() - 60 * 1000).toISOString() // checked 1 min ago
  });

  let modChecked = false;
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => {
    modChecked = true;
    return 'MODERATION_PENDING';
  };
  await scheduler.runModerationPendingRecoveryStep();
  assert.strictEqual(modChecked, false, 'Moderation task within 10 min cooldown must be skipped');

  // Advance time past 10 minutes (11 minutes ago)
  replyTasksRepo.updateStatus(modTask.task_id, 'submitted_moderation_pending', {
    uncertain_last_checked_at: new Date(Date.now() - 11 * 60 * 1000).toISOString()
  });
  await scheduler.runModerationPendingRecoveryStep();
  assert.strictEqual(modChecked, true, 'Moderation task past 10 min cooldown must be inspected');
  const modAfter = replyTasksRepo.findByTaskId(modTask.task_id);
  assert.strictEqual(modAfter.status, 'submitted_moderation_pending', 'Still pending must remain submitted_moderation_pending');
  console.log('✓ Test 10 Passed: Task-level 10 min cooldown for moderation verified.');

  // =========================================================================
  // Test 11: Immediate Poll Queueing & Lag Telemetry
  // =========================================================================
  console.log('--- Test 11: Immediate Poll Queueing & Lag Telemetry ---');
  (scheduler as any).isCycleRunning = true;
  scheduler.requestImmediatePoll();
  assert.strictEqual((scheduler as any).pendingImmediatePoll, true, 'Calling requestImmediatePoll while running must set pending flag');

  (scheduler as any).isCycleRunning = false;
  scheduler.runCycle = async () => {}; // Stub runCycle so setTimeout(runCycle, 0) does not launch real browser

  // Poll lag detection test
  scheduler.nextPollExpectedAt = new Date(Date.now() - 120 * 1000).toISOString(); // 2 min ago
  (scheduler as any).scheduleNextPoll();
  assert.strictEqual(scheduler.lastPollLagDetected, true, 'Lag must be detected when overdue > 60s');
  assert.ok(scheduler.lastPollLagSeconds >= 119, 'Lag seconds must reflect overdue time');

  // Normal on-time test
  scheduler.nextPollExpectedAt = new Date(Date.now() + 10 * 1000).toISOString();
  (scheduler as any).scheduleNextPoll();
  assert.strictEqual(scheduler.lastPollLagDetected, false, 'Lag must be false when on time');
  console.log('✓ Test 11 Passed: Immediate poll queueing and lag telemetry verified.');

  // =========================================================================
  // Test 12: Diagnostic Bundle ZIP Generation & Sanitization
  // =========================================================================
  console.log('--- Test 12: Diagnostic Bundle ZIP Generation & Sanitization ---');
  const apiRouter = new ApiRouter({
    scheduler,
    db,
    config,
    logger
  });

  const zipBuffer = await apiRouter.buildDiagnosticsZip();
  assert.ok(Buffer.isBuffer(zipBuffer), 'ZIP result must be a Buffer');
  assert.ok(zipBuffer.length > 100, 'ZIP file must have valid non-empty length');

  // Verify PK header (0x50, 0x4B, 0x03, 0x04)
  assert.strictEqual(zipBuffer[0], 0x50, 'PKZip magic byte 0');
  assert.strictEqual(zipBuffer[1], 0x4b, 'PKZip magic byte 1');
  assert.strictEqual(zipBuffer[2], 0x03, 'PKZip magic byte 2');
  assert.strictEqual(zipBuffer[3], 0x04, 'PKZip magic byte 3');

  // Test content sanitization
  const secretObj = {
    apiKey: 'sk-secret-1234567890abcdef',
    cookie: 'sessionid=abc123secret; steamLoginSecure=super_secret;',
    safeValue: 'normal_text'
  };
  const sanitized = sanitizeDiagnosticObject(secretObj);
  assert.strictEqual(sanitized.apiKey, '[REDACTED]');
  assert.strictEqual(sanitized.cookie, '[REDACTED]');
  assert.strictEqual(sanitized.safeValue, 'normal_text');

  const secretText = 'Here is steamLoginSecure=abcdef123456 and apiKey=sk-xyz987 in log line';
  const sanitizedText = sanitizeDiagnosticText(secretText);
  assert.ok(!sanitizedText.includes('abcdef123456'), 'Sensitive token must be redacted from text');
  assert.ok(!sanitizedText.includes('sk-xyz987'), 'API key must be redacted from text');
  // =========================================================================
  // Test 13: Pagination Edge Cases (Network Failure & DOM Fallback)
  // =========================================================================
  console.log('--- Test 13: Pagination Network Failure & DOM Fallback ---');
  // 1. Fallback when g_rgCommentThreads and pagination DOM are absent
  const dummyPageEmpty = {
    evaluate: async () => ({ triggered: false }),
    waitForTimeout: async () => {}
  };
  const triggerResult = await CommentMonitor.triggerNextPage(dummyPageEmpty);
  assert.strictEqual(triggerResult, false, 'Missing threads/DOM must cleanly return false without throwing');

  // 2. Mid-pagination network disconnect in CommentMonitor
  const dummyBrowserNetErr = {
    openEphemeralPage: async () => ({
      context: () => ({ newCDPSession: async () => ({ send: async () => {} }) }),
      goto: async () => {},
      waitForSelector: async () => {},
      url: () => 'https://steamcommunity.com/id/test/',
      waitForTimeout: async () => {},
      close: async () => {}
    })
  };
  const netErrMonitor = new CommentMonitor(dummyBrowserNetErr, 'https://steamcommunity.com/id/test/', logger);
  let netErrCallCount = 0;
  netErrMonitor.extractCommentsFromPage = async () => {
    return [{ commentId: 'c_mid_1', commenterName: 'a', commenterProfileUrl: 'p', commenterSteamId: '1', content: 'hello' }];
  };
  netErrMonitor.triggerNextPage = async () => {
    netErrCallCount++;
    throw new Error('net::ERR_INTERNET_DISCONNECTED: Connection lost mid-pagination');
  };

  // Calling fetchComments with an unseen cursor should fetch page 1, catch the network error on pagination,
  // and preserve already-fetched comments without crashing.
  const midNetComments = await netErrMonitor.fetchComments('cursor_never_seen');
  assert.strictEqual(midNetComments.length, 1, 'Comments fetched before network drop must be safely preserved');
  assert.strictEqual(midNetComments[0].commentId, 'c_mid_1');

  // 3. CommentSender verification mid-pagination error returns UNCERTAIN
  const dummyBrowserVerifyErr = {
    openEphemeralPage: async () => {
      throw new Error('net::ERR_CONNECTION_RESET during profile open');
    }
  };
  const senderWithNetErr = new (require('../../dist/steam/commentSender').CommentSender)(
    dummyBrowserVerifyErr,
    'https://steamcommunity.com/id/bot/',
    logger
  );
  const verifyRes = await senderWithNetErr.checkTargetProfileForExistingComment(
    'https://steamcommunity.com/id/target/',
    'some text'
  );
  assert.strictEqual(verifyRes, 'UNCERTAIN', 'Network error during verification must return UNCERTAIN');
  console.log('✓ Test 13 Passed: Pagination network disconnect and DOM fallback gracefully handled.');

  // =========================================================================
  // Test 14: Recovery Non-blocking & Immediate Poll Queueing Under Latency
  // =========================================================================
  console.log('--- Test 14: Recovery Non-blocking & Immediate Poll Under High Latency ---');
  clearDb();
  // Insert 10 moderation and 10 uncertain tasks (20 total)
  for (let i = 1; i <= 10; i++) {
    const t = enqueueTask({
      steam_comment_id: `heavy_mod_${i}`,
      target_steam_id: `7656119800000100${i}`,
      target_profile_url: `https://steamcommunity.com/profiles/7656119800000100${i}`,
      reply_text: `Heavy mod task ${i}`,
      scheduled_at: new Date().toISOString()
    });
    replyTasksRepo.updateStatus(t.task_id, 'submitted_moderation_pending');
  }
  for (let i = 1; i <= 10; i++) {
    const t = enqueueTask({
      steam_comment_id: `heavy_unc_${i}`,
      target_steam_id: `7656119800000200${i}`,
      target_profile_url: `https://steamcommunity.com/profiles/7656119800000200${i}`,
      reply_text: `Heavy unc task ${i}`,
      scheduled_at: new Date().toISOString()
    });
    replyTasksRepo.updateStatus(t.task_id, 'uncertain_send_state', {
      uncertain_last_checked_at: new Date(Date.now() - 300 * 1000).toISOString()
    });
  }

  let recoveryTasksInspected = 0;
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => {
    recoveryTasksInspected++;
    // Simulate delayed response (e.g. Steam network sluggishness)
    await new Promise(r => setTimeout(r, 20));
    return 'MODERATION_PENDING';
  };

  // Run moderation and uncertain recovery steps
  await scheduler.runModerationPendingRecoveryStep();
  assert.strictEqual(recoveryTasksInspected, 3, 'Moderation recovery must strictly process at most 3 tasks');

  recoveryTasksInspected = 0;
  scheduler.commentSender.checkTargetProfileForExistingComment = async () => {
    recoveryTasksInspected++;
    await new Promise(r => setTimeout(r, 20));
    return 'UNCERTAIN';
  };
  await scheduler.runUncertainStateRecoveryStep();
  assert.strictEqual(recoveryTasksInspected, 3, 'Uncertain recovery must strictly process at most 3 tasks');

  // Verify Immediate Poll queueing while cycle is running
  (scheduler as any).isCycleRunning = true;
  assert.strictEqual((scheduler as any).pendingImmediatePoll, false);

  // External trigger (e.g. webhook or manual refresh) requests immediate poll while cycle is executing
  scheduler.requestImmediatePoll();
  assert.strictEqual((scheduler as any).pendingImmediatePoll, true, 'requestImmediatePoll must not be lost while cycle is running');

  // Cycle finishes
  (scheduler as any).isCycleRunning = false;
  scheduler.runCycle = async () => {
    scheduler.isRunning = false;
  };

  // Scheduler finishes cycle and triggers scheduleNextPoll()
  (scheduler as any).scheduleNextPoll();
  assert.strictEqual((scheduler as any).pendingImmediatePoll, false, 'Queued immediate poll must be consumed');
  assert.ok(
    new Date(scheduler.nextPollExpectedAt).getTime() <= Date.now() + 500,
    'Immediate poll must be scheduled immediately (delay <= 500ms) rather than waiting full interval'
  );
  scheduler.isRunning = false;
  if ((scheduler as any).timerHandle) {
    clearTimeout((scheduler as any).timerHandle);
    (scheduler as any).timerHandle = null;
  }
  console.log('✓ Test 14 Passed: Recovery strictly bounded; immediate poll guaranteed without starvation.');

  db.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('\n====================================================');
  console.log('  All Suite 31 Tests Completed Successfully! (14/14)');
  console.log('====================================================\n');
}

module.exports = { runPollDecouplingAndCatchupTests };

if (require.main === module) {
  runPollDecouplingAndCatchupTests().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Suite 31 Failed:', err);
    process.exit(1);
  });
}
