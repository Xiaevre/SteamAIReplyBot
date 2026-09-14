import { FullProfileSnapshot, AnalysisMeta, PersonaSuggestion, FormalPersona } from './types';
import { SteamProfileCollector } from './profileCollector';
import { DeepSeekProfileCurator, CuratorResult } from './deepseekCurator';
import { KnowledgeStore } from './knowledgeStore';
import { ProfileSnapshotFingerprint } from './fingerprint';
import { Logger } from '../utils/logger';
import { SteamBrowserManager } from '../steam/browser';

export interface AnalysisManagerOptions {
  collector?: SteamProfileCollector;
  curator?: DeepSeekProfileCurator;
  store?: KnowledgeStore;
  logger: Logger;
  browserManager?: SteamBrowserManager;
}

export class ProfileAnalysisManager {
  private collector?: SteamProfileCollector;
  private curator?: DeepSeekProfileCurator;
  private store: KnowledgeStore;
  private logger: Logger;
  private browserManager?: SteamBrowserManager;
  private isWorking: boolean = false;

  constructor(options: AnalysisManagerOptions) {
    this.collector = options.collector;
    this.curator = options.curator;
    this.store = options.store || new KnowledgeStore();
    this.logger = options.logger;
    this.browserManager = options.browserManager;
  }

  public setCollector(collector: SteamProfileCollector): void {
    this.collector = collector;
  }

  public setBrowserManager(browserManager: SteamBrowserManager): void {
    this.browserManager = browserManager;
  }

  public isBusy(): boolean {
    return this.isWorking;
  }

  public getStore(): KnowledgeStore {
    return this.store;
  }

  public getStatus(): AnalysisMeta {
    return this.store.loadMeta();
  }

  /**
   * Sync Steam Profile from browser context.
   * Runs Collector, saves FullProfileSnapshot, and computes current fingerprint.
   * Async, non-blocking to bot main loop.
   */
  public async syncProfile(browserManager?: SteamBrowserManager, knownSteamId?: string): Promise<{ success: boolean; fingerprint?: string; error?: string }> {
    if (this.isWorking) {
      return { success: false, error: 'A sync or analysis job is already in progress.' };
    }

    const bm = browserManager || this.browserManager;
    if (!this.collector && !bm) {
      return { success: false, error: 'No collector or browser manager available for profile sync.' };
    }

    this.isWorking = true;
    this.store.updateMeta({ status: 'syncing', lastError: null });

    try {
      let collector = this.collector;
      if (!collector && bm) {
        collector = new SteamProfileCollector(bm, this.logger, { assetsDir: this.store.getAssetsDir() });
      }

      if (!collector) {
        throw new Error('Failed to initialize SteamProfileCollector');
      }

      this.logger.info('PROFILE_ANALYSIS_SYNC_STARTED', { knownSteamId });
      const snapshot = await collector.collectSelfProfile(knownSteamId);

      // Save snapshot
      this.store.saveSnapshot(snapshot);

      // Update metadata
      const now = new Date().toISOString();
      this.store.updateMeta({
        status: 'completed',
        lastSyncAt: now,
        currentFingerprint: snapshot.fingerprint,
        lastError: null
      });

      this.logger.info('PROFILE_ANALYSIS_SYNC_SUCCESS', {
        fingerprint: snapshot.fingerprint,
        personaName: snapshot.profile.personaName
      });

      return { success: true, fingerprint: snapshot.fingerprint };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.logger.error('PROFILE_ANALYSIS_SYNC_FAILED', { error: errMsg });
      this.store.updateMeta({
        status: 'failed',
        lastError: errMsg
      });
      return { success: false, error: errMsg };
    } finally {
      this.isWorking = false;
    }
  }

  /**
   * Analyzes the saved snapshot using DeepSeek Curator.
   * STRICT COST CONTROL:
   * If currentFingerprint === lastAnalyzedFingerprint and force is not set, DeepSeek will NOT be called.
   */
  public async analyzeProfile(options: { force?: boolean } = {}): Promise<{
    success: boolean;
    cached?: boolean;
    error?: string;
    factsCount?: number;
    inferencesCount?: number;
    suggestionsCount?: number;
  }> {
    if (this.isWorking) {
      return { success: false, error: 'A sync or analysis job is already in progress.' };
    }

    const snapshot = this.store.loadSnapshot();
    if (!snapshot) {
      return { success: false, error: 'No profile snapshot found. Please sync your Steam profile first.' };
    }

    const meta = this.store.loadMeta();
    const currentFp = snapshot.fingerprint;

    // Check fingerprint cache
    if (!options.force && meta.lastAnalyzedFingerprint && meta.lastAnalyzedFingerprint === currentFp) {
      this.logger.info('DEEPSEEK_ANALYSIS_SKIPPED_FINGERPRINT_MATCH', {
        fingerprint: currentFp,
        lastAnalyzedAt: meta.lastAnalyzedAt
      });
      return {
        success: true,
        cached: true,
        factsCount: this.store.loadKnowledge().facts.length,
        inferencesCount: this.store.loadKnowledge().inferences.length,
        suggestionsCount: this.store.loadPersonaSuggestions().length
      };
    }

    if (!this.curator) {
      return { success: false, error: 'DeepSeekProfileCurator is not configured or unavailable.' };
    }

    this.isWorking = true;
    this.store.updateMeta({ status: 'analyzing', lastError: null });

    try {
      const result: CuratorResult | null = await this.curator.analyzeSnapshot(snapshot);
      if (!result) {
        throw new Error('DeepSeek curation returned no result or encountered an error.');
      }

      // 1. Update Knowledge Base (Facts and Inferences)
      const kb = this.store.loadKnowledge();

      // Merge new facts without duplicating identical content
      for (const f of result.facts) {
        const exists = kb.facts.some(existing => existing.content === f.content);
        if (!exists) {
          this.store.addFact(f);
        }
      }

      // Merge new inferences without duplicating identical content
      for (const inf of result.inferences) {
        const exists = kb.inferences.some(existing => existing.content === inf.content);
        if (!exists) {
          this.store.addInference(inf);
        }
      }

      // 2. Add Persona Suggestions (candidate layer, NEVER auto-applied to formal persona)
      const existingSuggestions = this.store.loadPersonaSuggestions();
      for (const s of result.personaSuggestions) {
        const exists = existingSuggestions.some(existing => existing.suggestion === s.suggestion);
        if (!exists) {
          existingSuggestions.push({
            ...s,
            id: 'sug_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
            createdAt: new Date().toISOString()
          });
        }
      }
      this.store.savePersonaSuggestions(existingSuggestions);

      // 3. Update Analysis Meta
      const now = new Date().toISOString();
      this.store.updateMeta({
        status: 'completed',
        lastAnalyzedAt: now,
        lastAnalyzedFingerprint: currentFp,
        currentFingerprint: currentFp,
        lastError: null,
        deepSeekVisionUsed: Boolean(process.env.PROFILE_VISION_ANALYSIS_ENABLED === 'true')
      });

      this.logger.info('DEEPSEEK_ANALYSIS_COMPLETED', {
        fingerprint: currentFp,
        newFacts: result.facts.length,
        newInferences: result.inferences.length,
        newSuggestions: result.personaSuggestions.length
      });

      return {
        success: true,
        cached: false,
        factsCount: result.facts.length,
        inferencesCount: result.inferences.length,
        suggestionsCount: result.personaSuggestions.length
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.logger.error('DEEPSEEK_ANALYSIS_FAILED', { error: errMsg });
      this.store.updateMeta({
        status: 'failed',
        lastError: errMsg
      });
      return { success: false, error: errMsg };
    } finally {
      this.isWorking = false;
    }
  }

  // -------------------------------------------------------------
  // User Actions (Suggestions & Persona)
  // -------------------------------------------------------------
  public applySuggestion(suggestionId: string) {
    return this.store.applySuggestion(suggestionId);
  }

  public rejectSuggestion(suggestionId: string) {
    return this.store.rejectSuggestion(suggestionId);
  }

  public updateFormalPersona(persona: FormalPersona) {
    this.store.saveFormalPersona(persona);
    return { success: true };
  }
}
