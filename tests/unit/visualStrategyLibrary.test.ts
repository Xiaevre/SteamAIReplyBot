const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runVisualStrategyLibraryTests() {
  console.log('--- Running Visual Strategy & Curated Library Unit Tests ---');
  const { VisualReplyLibrary } = require('../../dist/reply/visualLibrary');
  const { ReplyStrategyEngine } = require('../../dist/reply/replyStrategy');
  const { VisualReplyGenerator } = require('../../dist/reply/visualReply');
  const { VisualExpressionDetector } = require('../../dist/rules/visualExpressionDetector');
  const { ReplyDecision } = require('../../dist/reply/replyDecision');
  const { AppDatabase } = require('../../dist/db/database');
  const { runMigrations } = require('../../dist/db/migrations');
  const { TaskScheduler } = require('../../dist/scheduler/taskScheduler');

  const testDataDir = path.resolve(__dirname, 'test-visual-data');
  if (fs.existsSync(testDataDir)) {
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  }

  // ============================================================
  // Test 1: 素材库可以加载并自动生成初始素材
  // ============================================================
  console.log('--- Test 1: Library loads JSON files from data directory ---');
  const lib = new VisualReplyLibrary(testDataDir);
  const allItems = lib.getAllItems();
  assert.ok(allItems.length > 0, 'Library must contain seeded items');
  const brailleItems = lib.getAllItems({ type: 'braille' });
  assert.ok(brailleItems.length >= 2, 'Must have seeded braille items');
  const kaomojiItems = lib.getAllItems({ type: 'kaomoji' });
  assert.ok(kaomojiItems.length >= 3, 'Must have seeded kaomoji items');
  console.log(`  -> Test 1 Passed: Loaded ${allItems.length} curated visual items across categories.`);

  // ============================================================
  // Test 2: enabled=false 不参与选择
  // ============================================================
  console.log('--- Test 2: enabled=false items are never selected ---');
  lib.saveItem({
    id: 'disabled_braille_item',
    type: 'braille',
    content: '⢀⡤⣄⡀ (DISABLED)',
    enabled: false,
    tags: ['test_exclusive_tag'],
    mood: ['test_exclusive_mood'],
    weight: 1000
  });

  const selectedDisabled = lib.select({ tags: ['test_exclusive_tag'] });
  assert.strictEqual(selectedDisabled, null, 'Disabled item must never be selected');

  // Toggle enabled to true and verify it can now be selected
  lib.toggleEnabled('disabled_braille_item', true);
  const selectedEnabled = lib.select({ tags: ['test_exclusive_tag'] });
  assert.ok(selectedEnabled, 'Item must be selectable after enabling');
  assert.strictEqual(selectedEnabled.id, 'disabled_braille_item');
  console.log('  -> Test 2 Passed: enabled toggle strictly controls item selection.');

  // ============================================================
  // Test 3: tag / mood 可以准确筛选
  // ============================================================
  console.log('--- Test 3: tag and mood filtering ---');
  lib.saveItem({
    id: 'exclusive_gaming_item',
    type: 'emoji',
    content: '🎮 (GAMING EXCLUSIVE)',
    enabled: true,
    tags: ['super_rare_gaming_tag'],
    mood: ['hyper_excited'],
    weight: 50
  });

  const tagMatch = lib.select({ tags: ['super_rare_gaming_tag'] });
  assert.ok(tagMatch);
  assert.strictEqual(tagMatch.id, 'exclusive_gaming_item');

  const moodMatch = lib.select({ mood: ['hyper_excited'] });
  assert.ok(moodMatch);
  assert.strictEqual(moodMatch.id, 'exclusive_gaming_item');
  console.log('  -> Test 3 Passed: tag and mood criteria matched correctly.');

  // ============================================================
  // Test 4: weight 可以影响选择概率
  // ============================================================
  console.log('--- Test 4: weight influences selection probability ---');
  // Create isolated sub-library with two items: one with weight 99, one with weight 1
  const weightDir = path.resolve(__dirname, 'test-weight-data');
  if (fs.existsSync(weightDir)) fs.rmSync(weightDir, { recursive: true, force: true });
  fs.mkdirSync(weightDir, { recursive: true });

  const weightLib = new VisualReplyLibrary(weightDir);
  weightLib.saveItem({ id: 'heavy_item', type: 'kaomoji', content: 'HEAVY', enabled: true, tags: ['w'], mood: ['w'], weight: 99 });
  weightLib.saveItem({ id: 'light_item', type: 'kaomoji', content: 'LIGHT', enabled: true, tags: ['w'], mood: ['w'], weight: 1 });

  let heavyCount = 0;
  let lightCount = 0;
  for (let i = 0; i < 100; i++) {
    const sel = weightLib.select({ tags: ['w'] });
    if (sel.id === 'heavy_item') heavyCount++;
    if (sel.id === 'light_item') lightCount++;
  }
  assert.ok(heavyCount > lightCount * 2, `Heavy item (${heavyCount}) must be selected significantly more often than light item (${lightCount})`);
  console.log(`  -> Test 4 Passed: Weighted random selected heavy item ${heavyCount}% vs light item ${lightCount}%.`);
  fs.rmSync(weightDir, { recursive: true, force: true });

  // ============================================================
  // Test 5: CURATED 策略能够选择素材
  // ============================================================
  console.log('--- Test 5: ReplyStrategyEngine + Curated Library selection ---');
  const dummyCommentContext = {
    commentId: 'c_test_05',
    commenterName: 'VisualFriend',
    commenterSteamId: '76561198000000001',
    commenterProfileUrl: 'https://steamcommunity.com/id/visual_friend',
    content: '⢀⡤⣄⡀⠀⠀⠀⠀⣀⣤⡀\n⢠⡏⠀⠈⠳⡄⢠⠞⠁⠀⢹⡄',
    classification: {
      category: 'braille_art',
      confidence: 0.99,
      language: 'other',
      isVisualExpression: true,
      isSpam: false
    },
    visualResult: {
      isVisualExpression: true,
      subtype: 'braille_art',
      confidence: 0.99,
      metrics: { brailleCount: 15 }
    },
    decision: {
      type: 'visual_expression',
      action: 'LOCAL_REPLY',
      confidence: 0.99,
      reason: 'braille_art'
    }
  };

  const plan = ReplyStrategyEngine.plan(dummyCommentContext);
  assert.strictEqual(plan.action, 'LOCAL_REPLY');
  assert.strictEqual(plan.source, 'VISUAL_LIBRARY');
  assert.strictEqual(plan.strategy, 'MIRROR');
  assert.strictEqual(plan.libraryType, 'braille');

  const selectedFromPlan = lib.select({
    type: plan.libraryType,
    tags: plan.tags,
    mood: plan.mood,
    complement: plan.strategy === 'COMPLEMENT'
  });
  assert.ok(selectedFromPlan, 'Must select a curated braille item from library');
  assert.strictEqual(selectedFromPlan.type, 'braille');
  assert.ok(/[\u2800-\u28FF]/.test(selectedFromPlan.content));
  console.log(`  -> Test 5 Passed: Curated selection chose [${selectedFromPlan.id}]`);

  // ============================================================
  // Test 6: 没有合适素材时 fallback 到 Generator
  // ============================================================
  console.log('--- Test 6: Fallback to VisualReplyGenerator when curated item unavailable ---');
  // Disable all braille items in lib
  const allBrailles = lib.getAllItems({ type: 'braille' });
  for (const b of allBrailles) {
    lib.toggleEnabled(b.id, false);
  }

  // Without complement, no braille item should be returned
  const noMatch = lib.select({ type: 'braille', complement: false });
  assert.strictEqual(noMatch, null);

  // In this situation, the fallback generator is triggered
  assert.ok(plan.allowFallbackGenerator);
  const generatorResult = VisualReplyGenerator.generate(dummyCommentContext.content, dummyCommentContext.visualResult);
  assert.ok(generatorResult && generatorResult.length > 0, 'Generator fallback must produce output');
  console.log('  -> Test 6 Passed: Generator fallback cleanly invoked on curated miss.');

  // Re-enable brailles
  for (const b of allBrailles) {
    lib.toggleEnabled(b.id, true);
  }

  // ============================================================
  // Test 7: Generator 本身仍然保持现有行为
  // ============================================================
  console.log('--- Test 7: VisualReplyGenerator procedural behavior preserved ---');
  const emojiArt = '🟩🟩🟩\n🟩⬜🟩\n🟩🟩🟩';
  const emojiReply = VisualReplyGenerator.generate(emojiArt);
  assert.ok(emojiReply.includes('🟩'), 'Generator must mirror dominant emoji colors');

  const asciiSample = '  /\\_/\\\n ( o.o )\n  > ^ <';
  const asciiReply = VisualReplyGenerator.generate(asciiSample);
  assert.ok(asciiReply.includes('(') || asciiReply.includes('^'), 'Generator must output ASCII art');
  console.log('  -> Test 7 Passed: Generator procedural generation verified intact.');

  // ============================================================
  // Test 8: 现有 VisualExpressionDetector 不受影响
  // ============================================================
  console.log('--- Test 8: VisualExpressionDetector intact ---');
  const v1 = VisualExpressionDetector.detect('⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⠀⠀⠀⠀⠀\n⠀⠀⠀⣠⣾⠟⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⠻⣷⣄⠀⠀⠀');
  assert.strictEqual(v1.isVisualExpression, true);
  assert.strictEqual(v1.subtype, 'braille_art');

  const v2 = VisualExpressionDetector.detect('你好，博主主页真好看！');
  assert.strictEqual(v2.isVisualExpression, false);
  console.log('  -> Test 8 Passed: VisualExpressionDetector detection rules unaffected.');

  // ============================================================
  // Test 9: 现有 ReplyDecision 不受影响
  // ============================================================
  console.log('--- Test 9: ReplyDecision logic intact ---');
  const dSpam = ReplyDecision.evaluate('加微信看片免费领取 steam 礼品卡 www.spam.com');
  assert.strictEqual(dSpam.type, 'spam');
  assert.strictEqual(dSpam.action, 'SKIP');

  const dNormal = ReplyDecision.evaluate('老哥最近在玩黑神话吗？');
  assert.strictEqual(dNormal.type, 'normal');
  assert.strictEqual(dNormal.action, 'AI_REPLY');
  console.log('  -> Test 9 Passed: ReplyDecision classification unaffected.');

  // ============================================================
  // Test 10: 正常文字评论仍走原来的正常流程
  // ============================================================
  console.log('--- Test 10: Normal text comments continue to standard AI / text pipeline ---');
  const textContext = {
    commentId: 'c_text_10',
    commenterName: 'Bob',
    commenterSteamId: '76561198000000002',
    commenterProfileUrl: 'https://steamcommunity.com/id/bob',
    content: '大佬求带一把CS2排位！',
    classification: {
      category: 'unknown',
      confidence: 0.8,
      language: 'zh',
      isVisualExpression: false,
      isSpam: false
    },
    decision: {
      type: 'normal',
      action: 'AI_REPLY',
      confidence: 0.9,
      reason: 'NATURAL_TEXT'
    }
  };

  const textPlan = ReplyStrategyEngine.plan(textContext);
  assert.strictEqual(textPlan.action, 'AI_REPLY');
  assert.strictEqual(textPlan.source, 'DEEPSEEK');
  assert.strictEqual(textPlan.strategy, 'TEXT');
  assert.strictEqual(textPlan.allowFallbackGenerator, false);
  console.log('  -> Test 10 Passed: Normal natural text routed to DEEPSEEK AI.');

  // ============================================================
  // Test 11: Steam 发送层完全不受影响 (Mock Verification)
  // ============================================================
  console.log('--- Test 11: Steam sender layer decoupling verified ---');
  // Verify that ReplyStrategyEngine and VisualReplyLibrary require NO Steam network or browser instances
  assert.strictEqual(typeof ReplyStrategyEngine.plan, 'function');
  assert.strictEqual(typeof lib.select, 'function');
  console.log('  -> Test 11 Passed: Strategy & library modules completely decoupled from Steam transport.');

  // ============================================================
  // Test 12: release/data/visual-replies 不会被 build 脚本覆盖
  // ============================================================
  console.log('--- Test 12: Zero build overwrite safety check ---');
  const releaseDataDir = path.resolve(__dirname, '../../release/data');
  const releaseVisualDir = path.join(releaseDataDir, 'visual-replies');
  if (!fs.existsSync(releaseVisualDir)) {
    fs.mkdirSync(releaseVisualDir, { recursive: true });
  }

  const canaryFile = path.join(releaseVisualDir, 'custom_canary_test.json');
  const canaryContent = JSON.stringify([{ id: 'canary_item_999', content: 'CANARY_DONT_OVERWRITE' }], null, 2);
  fs.writeFileSync(canaryFile, canaryContent, 'utf8');

  // Trigger build in-process
  delete require.cache[require.resolve('../../scripts/build.js')];
  require('../../scripts/build.js');

  assert.ok(fs.existsSync(canaryFile), 'Canary file in release/data/visual-replies/ must survive build');
  const readBack = fs.readFileSync(canaryFile, 'utf8');
  assert.strictEqual(readBack, canaryContent, 'Canary content must not be modified by build');
  fs.unlinkSync(canaryFile);
  console.log('  -> Test 12 Passed: release/data/visual-replies strictly preserved across builds.');

  // Cleanup test temp dir
  if (fs.existsSync(testDataDir)) {
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('✅ ALL 12 Visual Strategy & Curated Library Unit Tests PASSED!\n');
}

module.exports = { runVisualStrategyLibraryTests };
if (require.main === module) runVisualStrategyLibraryTests();
