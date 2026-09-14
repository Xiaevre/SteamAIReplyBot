const assert = require('assert');

async function runVanityUrlResolutionTests() {
  console.log('--- Running Vanity URL to SteamID64 Resolution & Guard Acceptance Tests ---');

  const { CommentSender } = require('../../dist/steam/commentSender');
  const { SteamCommentTransport } = require('../../dist/steam/transport/steamCommentTransport');
  const { SteamSendErrorClassifier } = require('../../dist/steam/transport/steamSendErrorClassifier');

  const myProfileUrl = 'https://steamcommunity.com/id/test_bot_user/';
  const mySteamId = '76561198000000001';

  const mockLogger = {
    infoCalls: [],
    warnCalls: [],
    errorCalls: [],
    info(tag, data) { this.infoCalls.push({ tag, data }); },
    warn(tag, data) { this.warnCalls.push({ tag, data }); },
    error(tag, data) { this.errorCalls.push({ tag, data }); },
    clear() {
      this.infoCalls = [];
      this.warnCalls = [];
      this.errorCalls = [];
    }
  };

  function createMockBrowserManager({
    mockDomProfileData = null,
    mockFormId = null,
    mockMiniProfile = null,
    sessionValid = true,
    fetchResult = { httpStatus: 200, networkError: null, rawJson: { success: true, comments_html: '<div id="comment_111">test</div>' } },
    onFetchCalled = () => {}
  }) {
    return {
      openEphemeralPage: async () => ({
        context: () => ({
          cookies: async () => sessionValid ? [
            { name: 'sessionid', value: 'valid_session_id_123' },
            { name: 'steamLoginSecure', value: `${mySteamId}%7C%7CvalidToken12345678` }
          ] : []
        }),
        goto: async () => {},
        $eval: async () => false,
        waitForSelector: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
          if (typeof fn === 'function') {
            const fnStr = fn.toString();
            // Session check
            if (fnStr.includes('g_steamID') || fnStr.includes('accountPulldown')) {
              return {
                sessionId: 'valid_session_id_123',
                steamId: mySteamId,
                accountPulldown: 'test_bot_user',
                hasLoginCookieInDoc: true
              };
            }
            // DOM resolution on target profile page
            if (fnStr.includes('g_rgProfileData')) {
              if (mockDomProfileData && mockDomProfileData.steamid) {
                return { steamId: String(mockDomProfileData.steamid), source: 'g_rgProfileData' };
              }
              if (mockFormId) {
                const m = mockFormId.match(/commentthread_Profile_(\d{17})_/);
                if (m) return { steamId: m[1], source: 'commentthread_form_id' };
              }
              if (mockMiniProfile) {
                if (/^\d{17}$/.test(mockMiniProfile)) {
                  return { steamId: mockMiniProfile, source: 'dom_miniprofile_64' };
                }
                if (/^\d{1,10}$/.test(mockMiniProfile)) {
                  const id64 = (76561197960265728n + BigInt(mockMiniProfile)).toString();
                  if (/^\d{17}$/.test(id64)) return { steamId: id64, source: 'dom_miniprofile_account_id' };
                }
              }
              return null;
            }
            // Fetch handler inside page
            if (fnStr.includes('fetch')) {
              onFetchCalled(arg);
              return fetchResult;
            }
          }
          return {};
        },
        $$eval: async () => [{ id: 'comment_111', text: 'test comment', author: 'test_bot_user', profileUrl: myProfileUrl }],
        close: async () => {}
      })
    };
  }

  // =========================================================================
  // TEST 1: Numeric SteamID64 -> sends normally with 17-digit ID
  // =========================================================================
  {
    console.log('--- TEST 1: Numeric SteamID64 -> sends normally ---');
    mockLogger.clear();
    let requestedTargetId = null;
    const mockBm = createMockBrowserManager({
      onFetchCalled: (args) => { requestedTargetId = args?.targetId; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/profiles/76561198000000001',
      'test comment',
      '76561198000000001'
    );

    assert.strictEqual(result.status, 'SUCCESS', 'Must succeed with numeric SteamID64');
    assert.strictEqual(requestedTargetId, '76561198000000001', 'Must POST to 17-digit numeric SteamID64');
    console.log('  -> TEST 1 PASSED: Numeric SteamID64 sends normally.');
  }

  // =========================================================================
  // TEST 2: Vanity URL -> resolves numeric SteamID64 from g_rgProfileData -> sends normally
  // =========================================================================
  {
    console.log('--- TEST 2: Vanity URL -> resolves SteamID64 from g_rgProfileData -> sends normally ---');
    mockLogger.clear();
    let requestedTargetId = null;
    const mockBm = createMockBrowserManager({
      mockDomProfileData: { steamid: '76561198123456789' },
      onFetchCalled: (args) => { requestedTargetId = args?.targetId; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/id/ShznoKuroha',
      'test comment',
      undefined // No SteamID provided initially
    );

    assert.strictEqual(result.status, 'SUCCESS', 'Must succeed when Vanity URL resolves to SteamID64');
    assert.strictEqual(requestedTargetId, '76561198123456789', 'Must POST to resolved 17-digit SteamID64, NOT Vanity URL');
    console.log('  -> TEST 2 PASSED: Vanity URL properly resolves to SteamID64 and sends.');
  }

  // =========================================================================
  // TEST 3: profiles/数字SteamID URL without targetSteamId -> resolves from URL
  // =========================================================================
  {
    console.log('--- TEST 3: profiles/numeric URL -> resolves directly from URL ---');
    mockLogger.clear();
    let requestedTargetId = null;
    const mockBm = createMockBrowserManager({
      onFetchCalled: (args) => { requestedTargetId = args?.targetId; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/profiles/76561198999999999',
      'test comment',
      '' // Empty targetSteamId
    );

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(requestedTargetId, '76561198999999999', 'Must extract 17-digit ID from profiles URL');
    console.log('  -> TEST 3 PASSED: profiles/numeric URL extracts 17-digit SteamID64.');
  }

  // =========================================================================
  // TEST 4: targetSteamId = "ShznoKuroha" -> MUST NOT short-circuit! Must resolve DOM
  // =========================================================================
  {
    console.log('--- TEST 4: targetSteamId = "ShznoKuroha" -> must resolve DOM, never POST vanity ---');
    mockLogger.clear();
    let requestedTargetId = null;
    const mockBm = createMockBrowserManager({
      mockDomProfileData: { steamid: '76561198444444444' },
      onFetchCalled: (args) => { requestedTargetId = args?.targetId; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/id/ShznoKuroha',
      'test comment',
      'ShznoKuroha' // Old bug passed vanity as targetSteamId
    );

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(requestedTargetId, '76561198444444444', 'Must POST to DOM resolved 17-digit SteamID, NOT ShznoKuroha');
    assert.notStrictEqual(requestedTargetId, 'ShznoKuroha', 'Must NEVER POST vanity name');
    console.log('  -> TEST 4 PASSED: Vanity targetSteamId is overridden by DOM-resolved SteamID64.');
  }

  // =========================================================================
  // TEST 5: Unresolvable Vanity URL -> fails safely, does NOT call POST, logs TARGET_STEAM_ID_RESOLUTION_FAILED
  // =========================================================================
  {
    console.log('--- TEST 5: Unresolvable Vanity URL -> fails safely without calling POST ---');
    mockLogger.clear();
    let postCallCount = 0;
    const mockBm = createMockBrowserManager({
      mockDomProfileData: null, // DOM resolution fails
      onFetchCalled: () => { postCallCount++; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/id/UnresolvableVanity',
      'test comment',
      'UnresolvableVanity'
    );

    assert.strictEqual(result.status, 'FAILED_RETRYABLE');
    assert.strictEqual(postCallCount, 0, 'POST must NEVER be attempted if SteamID64 resolution fails');
    assert.notStrictEqual(result.status, 'TARGET_REJECTED', 'Must NEVER be misclassified as TARGET_REJECTED');
    assert.notStrictEqual(result.status, 'PERMISSION_DENIED', 'Must not be classified as PERMISSION_DENIED');

    const diagError = mockLogger.errorCalls.find(c => c.tag === 'TARGET_STEAM_ID_RESOLUTION_FAILED');
    assert.ok(diagError, 'Must log TARGET_STEAM_ID_RESOLUTION_FAILED');
    assert.strictEqual(diagError.data.targetProfileUrl, 'https://steamcommunity.com/id/UnresolvableVanity');
    assert.strictEqual(diagError.data.originalTargetSteamId, 'UnresolvableVanity');
    assert.strictEqual(diagError.data.resolvedSteamId, null);
    assert.strictEqual(diagError.data.reason, 'Failed to resolve valid 17-digit numeric SteamID64');
    console.log('  -> TEST 5 PASSED: Unresolvable vanity fails safely with structured diagnostic log.');
  }

  // =========================================================================
  // TEST 6: SteamCommentTransport security gate: rejects non-17-digit targetSteamId64
  // =========================================================================
  {
    console.log('--- TEST 6: SteamCommentTransport rejects non-17-digit IDs ---');
    mockLogger.clear();
    const transport = new SteamCommentTransport(mockLogger);

    let fetchExecuted = false;
    const dummyPage = {
      evaluate: async () => {
        fetchExecuted = true;
        return {};
      }
    };

    // Case 6a: Vanity name passed to transport
    const resA = await transport.postComment(dummyPage, {
      targetSteamId64: 'ShznoKuroha',
      commentText: 'hello'
    });
    assert.strictEqual(fetchExecuted, false, 'page.evaluate must not be called with vanity string');
    assert.strictEqual(resA.httpStatus, 0);
    assert.ok(resA.networkError && resA.networkError.includes('INVALID_STEAMID64'));

    // Case 6b: Classification of INVALID_STEAMID64 must be NETWORK_ERROR, never TARGET_REJECTED
    const classifiedA = SteamSendErrorClassifier.classify(resA);
    assert.strictEqual(classifiedA.status, 'NETWORK_ERROR');
    assert.notStrictEqual(classifiedA.status, 'TARGET_REJECTED');
    assert.notStrictEqual(classifiedA.status, 'TARGET_REJECTION_CANDIDATE');

    // Case 6c: Too short numeric ID (e.g. 8 digits account ID)
    const resB = await transport.postComment(dummyPage, {
      targetSteamId64: '397235244',
      commentText: 'hello'
    });
    assert.strictEqual(fetchExecuted, false);
    assert.ok(resB.networkError && resB.networkError.includes('INVALID_STEAMID64'));

    // Case 6d: Empty ID
    const resC = await transport.postComment(dummyPage, {
      targetSteamId64: '',
      commentText: 'hello'
    });
    assert.strictEqual(fetchExecuted, false);
    assert.ok(resC.networkError && resC.networkError.includes('INVALID_STEAMID64'));

    console.log('  -> TEST 6 PASSED: SteamCommentTransport blocks all non-17-digit IDs.');
  }

  // =========================================================================
  // TEST 7: Account ID to SteamID64 conversion in comment thread / profile page
  // =========================================================================
  {
    console.log('--- TEST 7: 32-bit AccountID to 64-bit SteamID conversion ---');
    mockLogger.clear();
    let requestedTargetId = null;
    // 12345678 + 76561197960265728 = 76561197972611406
    const mockBm = createMockBrowserManager({
      mockMiniProfile: '12345678',
      onFetchCalled: (args) => { requestedTargetId = args?.targetId; }
    });

    const sender = new CommentSender(mockBm, myProfileUrl, mockLogger);
    const result = await sender.sendReply(
      'https://steamcommunity.com/id/visitor_account',
      'test comment'
    );

    assert.strictEqual(result.status, 'SUCCESS');
    assert.strictEqual(requestedTargetId, '76561197972611406', 'Must accurately convert 32-bit AccountID to 64-bit SteamID');
    console.log('  -> TEST 7 PASSED: 32-bit AccountID converted to 64-bit SteamID64 accurately.');
  }

  console.log('✅ ALL Vanity URL to SteamID64 Resolution Tests PASSED!\n');
}

module.exports = { runVanityUrlResolutionTests };
if (require.main === module) {
  runVanityUrlResolutionTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
