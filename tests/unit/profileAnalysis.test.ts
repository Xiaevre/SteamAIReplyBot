import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  FullProfileSnapshot,
  KnowledgeBaseData,
  PersonaSuggestion,
  FormalPersona,
  SteamProfileData,
  SteamGameHistory,
  ProfileVisualSnapshot
} from '../../src/profile/types';
import { ProfileSnapshotFingerprint } from '../../src/profile/fingerprint';
import { KnowledgeStore } from '../../src/profile/knowledgeStore';
import { DeepSeekProfileCurator, CuratorResult } from '../../src/profile/deepseekCurator';
import { ProfileAnalysisManager } from '../../src/profile/profileAnalysisManager';
import { Logger } from '../../src/utils/logger';

export async function runProfileAnalysisTests() {
  console.log('--- Starting Profile Analysis, Knowledge Base & Persona Unit Tests ---');

  const testTempDir = path.join(__dirname, '..', 'temp_profile_test_' + Date.now());
  if (!fs.existsSync(testTempDir)) {
    fs.mkdirSync(testTempDir, { recursive: true });
  }

  const logger = new Logger();

  try {
    // -------------------------------------------------------------
    // 1. Schema & Sample Snapshot Preparation
    // -------------------------------------------------------------
    const sampleProfile: SteamProfileData = {
      steamId: '76561198000000001',
      personaName: 'TestGamer',
      level: 42,
      summary: '喜欢二次元与动作游戏 ✨🎮',
      avatarUrl: 'https://example.com/avatar.jpg',
      customSymbols: ['✨', '🎮'],
      languagesDetected: ['zh', 'ja'],
      showcases: [
        {
          type: 'favorite_game',
          title: '最喜爱的游戏',
          items: [{ title: 'Elden Ring', text: '已全成就' }]
        },
        {
          type: 'artwork',
          title: '二次元插画展柜',
          items: [{ title: 'Anime artwork 01' }]
        }
      ],
      recentGames: [
        { name: 'Elden Ring', hoursTwoWeeks: 12.5, hoursTotal: 450, appId: '1245620' },
        { name: 'Genshin Impact', hoursTwoWeeks: 5.0, hoursTotal: 800 }
      ]
    };

    const sampleGames: SteamGameHistory = {
      totalGames: 120,
      topPlayedGames: [
        { name: 'Genshin Impact', hours: 800, appId: '1' },
        { name: 'Elden Ring', hours: 450, appId: '1245620' },
        { name: 'Monster Hunter World', hours: 320, appId: '582010' }
      ],
      recentActiveGames: sampleProfile.recentGames
    };

    const sampleVisual: ProfileVisualSnapshot = {
      visualSummary: {
        aestheticTone: 'anime_vibrant',
        hasCustomArtwork: true,
        badgeCount: 25
      },
      screenshotHashes: ['hash_abc123', 'hash_def456']
    };

    // -------------------------------------------------------------
    // 2 & 3. Fingerprint Stability & Computation
    // -------------------------------------------------------------
    const fp1 = ProfileSnapshotFingerprint.compute(sampleProfile, sampleGames, sampleVisual);
    const fp2 = ProfileSnapshotFingerprint.compute(sampleProfile, sampleGames, sampleVisual);
    assert.strictEqual(typeof fp1, 'string', 'Fingerprint should be a string');
    assert.strictEqual(fp1.length, 64, 'Fingerprint should be SHA-256 (64 hex characters)');
    assert.strictEqual(fp1, fp2, 'Fingerprint must be stable for identical data');
    console.log('  [PASS] Fingerprint stable and deterministic');

    // 4. Fingerprint Change on Modified Profile
    const modifiedProfile: SteamProfileData = { ...sampleProfile, level: 43 };
    const fpChanged = ProfileSnapshotFingerprint.compute(modifiedProfile, sampleGames, sampleVisual);
    assert.notStrictEqual(fp1, fpChanged, 'Fingerprint must change when profile changes');
    console.log('  [PASS] Fingerprint reacts to profile mutations');

    const fullSnapshot: FullProfileSnapshot = {
      version: '1.0',
      capturedAt: new Date().toISOString(),
      fingerprint: fp1,
      profile: sampleProfile,
      games: sampleGames,
      visual: sampleVisual
    };

    // -------------------------------------------------------------
    // 5. KnowledgeStore Persistence
    // -------------------------------------------------------------
    const store = new KnowledgeStore(testTempDir);
    store.saveSnapshot(fullSnapshot);
    const loadedSnap = store.loadSnapshot();
    assert.ok(loadedSnap, 'Snapshot should be loadable');
    assert.strictEqual(loadedSnap?.fingerprint, fp1);
    assert.strictEqual(loadedSnap?.profile.personaName, 'TestGamer');
    console.log('  [PASS] KnowledgeStore saves and loads snapshot correctly');

    // -------------------------------------------------------------
    // 6. Fact vs Inference Strict Separation
    // -------------------------------------------------------------
    const fact = store.addFact({
      category: 'games',
      content: 'Elden Ring 累计游玩 450 小时并已全成就',
      source: 'steam_games_history',
      confidence: 1.0,
      enabled: true
    });
    assert.ok(fact.id.startsWith('fact_'));
    assert.strictEqual(fact.confidence, 1.0, 'FACT must have 1.0 confidence');

    const inference = store.addInference({
      category: 'preferences',
      content: '偏好高难度动作角色扮演与开放世界探索游戏',
      evidence: ['Elden Ring 450h', 'Monster Hunter 320h'],
      confidence: 0.88,
      enabled: true
    });
    assert.ok(inference.id.startsWith('inf_'));
    assert.ok(inference.confidence < 1.0, 'INFERENCE must have probabilistic confidence');
    assert.ok(Array.isArray(inference.evidence), 'INFERENCE must retain evidence source list');
    console.log('  [PASS] FACT and INFERENCE strictly separated with confidence and evidence');

    // -------------------------------------------------------------
    // 7. Local Knowledge Lookup (Zero-overhead keyword match for daily replies)
    // -------------------------------------------------------------
    const matches1 = store.findRelevantKnowledge('你玩过 Elden Ring 吗？');
    assert.ok(matches1.length > 0, 'Should match Elden Ring fact');
    assert.ok(matches1[0].includes('Elden Ring') || matches1[0].includes('事实'));

    const matches2 = store.findRelevantKnowledge('晚上好！');
    assert.strictEqual(matches2.length, 0, 'Simple greeting should not match complex game knowledge');
    console.log('  [PASS] Local knowledge lookup matches keywords accurately without overhead');

    // -------------------------------------------------------------
    // 8. Persona Suggestions (Candidate Layer) & Formal Persona Protection
    // -------------------------------------------------------------
    const initialFormal = store.loadFormalPersona();
    assert.ok(initialFormal, 'Formal persona default exists');
    assert.strictEqual(initialFormal.name, 'Steam玩家');

    const suggestion: PersonaSuggestion = {
      id: 'sug_test_01',
      title: '动作游戏偏好',
      suggestion: 'Elden Ring',
      category: 'interests',
      confidenceLevel: 'HIGH_CONFIDENCE',
      confidenceScore: 0.95,
      evidence: ['Elden Ring 450h showcase'],
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    store.savePersonaSuggestions([suggestion]);

    // Check that pending suggestion does NOT auto-write to formal persona
    const formalBeforeApproval = store.loadFormalPersona();
    assert.ok(!formalBeforeApproval.favoriteGames.includes('Elden Ring'), 'Suggestion must NOT automatically overwrite formal persona!');

    // User applies suggestion
    const applyRes = store.applySuggestion('sug_test_01');
    assert.strictEqual(applyRes.success, true);
    const formalAfterApproval = store.loadFormalPersona();
    assert.ok(formalAfterApproval.favoriteGames.includes('Elden Ring'), 'Formal persona updated ONLY AFTER explicit user approval');

    // Reject suggestion test
    const suggestion2: PersonaSuggestion = {
      id: 'sug_test_02',
      title: '中二风格',
      suggestion: '使用中二病口癖',
      category: 'style',
      confidenceLevel: 'LOW_CONFIDENCE',
      confidenceScore: 0.3,
      evidence: ['主页有特殊符号'],
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    store.savePersonaSuggestions([suggestion, suggestion2]);
    store.rejectSuggestion('sug_test_02');
    const updatedSugs = store.loadPersonaSuggestions();
    assert.strictEqual(updatedSugs.find(s => s.id === 'sug_test_02')?.status, 'rejected');
    console.log('  [PASS] Persona suggestions require user approval, never auto-overwrite');

    // -------------------------------------------------------------
    // 9. DeepSeek Curator Mock & JSON Parser Fallback
    // -------------------------------------------------------------
    const mockDeepSeekClient: any = {
      generateReply: async () => {
        return {
          reply: JSON.stringify({
            facts: [
              { category: 'identity', content: 'Steam 资料等级为 42 级', source: 'steam_profile_level', confidence: 1.0 },
              { category: 'games', content: 'Genshin Impact 游玩超过 800 小时', source: 'steam_games_history', confidence: 1.0 }
            ],
            inferences: [
              { category: 'aesthetic', content: '主页具有明显的二次元与动漫视觉风格', evidence: ['二次元插画展柜', '简介二次元表情'], confidence: 0.85 }
            ],
            personaSuggestions: [
              { title: '二次元风格', suggestion: 'playful', category: 'tone', confidenceLevel: 'MEDIUM_CONFIDENCE', confidenceScore: 0.75, evidence: ['插画展柜'] }
            ],
            summary: {
              recommendedTopics: ['开放世界游戏', '动漫展柜搭配'],
              avoidAssumptions: ['不要擅自推断现实身份']
            }
          })
        };
      }
    };

    const curator = new DeepSeekProfileCurator(mockDeepSeekClient, logger);
    const curationResult = await curator.analyzeSnapshot(fullSnapshot);
    assert.ok(curationResult, 'Curator should return parsed structured result');
    assert.strictEqual(curationResult?.facts.length, 2);
    assert.strictEqual(curationResult?.inferences.length, 1);
    assert.strictEqual(curationResult?.personaSuggestions.length, 1);
    console.log('  [PASS] DeepSeekProfileCurator parses structured JSON facts/inferences/suggestions');

    // 10. ProfileAnalysisManager Caching via Fingerprint
    let deepSeekCalls = 0;
    const trackingDeepSeekClient: any = {
      generateReply: async () => {
        deepSeekCalls++;
        return {
          reply: JSON.stringify({
            facts: [],
            inferences: [],
            personaSuggestions: [],
            summary: { recommendedTopics: [], avoidAssumptions: [] }
          })
        };
      }
    };

    const trackingCurator = new DeepSeekProfileCurator(trackingDeepSeekClient, logger);
    const manager = new ProfileAnalysisManager({
      curator: trackingCurator,
      store,
      logger
    });

    // First analysis: fingerprint is new -> calls DeepSeek
    const analyze1 = await manager.analyzeProfile();
    assert.strictEqual(analyze1.success, true);
    assert.strictEqual(analyze1.cached, false);
    assert.strictEqual(deepSeekCalls, 1, 'First analysis should call DeepSeek');

    // Second analysis: fingerprint identical -> cached! DeepSeek NOT called
    const analyze2 = await manager.analyzeProfile();
    assert.strictEqual(analyze2.success, true);
    assert.strictEqual(analyze2.cached, true, 'Second analysis with same fingerprint must be cached');
    assert.strictEqual(deepSeekCalls, 1, 'Same fingerprint must NOT trigger DeepSeek call');

    // Force analysis -> bypasses cache
    const analyze3 = await manager.analyzeProfile({ force: true });
    assert.strictEqual(analyze3.success, true);
    assert.strictEqual(analyze3.cached, false);
    assert.strictEqual(deepSeekCalls, 2, 'Forced analysis calls DeepSeek');
    console.log('  [PASS] Fingerprint caching strictly prevents redundant DeepSeek calls');

    // -------------------------------------------------------------
    // 11. Manager calls collectSelfProfile & passes SteamBrowserManager
    // -------------------------------------------------------------
    let collectSelfProfileCalled = false;
    let browserManagerReceived: any = null;

    const mockBrowserManager: any = {
      isSteamBrowserManager: true,
      openEphemeralPage: async () => {
        return {
          goto: async () => {},
          evaluate: async () => ({}),
          close: async () => {}
        };
      }
    };

    const mockCollector: any = {
      collectSelfProfile: async (knownSteamId?: string) => {
        collectSelfProfileCalled = true;
        return {
          ...fullSnapshot,
          profile: { ...sampleProfile, personaName: 'SyncedPersona' }
        };
      }
    };

    const syncStore = new KnowledgeStore(testTempDir);
    const syncManager = new ProfileAnalysisManager({
      collector: mockCollector,
      store: syncStore,
      logger,
      browserManager: mockBrowserManager
    });

    assert.strictEqual(typeof (mockCollector as any).collectFullSnapshot, 'undefined', 'collectFullSnapshot must not exist');
    const syncResult = await syncManager.syncProfile();
    assert.strictEqual(syncResult.success, true, 'syncProfile should return success: true');
    assert.strictEqual(collectSelfProfileCalled, true, 'Manager MUST call collectSelfProfile!');
    
    // Status should be completed
    const metaAfterSync = syncStore.loadMeta();
    assert.strictEqual(metaAfterSync.status, 'completed', 'Metadata status must transition to completed on success');
    assert.ok(metaAfterSync.lastSyncAt, 'lastSyncAt must be populated');
    assert.strictEqual(metaAfterSync.lastError, null, 'lastError must be null');

    const loadedSnapshot = syncStore.loadSnapshot();
    assert.strictEqual(loadedSnapshot?.profile.personaName, 'SyncedPersona', 'Saved snapshot must match collected data');
    console.log('  [PASS] Manager calls collectSelfProfile, saves snapshot, and updates status=completed');

    // -------------------------------------------------------------
    // 12. Manager sync error handling: status=failed + lastError
    // -------------------------------------------------------------
    const failingCollector: any = {
      collectSelfProfile: async () => {
        throw new Error('Connection reset by peer at Steam Community');
      }
    };

    const failManager = new ProfileAnalysisManager({
      collector: failingCollector,
      store: syncStore,
      logger
    });

    const failResult = await failManager.syncProfile();
    assert.strictEqual(failResult.success, false, 'Failed sync must return success: false');
    assert.strictEqual(failResult.error, 'Connection reset by peer at Steam Community');

    const metaAfterFail = syncStore.loadMeta();
    assert.strictEqual(metaAfterFail.status, 'failed', 'Status must transition to failed on error');
    assert.strictEqual(metaAfterFail.lastError, 'Connection reset by peer at Steam Community', 'lastError must record real error');
    console.log('  [PASS] Manager records status=failed and captures real lastError on failure');

    // -------------------------------------------------------------
    // 13. Dynamic SteamProfileCollector creation with SteamBrowserManager & ephemeral page
    // -------------------------------------------------------------
    let ephemeralPageOpened = false;
    let ephemeralPageClosed = false;

    const dynamicBrowserManager: any = {
      openEphemeralPage: async () => {
        ephemeralPageOpened = true;
        return {
          goto: async () => {},
          evaluate: async () => ({
            steamId: '76561198000000001',
            personaName: 'EphemeralUser',
            showcases: [],
            recentGames: []
          }),
          close: async () => { ephemeralPageClosed = true; },
          on: () => {}
        };
      }
    };

    const dynamicStore = new KnowledgeStore(path.join(testTempDir, 'dynamic'));
    const dynamicManager = new ProfileAnalysisManager({
      store: dynamicStore,
      logger,
      browserManager: dynamicBrowserManager
    });

    const dynamicResult = await dynamicManager.syncProfile();
    assert.strictEqual(dynamicResult.success, true);
    assert.strictEqual(ephemeralPageOpened, true, 'Collector must use openEphemeralPage on the existing browserManager');
    assert.strictEqual(dynamicStore.loadMeta().status, 'completed');
    console.log('  [PASS] Manager dynamically uses SteamBrowserManager.openEphemeralPage without launching new browser profiles');

    // -------------------------------------------------------------
    // 14. Concurrency Guard: reject overlapping sync calls
    // -------------------------------------------------------------
    let slowResolve: () => void;
    const slowCollector: any = {
      collectSelfProfile: () => new Promise(resolve => {
        slowResolve = () => resolve(fullSnapshot);
      })
    };

    const concurrentManager = new ProfileAnalysisManager({
      collector: slowCollector,
      store: syncStore,
      logger
    });

    const p1 = concurrentManager.syncProfile();
    assert.strictEqual(concurrentManager.isBusy(), true, 'Manager must be busy while sync is in flight');
    assert.strictEqual(syncStore.loadMeta().status, 'syncing', 'Status must be syncing during operation');

    const p2Result = await concurrentManager.syncProfile();
    assert.strictEqual(p2Result.success, false, 'Overlapping sync must be rejected');
    assert.ok(p2Result.error?.includes('already in progress'));

    slowResolve!();
    await p1;
    assert.strictEqual(concurrentManager.isBusy(), false);
    assert.strictEqual(syncStore.loadMeta().status, 'completed');
    console.log('  [PASS] Concurrency guard rejects overlapping sync jobs and tracks busy state accurately');

    // -------------------------------------------------------------
    // 15. DeepSeekClient generateChat integration for Profile Curation
    // -------------------------------------------------------------
    let chatSystemPromptSent = '';
    let chatUserPromptSent = '';
    const mockChatDeepSeekClient: any = {
      generateChat: async (sys: string, user: string) => {
        chatSystemPromptSent = sys;
        chatUserPromptSent = user;
        return JSON.stringify({
          facts: [
            { category: 'games', content: 'Wallpaper Engine 累计游玩 3124 小时', source: 'steam_games_history', confidence: 1.0 },
            { category: 'games', content: 'Monster Hunter Rise 累计游玩 642 小时', source: 'steam_games_history', confidence: 1.0 }
          ],
          inferences: [
            { category: 'preferences', content: '推断热爱动作狩猎类与桌面美化工具', evidence: ['Monster Hunter 642h', 'Wallpaper Engine 3124h'], confidence: 0.9 }
          ],
          personaSuggestions: [
            { title: '硬核玩家话题', suggestion: '怪猎狩猎技巧交流', category: 'topics', confidenceScore: 0.9, evidence: ['MHR 642h'] }
          ],
          summary: {
            aestheticProfile: '桌面美化与二次元偏好',
            gamingFocus: '动作共斗与休闲美化',
            communicationStyle: '热情硬核',
            profileStyle: '精致DIY',
            recommendedTopics: ['怪猎配装', '动态壁纸推荐'],
            avoidAssumptions: ['不要擅自推测现实职业']
          }
        });
      }
    };

    const chatCurator = new DeepSeekProfileCurator(mockChatDeepSeekClient, logger);
    const chatCurationResult = await chatCurator.analyzeSnapshot(fullSnapshot);
    assert.ok(chatCurationResult, 'Curator must succeed using generateChat');
    assert.ok(chatSystemPromptSent.includes('专业'), 'Curator must transmit its own systemPrompt');
    assert.ok(!chatUserPromptSent.includes('用户【SteamProfileCurator】在我的 Steam Profile 留言'), 'Must NOT wrap prompt in comment reply format');
    assert.strictEqual(chatCurationResult?.facts.length, 2);
    assert.strictEqual(chatCurationResult?.facts[0].content, 'Wallpaper Engine 累计游玩 3124 小时');
    assert.strictEqual(chatCurationResult?.inferences.length, 1);
    console.log('  [PASS] DeepSeekProfileCurator cleanly uses generateChat with exact curator system prompt');

    // -------------------------------------------------------------
    // 16. Empty Game History Resilience: Curation never fails due to 0 games
    // -------------------------------------------------------------
    const emptyGamesSnapshot: FullProfileSnapshot = {
      ...fullSnapshot,
      games: { totalGames: 0, topPlayedGames: [], recentActiveGames: [] }
    };
    const emptyGamesCuratorResult = await chatCurator.analyzeSnapshot(emptyGamesSnapshot);
    assert.ok(emptyGamesCuratorResult, 'Curator must succeed even when topPlayedGames is empty');
    console.log('  [PASS] Empty game history does not cause profile curation to fail');

    // -------------------------------------------------------------
    // 17. Script-embedded rgGames regex extraction simulation
    // -------------------------------------------------------------
    const sampleScriptHtml = `
      var g_AccountPulldown = "TestUser";
      var rgGames = [
        {"appid":431960,"name":"Wallpaper Engine","hours_forever":"3,124.5","last_played":1725000000},
        {"appid":1446780,"name":"Monster Hunter Rise","hours_forever":"642.1","hours_2weeks":"15.2","last_played":1725500000},
        {"appid":774171,"name":"Muse Dash","hours_forever":"381.0","last_played":1724000000}
      ];
      var g_rgProfileData = {};
    `;

    const match = sampleScriptHtml.match(/var\s+rgGames\s*=\s*(\[\s*\{[\s\S]*?\}\s*\]);/);
    assert.ok(match, 'Regex must match inline script rgGames array');
    const parsedGames = JSON.parse(match[1]);
    assert.strictEqual(parsedGames.length, 3);
    assert.strictEqual(parsedGames[0].name, 'Wallpaper Engine');
    assert.strictEqual(parseFloat(parsedGames[0].hours_forever.replace(/,/g, '')), 3124.5);
    assert.strictEqual(parsedGames[1].name, 'Monster Hunter Rise');
    console.log('  [PASS] Inline script rgGames regex extraction successfully extracts games and hours');

    console.log('--- Profile Analysis Unit Tests Completed Successfully ---\n');
  } finally {
    // Cleanup temporary directory
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
  }
}
