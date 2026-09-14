const assert = require('assert');
const { CommentSender } = require('../../dist/steam/commentSender');
const { SteamSendVerifier } = require('../../dist/steam/transport/steamSendVerifier');
const { SteamModerationDetector } = require('../../dist/rules/moderationDetector');

async function runPostSendConfirmationTests() {
  console.log('====================================================');
  console.log('  Running Post-Send Result Confirmation Unit Tests  ');
  console.log('====================================================\n');

  const myProfileUrl = 'https://steamcommunity.com/id/my_bot_account/';
  const mySteamId = '76561198000000001';
  const targetProfileUrl = 'https://steamcommunity.com/profiles/76561198200000002';
  const targetSteamId = '76561198200000002';

  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  function createMockBrowserManager({
    sessionValid = true,
    transportResult = { httpStatus: 200, networkError: null, rawJson: { success: true } },
    commentsRestricted = false,
    pageComments = [],
    throwOnVerifyGoto = false,
    throwOnTransport = false
  }) {
    let postDispatched = false;

    const bm = {
      openEphemeralPage: async () => ({
        context: () => ({
          cookies: async () => sessionValid ? [
            { name: 'sessionid', value: 'valid_sess_123' },
            { name: 'steamLoginSecure', value: `${mySteamId}%7C%7CvalidToken12345678` }
          ] : []
        }),
        goto: async (url) => {
          if (throwOnVerifyGoto && url.includes('_v=')) {
            throw new Error('Navigation timeout to target profile after POST');
          }
        },
        $eval: async (sel) => {
          if (sel.includes('commentthread_restricted') || sel.includes('profile_comment_area_restricted')) {
            return commentsRestricted;
          }
          return false;
        },
        $$eval: async (sel, fn) => {
          if (typeof fn === 'function') {
            return fn(pageComments);
          }
          return pageComments;
        },
        $: async (sel) => null,
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return sessionValid ? {
                sessionId: 'valid_sess_123',
                steamId: mySteamId,
                accountPulldown: 'MyBot',
                hasLoginCookieInDoc: true
              } : {
                sessionId: null,
                steamId: null,
                accountPulldown: null,
                hasLoginCookieInDoc: false
              };
            }
            if (fnStr.includes('fetch')) {
              postDispatched = true;
              if (throwOnTransport) {
                throw new Error('Transport socket hang up');
              }
              return transportResult;
            }
          }
          return {};
        },
        close: async () => {}
      }),
      wasPostDispatched: () => postDispatched
    };

    return bm;
  }

  // =========================================================================
  // TEST 1: postAttempted=false -> CONFIRMED_NOT_SENT
  // =========================================================================
  {
    console.log('--- TEST 1: postAttempted=false -> CONFIRMED_NOT_SENT ---');
    // Pre-send failure: Vanity URL cannot be resolved to 17-digit SteamID64
    const bm = createMockBrowserManager({ sessionValid: true });
    const sender = new CommentSender(bm, myProfileUrl, mockLogger);

    const result = await sender.sendReply(
      'https://steamcommunity.com/id/unresolvable_user_without_miniprofile',
      'hello',
      'UnresolvableVanityName' // Non-numeric, unresolvable in mock DOM
    );

    assert.strictEqual(result.confirmationStatus, 'CONFIRMED_NOT_SENT', 'Must be CONFIRMED_NOT_SENT when POST was not attempted');
    assert.strictEqual(result.status, 'FAILED_RETRYABLE');
    assert.strictEqual(bm.wasPostDispatched(), false, 'HTTP POST must never have been dispatched');
    console.log('  -> TEST 1 PASSED: postAttempted=false correctly yielded CONFIRMED_NOT_SENT\n');
  }

  // =========================================================================
  // TEST 2: postAttempted=true + 找到 Bot 自己的新留言 -> CONFIRMED_SENT
  // =========================================================================
  {
    console.log('--- TEST 2: postAttempted=true + Found Bot Own New Comment -> CONFIRMED_SENT ---');
    const nowSec = Math.floor(Date.now() / 1000);
    const replyText = 'Thanks for visiting my profile!';
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_111222333">Thanks for visiting my profile!</div>'
        }
      },
      pageComments: [{
        id: 'comment_111222333',
        author: 'MyBot',
        profileUrl: myProfileUrl,
        rawMini: '800000001',
        dataTimestamp: nowSec,
        text: replyText
      }]
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, replyText, targetSteamId);

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(result.confirmationStatus, 'CONFIRMED_SENT', 'Must be CONFIRMED_SENT when new comment is verified');
    assert.strictEqual(result.commentId, 'comment_111222333');
    console.log('  -> TEST 2 PASSED: Successfully verified own new comment as CONFIRMED_SENT\n');
  }

  // =========================================================================
  // TEST 3: postAttempted=true + moderation pending -> SENT_MODERATION_PENDING
  // =========================================================================
  {
    console.log('--- TEST 3: postAttempted=true + Moderation Pending -> SENT_MODERATION_PENDING ---');
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_444555666">此留言正在等待我们的自动内容检查系统分析。</div>'
        }
      },
      pageComments: [{
        id: 'comment_444555666',
        author: 'MyBot',
        profileUrl: myProfileUrl,
        rawMini: '800000001',
        dataTimestamp: Math.floor(Date.now() / 1000),
        text: '此留言正在等待我们的自动内容检查系统分析。'
      }]
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'Automated reply', targetSteamId);

    assert.strictEqual(result.status, 'MODERATION_PENDING');
    assert.strictEqual(result.confirmationStatus, 'SENT_MODERATION_PENDING', 'Must be SENT_MODERATION_PENDING');
    console.log('  -> TEST 3 PASSED: Moderation placeholder correctly mapped to SENT_MODERATION_PENDING\n');
  }

  // =========================================================================
  // TEST 4: postAttempted=true + Steam success=false + 目标页面明确限制 -> TARGET_REJECTION_CONFIRMED
  // =========================================================================
  {
    console.log('--- TEST 4: postAttempted=true + Steam success=false + DOM Restricted -> TARGET_REJECTION_CONFIRMED ---');
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: false,
          error: '此帐户的设置不允许您添加留言。'
        }
      },
      commentsRestricted: true, // Target profile DOM has confirmed restriction banner
      pageComments: []
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'Hello there', targetSteamId);

    assert.strictEqual(result.status, 'PERMISSION_DENIED');
    assert.strictEqual(result.confirmationStatus, 'TARGET_REJECTION_CONFIRMED', 'Must be TARGET_REJECTION_CONFIRMED');
    console.log('  -> TEST 4 PASSED: Confirmed target DOM restriction classified as TARGET_REJECTION_CONFIRMED\n');
  }

  // =========================================================================
  // TEST 5: postAttempted=true + Steam success=false + 页面开放 + 没有自己的留言 -> TRANSIENT_COMMENT_REJECTION
  // =========================================================================
  {
    console.log('--- TEST 5: postAttempted=true + Steam success=false + Open Profile + No Comment -> TRANSIENT_COMMENT_REJECTION ---');
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: false,
          error: '此帐户的设置不允许您添加留言。'
        }
      },
      commentsRestricted: false, // Target profile is OPEN (no restriction elements)
      pageComments: [] // No comment found
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'Hello there', targetSteamId);

    assert.strictEqual(result.status, 'FAILED_RETRYABLE');
    assert.strictEqual(result.confirmationStatus, 'TRANSIENT_COMMENT_REJECTION', 'Must be TRANSIENT_COMMENT_REJECTION');
    console.log('  -> TEST 5 PASSED: Generic rejection on open profile classified as TRANSIENT_COMMENT_REJECTION\n');
  }

  // =========================================================================
  // TEST 6: postAttempted=true + 页面验证 timeout -> SEND_RESULT_UNCERTAIN
  // =========================================================================
  {
    console.log('--- TEST 6: postAttempted=true + Verification Timeout -> SEND_RESULT_UNCERTAIN ---');
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '<div id="comment_777888999">test message</div>'
        }
      },
      throwOnVerifyGoto: true // Simulates page.goto timeout during post-send verification
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'test message', targetSteamId);

    assert.strictEqual(result.status, 'UNCERTAIN');
    assert.strictEqual(result.confirmationStatus, 'SEND_RESULT_UNCERTAIN', 'Must be SEND_RESULT_UNCERTAIN on verification timeout');
    assert.notStrictEqual(result.confirmationStatus, 'CONFIRMED_NOT_SENT', 'Must NEVER be CONFIRMED_NOT_SENT once POST was attempted');
    console.log('  -> TEST 6 PASSED: Verification timeout correctly classified as SEND_RESULT_UNCERTAIN\n');
  }

  // =========================================================================
  // TEST 7: 目标页面存在别人相同文本 + Bot 本人没有对应新留言 -> 不能误判 CONFIRMED_SENT
  // =========================================================================
  {
    console.log('--- TEST 7: Other User Identical Text on Profile -> Must NOT Misclassify as CONFIRMED_SENT ---');
    const nowSec = Math.floor(Date.now() / 1000);
    const commonGreeting = '新年快乐！🎉';

    const verifier = new SteamSendVerifier(myProfileUrl, mockLogger);
    verifier.setBotSteamId(mySteamId);

    // Mock page DOM where another user posted "新年快乐！🎉"
    const mockPageWithOtherUserComment = {
      $: async () => null,
      $$eval: async (sel, fn) => {
        const els = [{
          id: 'comment_stranger_1',
          author: 'RandomGamer999',
          profileUrl: 'https://steamcommunity.com/id/random_stranger_999/',
          rawMini: '999999999',
          dataTimestamp: nowSec,
          text: commonGreeting,
          fullText: `${commonGreeting} by RandomGamer999`
        }];
        return fn ? fn(els) : els;
      }
    };

    const verifyResult = await verifier.verifyCommentInPage(mockPageWithOtherUserComment, {
      expectedText: commonGreeting,
      botSteamId: mySteamId,
      botProfileUrl: myProfileUrl,
      postAttemptedAt: Date.now()
    });

    assert.strictEqual(verifyResult, 'NOT_FOUND', 'Must NOT match when the comment author is another user');
    console.log('  -> TEST 7 PASSED: Different author with identical text was rejected from matching\n');
  }

  // =========================================================================
  // TEST 8: Bot 自己数小时前已有相同文本 + 本次没有新增留言 -> 不能误判 CONFIRMED_SENT
  // =========================================================================
  {
    console.log('--- TEST 8: Bot Own Comment from Hours Ago -> Must NOT Misclassify as CONFIRMED_SENT ---');
    const postAttemptedAt = Date.now();
    const threeHoursAgoSec = Math.floor(postAttemptedAt / 1000) - 3 * 3600; // 3 hours ago
    const repeatedText = '早安！Have a good game!';

    const verifier = new SteamSendVerifier(myProfileUrl, mockLogger);
    verifier.setBotSteamId(mySteamId);

    const mockPageWithOldBotComment = {
      $: async () => null,
      $$eval: async (sel, fn) => {
        const els = [{
          id: 'comment_old_bot_1',
          author: 'MyBot',
          profileUrl: myProfileUrl,
          rawMini: '800000001',
          dataTimestamp: threeHoursAgoSec,
          text: repeatedText,
          fullText: `${repeatedText} by MyBot`
        }];
        return fn ? fn(els) : els;
      }
    };

    const verifyResult = await verifier.verifyCommentInPage(mockPageWithOldBotComment, {
      expectedText: repeatedText,
      botSteamId: mySteamId,
      botProfileUrl: myProfileUrl,
      postAttemptedAt
    });

    assert.strictEqual(verifyResult, 'NOT_FOUND', 'Must NOT match when the comment is from hours ago');
    console.log('  -> TEST 8 PASSED: Historical comment from hours ago was skipped by time window\n');
  }

  // =========================================================================
  // TEST 9: success=false + moderation pending -> 禁止 retry
  // =========================================================================
  {
    console.log('--- TEST 9: Steam success=false + Moderation Pending -> SENT_MODERATION_PENDING (No Retry) ---');
    // Scenario: Steam HTTP returns success: false, but the target profile actually has the comment in moderation!
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: false,
          error: '此帐户的设置不允许您添加留言。'
        }
      },
      pageComments: [{
        id: 'comment_mod_pending_1',
        author: 'MyBot',
        profileUrl: myProfileUrl,
        rawMini: '800000001',
        dataTimestamp: Math.floor(Date.now() / 1000),
        text: '此留言正在等待我们的自动内容检查系统分析。'
      }]
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'Test message', targetSteamId);

    assert.strictEqual(result.status, 'MODERATION_PENDING', 'Must be MODERATION_PENDING even if Steam returned success=false');
    assert.strictEqual(result.confirmationStatus, 'SENT_MODERATION_PENDING', 'Must be SENT_MODERATION_PENDING');
    console.log('  -> TEST 9 PASSED: success=false with moderation pending correctly enters SENT_MODERATION_PENDING\n');
  }

  // =========================================================================
  // TEST 10: 任何 postAttempted=true + 验证不充分 -> SEND_RESULT_UNCERTAIN
  // =========================================================================
  {
    console.log('--- TEST 10: Any postAttempted=true + Inconclusive Verification -> SEND_RESULT_UNCERTAIN ---');
    // Scenario: HTTP POST succeeded, but target profile verification found 0 comments (e.g. unindexed / cache delay)
    const bm = createMockBrowserManager({
      sessionValid: true,
      transportResult: {
        httpStatus: 200,
        networkError: null,
        rawJson: {
          success: true,
          comments_html: '' // No comment ID returned in response
        }
      },
      pageComments: [] // Target profile hasn't indexed the comment yet
    });

    const sender = new CommentSender(bm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(targetProfileUrl, 'Hello unseen', targetSteamId);

    assert.strictEqual(result.status, 'UNCERTAIN', 'Inconclusive verify must map to UNCERTAIN');
    assert.strictEqual(result.confirmationStatus, 'SEND_RESULT_UNCERTAIN', 'Must be SEND_RESULT_UNCERTAIN');
    assert.strictEqual(bm.wasPostDispatched(), true, 'POST was attempted');
    console.log('  -> TEST 10 PASSED: Inconclusive send correctly protected with SEND_RESULT_UNCERTAIN\n');
  }

  console.log('====================================================');
  console.log('  All 10 Post-Send Result Confirmation Tests PASSED ');
  console.log('====================================================\n');
}

module.exports = { runPostSendConfirmationTests };

if (require.main === module) {
  runPostSendConfirmationTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
