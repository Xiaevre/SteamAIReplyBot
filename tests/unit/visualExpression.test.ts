const assert = require('assert');
const { VisualExpressionDetector } = require('../../dist/rules/visualExpressionDetector');
const { LocalClassifier } = require('../../dist/rules/classifier');

function runVisualExpressionTests() {
  console.log('--- Running Visual Expression & Emoji Pixel Art Tests ---');

  // Test 1: Emoji Color Block Art
  const test1 = '🟧🟧🟧🟧\n🟧⬜⬛🟧\n🟩🟩🟩🟩\n🟥🟥🟥🟥';
  const res1 = VisualExpressionDetector.detect(test1);
  assert.strictEqual(res1.isVisualExpression, true, 'Test 1 should be visual expression');
  assert.strictEqual(res1.subtype, 'emoji_pixel_art', 'Test 1 should be emoji_pixel_art');
  assert.ok(res1.confidence >= 0.90, `Test 1 confidence (${res1.confidence}) should be >= 0.90`);
  assert.strictEqual(res1.hasSignificantNaturalLanguage, false, 'Test 1 should not have significant natural language');
  assert.strictEqual(res1.metrics.lineCount, 4);
  console.log('  -> Test 1 Passed: Emoji Color Block Art detected as emoji_pixel_art (confidence: ' + res1.confidence + ')');

  // Test 2: Braille Art
  const test2 = '⡿⠉⠉⠉⠉⠙⣷⡀\n⡇⢀⣀⣀⡀⠀⢸⡇\n⡇⠘⠛⠛⠃⠀⢸⡇\n⣧⣀⣀⣀⣀⣠⣾⠁';
  const res2 = VisualExpressionDetector.detect(test2);
  assert.strictEqual(res2.isVisualExpression, true, 'Test 2 should be visual expression');
  assert.strictEqual(res2.subtype, 'braille_art', 'Test 2 should be braille_art');
  assert.ok(res2.confidence >= 0.90, `Test 2 confidence (${res2.confidence}) should be >= 0.90`);
  assert.strictEqual(res2.hasSignificantNaturalLanguage, false, 'Test 2 should not have significant natural language');
  console.log('  -> Test 2 Passed: Braille Art detected as braille_art (confidence: ' + res2.confidence + ')');

  // Test 3: Emoji Pixel Art
  const test3 = '⬛🟨⬛\n🟨🟨🟨\n🟥🟥🟥\n⬜⬜⬜';
  const res3 = VisualExpressionDetector.detect(test3);
  assert.strictEqual(res3.isVisualExpression, true, 'Test 3 should be visual expression');
  assert.strictEqual(res3.subtype, 'emoji_pixel_art', 'Test 3 should be emoji_pixel_art');
  assert.ok(res3.confidence >= 0.90, `Test 3 confidence (${res3.confidence}) should be >= 0.90`);
  console.log('  -> Test 3 Passed: Emoji Pixel Art detected as emoji_pixel_art (confidence: ' + res3.confidence + ')');

  // Test 4: Block Element Art
  const test4 = '█▀▀▀▀▀▀█\n█ ░▒▓  █\n█▄▄▄▄▄▄█';
  const res4 = VisualExpressionDetector.detect(test4);
  assert.strictEqual(res4.isVisualExpression, true, 'Test 4 should be visual expression');
  assert.strictEqual(res4.subtype, 'block_art', 'Test 4 should be block_art');
  assert.ok(res4.confidence >= 0.90, `Test 4 confidence (${res4.confidence}) should be >= 0.90`);
  console.log('  -> Test 4 Passed: Block Element Art detected as block_art (confidence: ' + res4.confidence + ')');

  // Test 5: Box Drawing Art
  const test5 = '┌────┐\n│    │\n└────┘';
  const res5 = VisualExpressionDetector.detect(test5);
  assert.strictEqual(res5.isVisualExpression, true, 'Test 5 should be visual expression');
  assert.strictEqual(res5.subtype, 'box_drawing_art', 'Test 5 should be box_drawing_art');
  assert.ok(res5.confidence >= 0.90, `Test 5 confidence (${res5.confidence}) should be >= 0.90`);
  console.log('  -> Test 5 Passed: Box Drawing Art detected as box_drawing_art (confidence: ' + res5.confidence + ')');

  // Test 6: Mixed Unicode Art
  const test6 = '★─▄██▄─★\n⣿ 🟧🟧 ⣿\n★─▀██▀─★';
  const res6 = VisualExpressionDetector.detect(test6);
  assert.strictEqual(res6.isVisualExpression, true, 'Test 6 should be visual expression');
  assert.strictEqual(res6.subtype, 'mixed_symbol_art', 'Test 6 should be mixed_symbol_art');
  assert.ok(res6.confidence >= 0.90, `Test 6 confidence (${res6.confidence}) should be >= 0.90`);
  console.log('  -> Test 6 Passed: Mixed Unicode Art detected as mixed_symbol_art (confidence: ' + res6.confidence + ')');

  // Test 7: Normal language + art
  const test7 = '这也太可爱了 😂\n\n🟧🟧🟧\n🟧⬛🟧\n🟩🟩🟩';
  const res7 = VisualExpressionDetector.detect(test7);
  assert.strictEqual(res7.isVisualExpression, false, 'Test 7 must NOT be classified as pure visual expression');
  assert.strictEqual(res7.hasSignificantNaturalLanguage, true, 'Test 7 must identify significant natural language');
  assert.ok(res7.confidence < 0.90, 'Test 7 confidence must be downgraded below 0.90');
  console.log('  -> Test 7 Passed: Normal language + art correctly preserved natural language and not intercepted as pure art');

  // Negative Tests: Normal conversation with emojis
  const neg1 = '你这个展柜真的太帅了 😂😂';
  const resNeg1 = VisualExpressionDetector.detect(neg1);
  assert.strictEqual(resNeg1.isVisualExpression, false, 'Normal comment should not be visual expression');
  assert.strictEqual(resNeg1.hasSignificantNaturalLanguage, true);
  console.log('  -> Negative Test 1 Passed: Normal comment with emojis correctly rejected');

  const neg2 = '哈哈哈哈 😂😂😂😂😂';
  const resNeg2 = VisualExpressionDetector.detect(neg2);
  assert.strictEqual(resNeg2.isVisualExpression, false, 'Laughter emojis should not be visual expression');
  console.log('  -> Negative Test 2 Passed: Laughter comment correctly rejected');

  // Integration with LocalClassifier & API Routing
  console.log('  -> Testing LocalClassifier routing and zero-token enforcement...');
  const classifier = new LocalClassifier();

  // Test 1 through 6 MUST route to LOCAL_RULE with zero token
  for (const [idx, sample] of [test1, test2, test3, test4, test5, test6].entries()) {
    const classRes = classifier.classify(sample);
    assert.strictEqual(classRes.replySource, 'LOCAL_RULE', `Sample ${idx + 1} must have replySource LOCAL_RULE`);
    assert.strictEqual(classRes.isVisualExpression, true, `Sample ${idx + 1} must be marked isVisualExpression`);
    assert.ok(classRes.reply && classRes.reply.length > 0, `Sample ${idx + 1} must have a non-empty local reply`);
  }
  console.log('  -> Integration Test Passed: Tests 1-6 strictly intercepted locally with 0 token!');

  // Test 7 MUST NOT be intercepted as pure visual expression in classifier
  const classRes7 = classifier.classify(test7);
  assert.notStrictEqual(classRes7.isVisualExpression, true, 'Test 7 must not be intercepted as pure visual expression');
  console.log('  -> Integration Test Passed: Test 7 continues through normal language processing pipeline!');

  // Real World Regression: pwn3d (pwn3d_07) Emoji Pixel Art (contains U+3164 fillers, U+2004 spaces, color blocks)
  const pwn3dRealComment = '⬛⬛ㅤ ㅤ ㅤ ㅤ ㅤ ㅤ ㅤ ⬛⬛⬛🟨⬛ㅤ ㅤ ㅤ ㅤ ㅤ ⬛🟨⬛⬛🟨🟨🟨ㅤ ㅤ ㅤ 🟨🟨🟨⬛ㅤ 🟨🟨🟨🟨🟨🟨🟨🟨🟨ㅤ 🟨⬛⬛⬛⬛⬛⬛⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬜⬜⬜⬜⬜⬛🟨ㅤ 🟨⬛⬛⬛⬛⬛⬛⬛🟨ㅤ ㅤ ㅤ 🟨🟨ㅤ 🟥🟨🟨🟨🟨🟨🟨🟨🟥ㅤ ㅤ 🟨🟨🟨ㅤ 🟥🟥🟨🟨🟨🟨🟨🟥🟥ㅤ ㅤ 🟨🟨🟨ㅤ 🟥🟨⬛🟨🟨🟨🟨⬛🟥ㅤ 🟨🟨🟨ㅤ 🟨⬛⬛⬛🟨🟨⬛🟨🟨🟫🟨🟨ㅤ 🟨🟨⬛🟨🟨🟨🟨🟨🟨🟫🟫ㅤ 🟨🟨🟨🟨🟨🟨🟨🟨🟨🟫ㅤ 🟨🟨🟨🟫🟨🟫🟨🟨🟨ㅤ ㅤ 🟨🟨🟨🟨🟨🟨🟨';
  const resPwn3d = VisualExpressionDetector.detect(pwn3dRealComment);
  assert.strictEqual(resPwn3d.isVisualExpression, true, 'pwn3d real comment must be visual expression');
  assert.strictEqual(resPwn3d.subtype, 'emoji_pixel_art', 'pwn3d real comment subtype must be emoji_pixel_art');
  assert.ok(resPwn3d.confidence >= 0.90, `pwn3d real comment confidence (${resPwn3d.confidence}) must be >= 0.90`);
  assert.strictEqual(resPwn3d.hasSignificantNaturalLanguage, false, 'pwn3d real comment has no significant natural language');
  console.log('  -> Regression Test Passed: Real pwn3d Emoji Pixel Art detected as emoji_pixel_art (confidence: ' + resPwn3d.confidence + ')');

  // Real World Regression 2: ∑ ℕØ℟ḾȺḼ Emoji Pixel Art
  const normal2RealComment = '🟧🟧🟧🟧🟧🟧🟧🟧   🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧⬜⬛️🟧🟧⬜⬛️🟧🟧🟧🟧🟧🟧⬛️⬛️🟧🟧⬛️⬛️🟧🟧🟧 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧   🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧';
  const resNormal2 = VisualExpressionDetector.detect(normal2RealComment);
  assert.strictEqual(resNormal2.isVisualExpression, true, '∑ ℕØ℟ḾȺḼ real comment must be visual expression');
  assert.strictEqual(resNormal2.subtype, 'emoji_pixel_art', '∑ ℕØ℟ḾȺḼ real comment subtype must be emoji_pixel_art');
  assert.ok(resNormal2.confidence >= 0.90, `∑ ℕØ℟ḾȺḼ real comment confidence (${resNormal2.confidence}) must be >= 0.90`);
  console.log('  -> Regression Test 2 Passed: Real ∑ ℕØ℟ḾȺḼ Emoji Pixel Art detected as emoji_pixel_art (confidence: ' + resNormal2.confidence + ')');

  // Real comments zero-token enforcement
  const pwn3dClass = classifier.classify(pwn3dRealComment);
  assert.strictEqual(pwn3dClass.replySource, 'LOCAL_RULE', 'pwn3d comment must route to LOCAL_RULE');
  assert.strictEqual(pwn3dClass.isVisualExpression, true, 'pwn3d comment must be marked isVisualExpression');

  console.log('✅ Passed all Visual Expression & Emoji Pixel Art tests!');
}

module.exports = { runVisualExpressionTests };
