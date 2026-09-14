const assert = require('assert');
const { executeDiagnoseSend } = require('../../dist/steam/diagnoseSend');
const { Logger } = require('../../dist/utils/logger');

async function runDiagnoseSendTests() {
  console.log('--- Running Diagnose Send Unit Tests ---');

  const logger = new Logger('release/logs');

  // Test 1: Simulating Steam rejection with "此帐户的设置不允许您添加留言。"
  {
    console.log('--- Test 1: Steam rejection with 此帐户的设置不允许您添加留言。 ---');
    const mockPage = {
      context: () => ({
        cookies: async () => [{ name: 'timezoneOffset', value: '28800' }]
      }),
      goto: async () => {},
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function' && fn.length === 0) {
          // DOM inspect
          return {
            hasCommentArea: true,
            hasCommentForm: false,
            hasTextarea: false,
            restrictedNotice: null,
            pageSteamId: null,
            accountPulldown: null
          };
        }
        // fetch POST evaluate
        return {
          httpStatus: 200,
          networkError: null,
          rawJson: {
            success: false,
            error: '此帐户的设置不允许您添加留言。'
          },
          rawResponseText: '{"success":false,"error":"此帐户的设置不允许您添加留言。"}'
        };
      },
      close: async () => {}
    };

    const mockBrowserManager = {
      openEphemeralPage: async () => mockPage
    };

    const result = await executeDiagnoseSend(
      mockBrowserManager,
      '76561199202573055',
      '晚上好呀！有空一起玩～',
      logger
    );

    assert.strictEqual(result.httpStatus, 200);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, '此帐户的设置不允许您添加留言。');
    assert.strictEqual(result.classification, 'COMMENT_REJECTED_BY_STEAM');
    assert.strictEqual(result.sessionState.hasLoginCookie, false);
    assert.strictEqual(result.targetPageDom.hasTextarea, false);
    assert.strictEqual(result.rawResponseBody, '{"success":false,"error":"此帐户的设置不允许您添加留言。"}');
    assert.strictEqual(result.requestHeadersMasked['Cookie'], '[MASKED]');
    assert.ok(result.requestBodyMasked.includes('sessionid=[MASKED]'));
    console.log('✓ Test 1 Passed: Correctly classified as COMMENT_REJECTED_BY_STEAM');
  }

  // Test 2: Simulating Successful Comment Send (PoC format)
  {
    console.log('--- Test 2: Simulating Successful Send (PoC format) ---');
    const mockPage = {
      context: () => ({
        cookies: async () => [
          { name: 'steamLoginSecure', value: '76561198000000000%7C%7CeyAidHlwIjogIkpXVCIsICJhbGciOiAiRWREU0EiIH0' },
          { name: 'sessionid', value: 'abcdef123456' }
        ]
      }),
      goto: async () => {},
      evaluate: async (fn, arg) => {
        if (typeof fn === 'function' && fn.length === 0) {
          return {
            hasCommentArea: true,
            hasCommentForm: true,
            hasTextarea: true,
            restrictedNotice: null,
            pageSteamId: '76561198000000000',
            accountPulldown: 'MyAccount'
          };
        }
        return {
          httpStatus: 200,
          networkError: null,
          rawJson: {
            success: true,
            name: 'comment_thread',
            comments_html: '<div class="commentthread_comment" id="comment_581681621355377777">hello123</div>'
          },
          rawResponseText: '{"success":true,"name":"comment_thread","comments_html":"<div class=\\"commentthread_comment\\" id=\\"comment_581681621355377777\\">hello123</div>"}'
        };
      },
      close: async () => {}
    };

    const mockBrowserManager = {
      openEphemeralPage: async () => mockPage
    };

    const result = await executeDiagnoseSend(
      mockBrowserManager,
      '76561199202573055',
      'hello123',
      logger
    );

    assert.strictEqual(result.httpStatus, 200);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.parsedCommentId, 'comment_581681621355377777');
    assert.strictEqual(result.classification, 'SUCCESS');
    assert.strictEqual(result.sessionState.hasLoginCookie, true);
    assert.strictEqual(result.targetPageDom.hasTextarea, true);
    console.log('✓ Test 2 Passed: Correctly parsed commentId and classified as SUCCESS');
  }

  // Test 3: Zero Auto-Retry guarantee
  {
    console.log('--- Test 3: Zero Auto-Retry verification ---');
    let callCount = 0;
    const mockPage = {
      context: () => ({
        cookies: async () => []
      }),
      goto: async () => {},
      evaluate: async (fn, arg) => {
        callCount++;
        return {
          httpStatus: 502,
          networkError: null,
          rawJson: { error: 'Bad Gateway' },
          rawResponseText: 'Bad Gateway'
        };
      },
      close: async () => {}
    };

    const mockBrowserManager = {
      openEphemeralPage: async () => mockPage
    };

    const result = await executeDiagnoseSend(
      mockBrowserManager,
      '76561199202573055',
      'test retry',
      logger
    );

    // One evaluation for DOM inspect, one evaluation for fetch = 2 evaluate calls total, 0 retry
    assert.strictEqual(callCount, 2);
    console.log('✓ Test 3 Passed: Zero auto-retry guaranteed on failure');
  }

  console.log('✅ All Diagnose Send tests passed!');
}

module.exports = { runDiagnoseSendTests };
