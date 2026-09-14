const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runNicknameResolverTests() {
  console.log('--- Running Nickname Resolver & Time Greeting Tests ---');

  const { NicknameResolver } = require('../../dist/reply/nicknameResolver');
  const { TimeGreeting } = require('../../dist/reply/timeGreeting');
  const { TemplateEngine } = require('../../dist/rules/templateEngine');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { NicknameMemoryRepository } = require('../../dist/db/repositories/nicknameMemory');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');
  const { DEFAULT_CONFIG } = require('../../dist/config/schema');

  const testDbPath = path.resolve(__dirname, 'test-nickname.db');
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  const db = new AppDatabase(testDbPath);
  runMigrations(db);

  const nicknameRepo = new NicknameMemoryRepository(db);
  const resolver = new NicknameResolver(nicknameRepo);

  // ============================================================
  // Test 1: 小鱼 → 小鱼
  // ============================================================
  console.log('--- Test 1: 小鱼 → 小鱼 ---');
  const res1 = resolver.resolve('steam_1', '小鱼');
  assert.strictEqual(res1, '小鱼', 'Should resolve 小鱼 to 小鱼');
  console.log('  -> Test 1 Passed: 小鱼 ->', res1);

  // ============================================================
  // Test 2: 阿伟 → 阿伟
  // ============================================================
  console.log('--- Test 2: 阿伟 → 阿伟 ---');
  const res2 = resolver.resolve('steam_2', '阿伟');
  assert.strictEqual(res2, '阿伟', 'Should resolve 阿伟 to 阿伟');
  console.log('  -> Test 2 Passed: 阿伟 ->', res2);

  // ============================================================
  // Test 3: 凤梨罐头 → 合理简称或 null
  // ============================================================
  console.log('--- Test 3: 凤梨罐头 → 合理简称 (凤梨) ---');
  const res3 = resolver.resolve('steam_3', '凤梨罐头');
  assert.ok(res3 === '凤梨' || res3 === '罐头' || res3 === null, 'Should resolve 凤梨罐头 to 凤梨/罐头/null');
  console.log('  -> Test 3 Passed: 凤梨罐头 ->', res3);

  // ============================================================
  // Test 4: 猫羽雫 → 合理简称或 null
  // ============================================================
  console.log('--- Test 4: 猫羽雫 → 合理简称 (小雫 / 雫) ---');
  const res4 = resolver.resolve('steam_4', '猫羽雫');
  assert.ok(res4 === '小雫' || res4 === '雫' || res4 === null, 'Should resolve 猫羽雫 to 小雫/雫/null');
  console.log('  -> Test 4 Passed: 猫羽雫 ->', res4);

  // ============================================================
  // Test 5: Miku → Miku
  // ============================================================
  console.log('--- Test 5: Miku → Miku ---');
  const res5 = resolver.resolve('steam_5', 'Miku');
  assert.strictEqual(res5, 'Miku', 'Should resolve clean Latin name Miku to Miku');
  console.log('  -> Test 5 Passed: Miku ->', res5);

  // ============================================================
  // Test 6: 复杂乱码昵称 → null
  // ============================================================
  console.log('--- Test 6: 复杂乱码昵称 → null ---');
  const garbledNames = [
    '\u0000\u0001\u0002asdf',
    'xXx_998124_#$!@#%',
    'http://steamcommunity.com/id/scammer',
    '加V购买游戏辅助.com',
    '1234567890',
    '$$$$$$$$$$'
  ];
  for (const name of garbledNames) {
    const res = resolver.resolve('steam_garbled', name);
    assert.strictEqual(res, null, `Garbled/unsafe name "${name}" must resolve to null`);
  }
  console.log('  -> Test 6 Passed: Complex garbled/unsafe names all resolved to null');

  // ============================================================
  // Test 7: 纯符号昵称 → null
  // ============================================================
  console.log('--- Test 7: 纯符号昵称 → null ---');
  const pureSymbols = [
    '★✨🐾',
    '---==---',
    '~!@#$%^&*()_+',
    '【】',
    '   '
  ];
  for (const sym of pureSymbols) {
    const res = resolver.resolve('steam_sym', sym);
    assert.strictEqual(res, null, `Pure symbol string "${sym}" must resolve to null`);
  }
  console.log('  -> Test 7 Passed: Pure symbol strings all resolved to null');

  // ============================================================
  // Test 8 & 9: 视觉回复不会调用 nicknameResolver，文字回复会调用
  // ============================================================
  console.log('--- Test 8 & 9: 视觉回复不调用 nicknameResolver，文字回复会调用 ---');
  let nicknameCallCount = 0;
  const spyResolver = {
    resolveSafe: (steamId, originalName) => {
      nicknameCallCount++;
      return resolver.resolveSafe(steamId, originalName);
    }
  };

  const scheduler = new TaskScheduler(
    { ...DEFAULT_CONFIG, BOT_ENABLED: true, STEAM_PROFILE_URL: 'https://steamcommunity.com/id/my_bot_profile' },
    db
  );
  scheduler.nicknameResolver = spyResolver;

  // 8. Visual comment: ASCII / Braille / large emoji
  const visualComment = {
    commentId: 'comment_vis_1',
    commenterName: '小鱼',
    commenterSteamId: '76561198000000001',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000001',
    content: '⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\n⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿',
    timestampStr: new Date().toISOString()
  };

  const initialCount = nicknameCallCount;
  const diagVisual = await scheduler.processComment(visualComment, 1, { persistAndDispatch: false });
  assert.strictEqual(nicknameCallCount, initialCount, 'Visual reply must strictly NOT call nicknameResolver');
  assert.strictEqual(diagVisual.visualExpression, true, 'Should be recognized as visual expression');
  console.log('  -> Test 8 Passed: Visual comment produced 0 calls to nicknameResolver');

  // 9. Text greeting comment
  const textComment = {
    commentId: 'comment_txt_1',
    commenterName: '小鱼',
    commenterSteamId: '76561198000000002',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000002',
    content: '早上好呀！',
    timestampStr: new Date().toISOString()
  };

  const beforeTextCallCount = nicknameCallCount;
  const diagText = await scheduler.processComment(textComment, 2, { persistAndDispatch: false });
  assert.ok(nicknameCallCount > beforeTextCallCount, 'Text greeting must call nicknameResolver');
  assert.strictEqual(diagText.action, 'REPLY_LOCAL', 'Text greeting should generate local reply');
  console.log('  -> Test 9 Passed: Text greeting successfully called nicknameResolver');

  // ============================================================
  // Test 10: resolver 失败时正常生成不带称呼的文字回复
  // ============================================================
  console.log('--- Test 10: resolver 失败/抛异常时正常生成不带称呼的文字回复 ---');
  const failingScheduler = new TaskScheduler(
    { ...DEFAULT_CONFIG, BOT_ENABLED: true, STEAM_PROFILE_URL: 'https://steamcommunity.com/id/my_bot_profile' },
    db
  );
  failingScheduler.nicknameResolver = {
    resolveSafe: () => {
      throw new Error('Unexpected resolver crash');
    }
  };

  const commentWithFailingResolver = {
    commentId: 'comment_fail_1',
    commenterName: '测试用户',
    commenterSteamId: '76561198000000003',
    commenterProfileUrl: 'https://steamcommunity.com/profiles/76561198000000003',
    content: '你好呀～',
    timestampStr: new Date().toISOString()
  };

  const diagFail = await failingScheduler.processComment(commentWithFailingResolver, 3, { persistAndDispatch: false });
  assert.strictEqual(diagFail.action, 'REPLY_LOCAL', 'Should still produce local reply even if resolver throws');
  assert.strictEqual(diagFail.skipReason, 'NONE');
  console.log('  -> Test 10 Passed: Exception in resolver cleanly fell back without failing');

  // ============================================================
  // Test 11-14: 时间段判定与对应模板
  // 05:00–10:59 → 早上好
  // 11:00–13:59 → 中午好
  // 14:00–17:59 → 下午好
  // 18:00–04:59 → 晚上好
  // ============================================================
  console.log('--- Test 11-14: 时间段判定 ---');
  // 11. 早上 (08:30)
  const morningDate = new Date(2026, 8, 13, 8, 30, 0);
  assert.strictEqual(TimeGreeting.getTimePeriod(morningDate), 'morning');
  const morningGreeting = TimeGreeting.generate({ nickname: '小鱼', date: morningDate });
  assert.ok(/小鱼，(早上好|早安)/.test(morningGreeting), `Morning greeting should contain morning text: ${morningGreeting}`);
  console.log('  -> Test 11 Passed: Morning greeting:', morningGreeting);

  // 12. 中午 (12:15)
  const noonDate = new Date(2026, 8, 13, 12, 15, 0);
  assert.strictEqual(TimeGreeting.getTimePeriod(noonDate), 'noon');
  const noonGreeting = TimeGreeting.generate({ nickname: 'Miku', date: noonDate });
  assert.ok(/Miku，中午好/.test(noonGreeting), `Noon greeting should contain noon text: ${noonGreeting}`);
  console.log('  -> Test 12 Passed: Noon greeting:', noonGreeting);

  // 13. 下午 (15:45)
  const afternoonDate = new Date(2026, 8, 13, 15, 45, 0);
  assert.strictEqual(TimeGreeting.getTimePeriod(afternoonDate), 'afternoon');
  const afternoonGreeting = TimeGreeting.generate({ nickname: '阿伟', date: afternoonDate });
  assert.ok(/阿伟，下午好/.test(afternoonGreeting), `Afternoon greeting should contain afternoon text: ${afternoonGreeting}`);
  console.log('  -> Test 13 Passed: Afternoon greeting:', afternoonGreeting);

  // 14. 晚上 (21:00) 与 深夜 (02:00)
  const eveningDate = new Date(2026, 8, 13, 21, 0, 0);
  assert.strictEqual(TimeGreeting.getTimePeriod(eveningDate), 'evening');
  const eveningGreeting = TimeGreeting.generate({ nickname: '凤梨', date: eveningDate });
  assert.ok(/凤梨，晚上好/.test(eveningGreeting), `Evening greeting should contain evening text: ${eveningGreeting}`);

  const lateNightDate = new Date(2026, 8, 13, 2, 0, 0);
  assert.strictEqual(TimeGreeting.getTimePeriod(lateNightDate), 'evening');
  console.log('  -> Test 14 Passed: Evening and late night greetings:', eveningGreeting);

  // ============================================================
  // Test 15: 没有称呼时仍能正常发送“晚上好～”
  // ============================================================
  console.log('--- Test 15: 没有称呼时仍能正常发送无称呼版本 ---');
  const noNickGreeting = TimeGreeting.generate({ nickname: null, date: eveningDate });
  assert.ok(!noNickGreeting.includes('，'), 'Greeting without nickname must not have leading comma');
  assert.ok(/晚上好/.test(noNickGreeting), `Should contain greeting without nickname: ${noNickGreeting}`);
  console.log('  -> Test 15 Passed: Greeting without nickname:', noNickGreeting);

  // ============================================================
  // Test 16: 称呼记忆持久化与优先读取
  // ============================================================
  console.log('--- Test 16: 称呼记忆持久化与手动覆盖 ---');
  const testSteamId = '76561198999999999';
  // First time resolution -> saves to db
  const firstResolved = resolver.resolve(testSteamId, '小鱼');
  assert.strictEqual(firstResolved, '小鱼');

  const savedRecord = nicknameRepo.findBySteamId(testSteamId);
  assert.ok(savedRecord, 'Record must be saved in nickname_memory table');
  assert.strictEqual(savedRecord.preferred_name, '小鱼');

  // User manual override
  nicknameRepo.setPreferredName(testSteamId, '鱼宝');
  const secondResolved = resolver.resolve(testSteamId, '小鱼');
  assert.strictEqual(secondResolved, '鱼宝', 'Subsequent resolution must prefer stored user preference');
  console.log('  -> Test 16 Passed: Nickname memory stored, loaded, and overridable');

  // Clean up
  db.close();
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }

  console.log('\n====================================================');
  console.log('   All Nickname Resolver & Time Greeting Tests PASSED!');
  console.log('====================================================\n');
}

module.exports = { runNicknameResolverTests };
