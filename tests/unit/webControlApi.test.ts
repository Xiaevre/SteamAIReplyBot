const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runWebControlApiTests() {
  console.log('--- Running Web Control API Unit Tests ---');

  const { WebServer } = require('../../dist/server/webServer');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { Logger } = require('../../dist/utils/logger');
  const { loadConfig } = require('../../dist/config/env');
  const { RuntimeControl } = require('../../dist/config/runtimeControl');

  const testDbPath = path.resolve(__dirname, 'test-web-api.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const logger = new Logger();
  logger.info('TEST_INIT_EVENT', { note: 'sample log entry' });

  const config = loadConfig();
  config.STEAM_PROFILE_URL = 'https://steamcommunity.com/id/testuser/';

  const server = new WebServer({
    db,
    config,
    logger
  });

  const port = await server.start(3120);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/status
    console.log('--- Test 1: GET /api/status ---');
    const resStatus = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(resStatus.status, 200);
    const dataStatus = await resStatus.json();
    assert.strictEqual(dataStatus.success, true);
    assert.ok(dataStatus.stats !== undefined);
    assert.ok(dataStatus.memoryMb > 0);
    console.log('  -> Test 1 Passed: /api/status returned status summary');

    // 2. GET /api/stats
    console.log('--- Test 2: GET /api/stats ---');
    const resStats = await fetch(`${baseUrl}/api/stats`);
    assert.strictEqual(resStats.status, 200);
    const dataStats = await resStats.json();
    assert.strictEqual(dataStats.success, true);
    assert.strictEqual(typeof dataStats.pendingCount, 'number');
    console.log('  -> Test 2 Passed: /api/stats returned metrics');

    // 3. GET /api/tasks
    console.log('--- Test 3: GET /api/tasks ---');
    const resTasks = await fetch(`${baseUrl}/api/tasks?limit=10`);
    assert.strictEqual(resTasks.status, 200);
    const dataTasks = await resTasks.json();
    assert.strictEqual(dataTasks.success, true);
    assert.ok(Array.isArray(dataTasks.tasks));
    console.log('  -> Test 3 Passed: /api/tasks returned task array');

    // 4. GET /api/logs
    console.log('--- Test 4: GET /api/logs ---');
    const resLogs = await fetch(`${baseUrl}/api/logs?limit=50`);
    assert.strictEqual(resLogs.status, 200);
    const dataLogs = await resLogs.json();
    assert.strictEqual(dataLogs.success, true);
    assert.ok(Array.isArray(dataLogs.logs));
    assert.ok(dataLogs.logs.some(l => l.event === 'TEST_INIT_EVENT'));
    console.log('  -> Test 4 Passed: /api/logs captured memory log entries');

    // 5. Bot Control: Pause & Resume
    console.log('--- Test 5: POST /api/bot/pause and resume ---');
    const resPause = await fetch(`${baseUrl}/api/bot/pause`, { method: 'POST' });
    assert.strictEqual(resPause.status, 200);
    const dataPause = await resPause.json();
    assert.strictEqual(dataPause.botEnabled, false);
    assert.strictEqual(RuntimeControl.load().botEnabled, false);

    const resResume = await fetch(`${baseUrl}/api/bot/resume`, { method: 'POST' });
    assert.strictEqual(resResume.status, 200);
    const dataResume = await resResume.json();
    assert.strictEqual(dataResume.botEnabled, true);
    assert.strictEqual(RuntimeControl.load().botEnabled, true);
    console.log('  -> Test 5 Passed: Bot pause and resume state confirmed');

    // 6. Config Save & Key Masking Verification
    console.log('--- Test 6: POST /api/config ---');
    const resConfig = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CHECK_INTERVAL_MIN_SECONDS: 77 })
    });
    assert.strictEqual(resConfig.status, 200);
    const dataConfig = await resConfig.json();
    assert.strictEqual(dataConfig.success, true);
    assert.strictEqual(config.CHECK_INTERVAL_MIN_SECONDS, 77);
    console.log('  -> Test 6 Passed: Dynamic config update verified');

    // 7. GET /api/config Key Masking
    console.log('--- Test 7: GET /api/config API Key Masking ---');
    config.DEEPSEEK_API_KEY = 'mock_secretkey_1234567890abcdef';
    const resGetConfig = await fetch(`${baseUrl}/api/config`);
    assert.strictEqual(resGetConfig.status, 200);
    const dataGetConfig = await resGetConfig.json();
    assert.strictEqual(dataGetConfig.success, true);
    assert.ok(dataGetConfig.config.DEEPSEEK_API_KEY.includes('****'));
    assert.ok(!dataGetConfig.config.DEEPSEEK_API_KEY.includes('secretkey'));
    console.log(`  -> Test 7 Passed: Masked API key: ${dataGetConfig.config.DEEPSEEK_API_KEY}`);

    // 8. Emergency Stop & Start
    console.log('--- Test 8: POST /api/bot/emergency-stop & /api/bot/start ---');
    const resEmergency = await fetch(`${baseUrl}/api/bot/emergency-stop`, { method: 'POST' });
    assert.strictEqual(resEmergency.status, 200);
    const dataEmergency = await resEmergency.json();
    assert.strictEqual(dataEmergency.emergencyStop, true);
    assert.strictEqual(RuntimeControl.load().emergencyStop, true);

    const resStart = await fetch(`${baseUrl}/api/bot/start`, { method: 'POST' });
    assert.strictEqual(resStart.status, 200);
    const dataStart = await resStart.json();
    assert.strictEqual(dataStart.botEnabled, true);
    assert.strictEqual(dataStart.emergencyStop, false);
    assert.strictEqual(RuntimeControl.load().emergencyStop, false);
    console.log('  -> Test 8 Passed: Emergency stop and Start verified');

    // 9. Static UI Assets Delivery
    console.log('--- Test 9: Static UI Files Serving ---');
    const resIndex = await fetch(`${baseUrl}/`);
    assert.strictEqual(resIndex.status, 200);
    const indexHtml = await resIndex.text();
    assert.ok(indexHtml.includes('Steam AI Reply Bot'));
    assert.ok(indexHtml.includes('data-view="dashboard"'));
    assert.ok(indexHtml.includes('data-view="tasks"'));
    assert.ok(indexHtml.includes('data-view="session"'));
    assert.ok(indexHtml.includes('data-view="settings"'));
    assert.ok(indexHtml.includes('data-view="logs"'));
    assert.ok(indexHtml.includes('data-view="visual-replies"'));

    // Verify section independence
    const logsCloseIdx = indexHtml.indexOf('</section>', indexHtml.indexOf('id="view-logs"'));
    const visualOpenIdx = indexHtml.indexOf('id="view-visual-replies"');
    assert.ok(logsCloseIdx < visualOpenIdx, 'view-logs MUST be closed before view-visual-replies begins');
    assert.ok(indexHtml.includes('id="visual-type-pills"'), 'Top type filter pills must be present');

    const resCss = await fetch(`${baseUrl}/style.css`);
    assert.strictEqual(resCss.status, 200);
    const cssText = await resCss.text();
    assert.ok(cssText.includes('.app-container'));
    assert.ok(cssText.includes('.visual-cat-pill'));

    const resJs = await fetch(`${baseUrl}/app.js`);
    assert.strictEqual(resJs.status, 200);
    const jsText = await resJs.text();
    assert.ok(jsText.includes('setupNavigation'));
    assert.ok(jsText.includes('fetchVisualReplies'));
    assert.ok(jsText.includes('renderVisualReplies'));
    console.log('  -> Test 9 Passed: HTML, CSS, JS assets delivered correctly');

    // 10. GET /api/visual-replies
    console.log('--- Test 10: GET /api/visual-replies ---');
    const resVisual = await fetch(`${baseUrl}/api/visual-replies`);
    assert.strictEqual(resVisual.status, 200);
    const dataVisual = await resVisual.json();
    assert.strictEqual(dataVisual.success, true);
    assert.ok(dataVisual.count >= 10, 'Curated library should contain initial items');
    console.log(`  -> Test 10 Passed: Loaded ${dataVisual.count} visual items via API`);

    // 11. GET /api/visual-replies?type=braille
    console.log('--- Test 11: GET /api/visual-replies?type=braille ---');
    const resBraille = await fetch(`${baseUrl}/api/visual-replies?type=braille`);
    assert.strictEqual(resBraille.status, 200);
    const dataBraille = await resBraille.json();
    assert.strictEqual(dataBraille.success, true);
    assert.ok(dataBraille.items.every((i: any) => i.type === 'braille'));
    console.log(`  -> Test 11 Passed: Filtered ${dataBraille.count} braille items`);

    // 12. POST /api/visual-replies (Create)
    console.log('--- Test 12: POST /api/visual-replies (Create) ---');
    const testItemId = 'test_web_api_custom_001';
    const resCreate = await fetch(`${baseUrl}/api/visual-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: testItemId,
        type: 'custom',
        content: '(=^･ω･^=) Test Cat',
        weight: 30,
        tags: ['cat', 'test'],
        mood: ['friendly']
      })
    });
    assert.strictEqual(resCreate.status, 200);
    const dataCreate = await resCreate.json();
    assert.strictEqual(dataCreate.success, true);
    assert.strictEqual(dataCreate.item.id, testItemId);
    console.log('  -> Test 12 Passed: Created custom visual item');

    // 13. POST /api/visual-replies/toggle
    console.log('--- Test 13: POST /api/visual-replies/toggle ---');
    const resToggle = await fetch(`${baseUrl}/api/visual-replies/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: testItemId, enabled: false })
    });
    assert.strictEqual(resToggle.status, 200);
    const dataToggle = await resToggle.json();
    assert.strictEqual(dataToggle.success, true);
    assert.strictEqual(dataToggle.item.enabled, false);
    console.log('  -> Test 13 Passed: Toggled visual item enabled status');

    // 14. POST /api/visual-replies/delete
    console.log('--- Test 14: POST /api/visual-replies/delete ---');
    const resDel = await fetch(`${baseUrl}/api/visual-replies/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: testItemId })
    });
    assert.strictEqual(resDel.status, 200);
    const dataDel = await resDel.json();
    assert.strictEqual(dataDel.success, true);
    assert.strictEqual(dataDel.deleted, true);
    console.log('  -> Test 14 Passed: Deleted test visual item');

    // 15. POST /api/profile-analysis/sync API tests
    console.log('--- Test 15: POST /api/profile-analysis/sync lifecycle & status ---');
    let syncCalled = false;
    let syncBusy = false;
    const mockProfileManager = {
      isBusy: () => syncBusy,
      getStatus: () => ({
        status: syncBusy ? 'syncing' : 'completed',
        lastSyncAt: new Date().toISOString(),
        lastAnalyzedAt: null,
        currentFingerprint: 'mock_fp_123',
        lastError: null
      }),
      syncProfile: async (bm, steamId) => {
        syncCalled = true;
        syncBusy = true;
        return { success: true };
      }
    };

    server.ctx.scheduler = {
      browserManager: { isMockBrowser: true },
      profileAnalysisManager: mockProfileManager,
      knowledgeStore: {
        loadMeta: () => mockProfileManager.getStatus()
      }
    };

    const resSync = await fetch(`${baseUrl}/api/profile-analysis/sync`, { method: 'POST' });
    assert.strictEqual(resSync.status, 200);
    const dataSync = await resSync.json();
    assert.strictEqual(dataSync.success, true);
    assert.strictEqual(dataSync.status, 'syncing');
    assert.strictEqual(syncCalled, true);
    console.log('  -> Test 15 Passed: /api/profile-analysis/sync properly started background job with status=syncing');

    // 16. Concurrency 409 rejection when busy
    console.log('--- Test 16: POST /api/profile-analysis/sync rejects 409 when busy ---');
    const resSyncBusy = await fetch(`${baseUrl}/api/profile-analysis/sync`, { method: 'POST' });
    assert.strictEqual(resSyncBusy.status, 409);
    const dataSyncBusy = await resSyncBusy.json();
    assert.strictEqual(dataSyncBusy.success, false);
    assert.ok(dataSyncBusy.error.includes('already in progress'));
    console.log('  -> Test 16 Passed: Duplicate sync returned HTTP 409 Conflict');

    // 17. GET /api/profile-analysis/status
    console.log('--- Test 17: GET /api/profile-analysis/status ---');
    syncBusy = false;
    const resProfileStatus = await fetch(`${baseUrl}/api/profile-analysis/status`);
    assert.strictEqual(resProfileStatus.status, 200);
    const dataProfileStatus = await resProfileStatus.json();
    assert.strictEqual(dataProfileStatus.success, true);
    assert.strictEqual(dataProfileStatus.meta.currentFingerprint, 'mock_fp_123');
    console.log('  -> Test 17 Passed: /api/profile-analysis/status returned live meta');

    console.log('✅ All Web Control API & Static UI tests PASSED!\n');
  } finally {
    await server.stop();
    db.close();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  }
}

module.exports = { runWebControlApiTests };

if (require.main === module) {
  runWebControlApiTests().catch(err => {
    console.error('Test failure:', err);
    process.exit(1);
  });
}
