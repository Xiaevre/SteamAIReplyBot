const assert = require('assert');

async function runTargetDirectionTests() {
  console.log('--- Running Target Direction Strict Verification Tests ---');
  const { CommentSender } = require('../../dist/steam/commentSender');

  const myProfile = 'https://steamcommunity.com/id/my_actual_profile/';
  const visitorProfile = 'https://steamcommunity.com/id/visitor_bob/';

  let navigatedUrls = [];
  const mockBrowserManager = {
    openEphemeralPage: async () => ({
      goto: async (url) => { navigatedUrls.push(url); },
      $eval: async () => false,
      waitForSelector: async () => {},
      click: async () => {},
      fill: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => ({ httpStatus: 200, rawJson: { success: true } }),
      close: async () => {}
    })
  };

  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  const sender = new CommentSender(mockBrowserManager, myProfile, mockLogger);

  // Test 1: B comments on A -> Sender MUST navigate to B's profile
  navigatedUrls = [];
  const res1 = await sender.sendReply(visitorProfile, 'Warm return visit! Thanks for dropping by~');
  assert.strictEqual(navigatedUrls.length, 1, 'Should navigate to exactly 1 URL');
  assert.strictEqual(navigatedUrls[0], visitorProfile, 'Target URL MUST be visitor profile!');
  assert.notStrictEqual(navigatedUrls[0], myProfile, 'Target URL must NEVER be own profile!');
  console.log('  -> Test 1 Passed: Commenter B profile is strictly navigated to.');

  // Test 2: Attempting to reply to own profile MUST be rejected immediately before opening page
  navigatedUrls = [];
  const res2 = await sender.sendReply(myProfile, 'Self talk reply');
  assert.strictEqual(navigatedUrls.length, 0, 'Must NOT navigate anywhere if target is own profile');
  assert.strictEqual(res2.status, 'FAILED_RETRYABLE');
  assert.ok(res2.message.includes('Forbidden: Target profile is identical to own profile'));
  console.log('  -> Test 2 Passed: Self-reply attempt strictly blocked.');

  // Test 3: Trailing slash difference still recognized as self
  navigatedUrls = [];
  const res3 = await sender.sendReply('https://steamcommunity.com/id/my_actual_profile', 'Self talk');
  assert.strictEqual(navigatedUrls.length, 0);
  assert.strictEqual(res3.status, 'FAILED_RETRYABLE');
  console.log('  -> Test 3 Passed: Normalized URL match strictly blocked.');

  console.log('✅ Passed all Target Direction Enforcement tests!');
}

module.exports = { runTargetDirectionTests };
if (require.main === module) runTargetDirectionTests();
