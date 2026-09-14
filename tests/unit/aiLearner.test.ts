const assert = require('assert');
const fs = require('fs');
const path = require('path');

function runAiLearnerTests() {
  console.log('--- Running AI Learner Strict Promotion Tests ---');
  const { AiLearner } = require('../../dist/ai/learner');

  const testPhrasesPath = path.resolve(__dirname, 'test-phrases.json');
  if (fs.existsSync(testPhrasesPath)) fs.unlinkSync(testPhrasesPath);

  const learner = new AiLearner(testPhrasesPath);

  // 1. First observation of new phrase "踩踩你"
  let res = learner.processAiObservation({
    phrases: ['踩踩你'],
    category: 'warm_social',
    language: 'zh',
    confidence: 0.92,
    sampleReply: '回踩踩～祝好！'
  });

  assert.strictEqual(res.updatedCount, 1);
  assert.strictEqual(res.promotedCount, 0, 'Should NOT promote on first hit');

  let p = learner.getPhrases().find(item => item.phrase === '踩踩你');
  assert.ok(p, 'Phrase should be saved');
  assert.strictEqual(p.status, 'candidate', 'Status must be candidate');
  assert.strictEqual(p.hitCount, 1);
  console.log('  -> Test 1 Passed: First observation saved as candidate (hitCount=1).');

  // 2. Second observation
  res = learner.processAiObservation({
    phrases: ['踩踩你'],
    category: 'warm_social',
    language: 'zh',
    confidence: 0.95,
    sampleReply: '回踩踩～'
  });

  assert.strictEqual(res.promotedCount, 0, 'Should NOT promote on second hit');
  p = learner.getPhrases().find(item => item.phrase === '踩踩你');
  assert.strictEqual(p.status, 'candidate');
  assert.strictEqual(p.hitCount, 2);
  console.log('  -> Test 2 Passed: Second observation remains candidate (hitCount=2).');

  // 3. Third observation with high confidence & matching category
  res = learner.processAiObservation({
    phrases: ['踩踩你'],
    category: 'warm_social',
    language: 'zh',
    confidence: 0.94,
    sampleReply: '回踩踩～'
  });

  assert.strictEqual(res.promotedCount, 1, 'Should PROMOTE on 3rd consistent hit');
  p = learner.getPhrases().find(item => item.phrase === '踩踩你');
  assert.strictEqual(p.status, 'stable', 'Status must be upgraded to stable');
  assert.strictEqual(p.hitCount, 3);
  console.log('  -> Test 3 Passed: Third consistent hit promoted phrase to stable rule!');

  // 4. Test category conflict handling
  learner.processAiObservation({
    phrases: ['出刀换刀'],
    category: 'trading',
    language: 'zh',
    confidence: 0.90
  });

  learner.processAiObservation({
    phrases: ['出刀换刀'],
    category: 'compliment',
    language: 'zh',
    confidence: 0.88
  });

  const conflictP = learner.getPhrases().find(item => item.phrase === '出刀换刀');
  assert.ok(conflictP.confidence < 0.85, 'Confidence must be penalized upon category conflict');
  assert.strictEqual(conflictP.status, 'candidate', 'Conflicted phrase must not be promoted');
  console.log('  -> Test 4 Passed: Conflicting category correctly penalizes confidence.');

  if (fs.existsSync(testPhrasesPath)) fs.unlinkSync(testPhrasesPath);
  console.log('✅ Passed all AI Learner Strict Promotion tests!');
}

module.exports = { runAiLearnerTests };
if (require.main === module) runAiLearnerTests();
