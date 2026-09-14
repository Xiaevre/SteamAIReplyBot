import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';
import {
  FullProfileSnapshot,
  KnowledgeBaseData,
  KnowledgeFact,
  KnowledgeInference,
  PersonaSuggestion,
  FormalPersona,
  AnalysisMeta
} from './types';

export class KnowledgeStore {
  private baseDir: string;
  private assetsDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || path.join(getDataDir(), 'profile-analysis');
    this.assetsDir = path.join(this.baseDir, 'assets');
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    if (!fs.existsSync(this.assetsDir)) {
      fs.mkdirSync(this.assetsDir, { recursive: true });
    }
  }

  public getAssetsDir(): string {
    return this.assetsDir;
  }

  // -------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------
  public getSnapshotPath(): string {
    return path.join(this.baseDir, 'steam-profile-snapshot.json');
  }

  public loadSnapshot(): FullProfileSnapshot | null {
    const p = this.getSnapshotPath();
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  public saveSnapshot(snapshot: FullProfileSnapshot): void {
    this.ensureDirs();
    fs.writeFileSync(this.getSnapshotPath(), JSON.stringify(snapshot, null, 2), 'utf8');
  }

  // -------------------------------------------------------------
  // Knowledge Base (Facts & Inferences)
  // -------------------------------------------------------------
  public getKnowledgePath(): string {
    return path.join(this.baseDir, 'knowledge.json');
  }

  public loadKnowledge(): KnowledgeBaseData {
    const p = this.getKnowledgePath();
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
          version: data.version || '1.0',
          updatedAt: data.updatedAt || new Date().toISOString(),
          facts: Array.isArray(data.facts) ? data.facts : [],
          inferences: Array.isArray(data.inferences) ? data.inferences : []
        };
      } catch {}
    }
    return {
      version: '1.0',
      updatedAt: new Date().toISOString(),
      facts: [],
      inferences: []
    };
  }

  public saveKnowledge(knowledge: KnowledgeBaseData): void {
    this.ensureDirs();
    fs.writeFileSync(this.getKnowledgePath(), JSON.stringify(knowledge, null, 2), 'utf8');
  }

  public addFact(fact: Omit<KnowledgeFact, 'id' | 'addedAt'>): KnowledgeFact {
    const kb = this.loadKnowledge();
    const newFact: KnowledgeFact = {
      ...fact,
      id: 'fact_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
      addedAt: new Date().toISOString(),
      enabled: fact.enabled !== undefined ? fact.enabled : true
    };
    kb.facts.push(newFact);
    kb.updatedAt = new Date().toISOString();
    this.saveKnowledge(kb);
    return newFact;
  }

  public addInference(inference: Omit<KnowledgeInference, 'id' | 'addedAt'>): KnowledgeInference {
    const kb = this.loadKnowledge();
    const newInference: KnowledgeInference = {
      ...inference,
      id: 'inf_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
      addedAt: new Date().toISOString(),
      enabled: inference.enabled !== undefined ? inference.enabled : true
    };
    kb.inferences.push(newInference);
    kb.updatedAt = new Date().toISOString();
    this.saveKnowledge(kb);
    return newInference;
  }

  // -------------------------------------------------------------
  // Persona Suggestions (Candidate Layer)
  // -------------------------------------------------------------
  public getPersonaSuggestionsPath(): string {
    return path.join(this.baseDir, 'persona-suggestions.json');
  }

  public loadPersonaSuggestions(): PersonaSuggestion[] {
    const p = this.getPersonaSuggestionsPath();
    if (!fs.existsSync(p)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  public savePersonaSuggestions(suggestions: PersonaSuggestion[]): void {
    this.ensureDirs();
    fs.writeFileSync(this.getPersonaSuggestionsPath(), JSON.stringify(suggestions, null, 2), 'utf8');
  }

  // -------------------------------------------------------------
  // Formal Persona (Active Persona Layer)
  // -------------------------------------------------------------
  public getFormalPersonaPath(): string {
    return path.join(this.baseDir, 'persona.json');
  }

  public loadFormalPersona(): FormalPersona {
    const p = this.getFormalPersonaPath();
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
          name: data.name || 'Steam玩家',
          tone: data.tone || 'friendly',
          traits: Array.isArray(data.traits) ? data.traits : ['热爱游戏', '友好交流'],
          favoriteGames: Array.isArray(data.favoriteGames) ? data.favoriteGames : [],
          communicationStyle: Array.isArray(data.communicationStyle) ? data.communicationStyle : [],
          recommendedTopics: Array.isArray(data.recommendedTopics) ? data.recommendedTopics : [],
          avoidTopics: Array.isArray(data.avoidTopics) ? data.avoidTopics : [],
          updatedAt: data.updatedAt || new Date().toISOString()
        };
      } catch {}
    }
    return {
      name: 'Steam玩家',
      tone: 'friendly',
      traits: ['热爱游戏', '友好交流'],
      favoriteGames: [],
      communicationStyle: ['自然口语', '真诚友善'],
      recommendedTopics: ['游戏体验', 'Steam主页搭配'],
      avoidTopics: [],
      updatedAt: new Date().toISOString()
    };
  }

  public saveFormalPersona(persona: FormalPersona): void {
    this.ensureDirs();
    fs.writeFileSync(this.getFormalPersonaPath(), JSON.stringify(persona, null, 2), 'utf8');
  }

  public applySuggestion(suggestionId: string): { success: boolean; message: string } {
    const suggestions = this.loadPersonaSuggestions();
    const target = suggestions.find(s => s.id === suggestionId);
    if (!target) {
      return { success: false, message: 'Suggestion not found' };
    }

    target.status = 'accepted';
    this.savePersonaSuggestions(suggestions);

    const formal = this.loadFormalPersona();
    if (target.category === 'tone') {
      const matchTone = target.suggestion.match(/(friendly|playful|polite|cool|scholarly)/i);
      if (matchTone) {
        formal.tone = matchTone[1].toLowerCase() as any;
      }
    } else if (target.category === 'interests') {
      if (!formal.favoriteGames.includes(target.suggestion)) {
        formal.favoriteGames.push(target.suggestion);
      }
    } else if (target.category === 'topics') {
      if (!formal.recommendedTopics.includes(target.suggestion)) {
        formal.recommendedTopics.push(target.suggestion);
      }
    } else if (target.category === 'style') {
      if (!formal.communicationStyle.includes(target.suggestion)) {
        formal.communicationStyle.push(target.suggestion);
      }
    }
    formal.updatedAt = new Date().toISOString();
    this.saveFormalPersona(formal);

    return { success: true, message: `Applied suggestion [${target.title}] to formal persona` };
  }

  public rejectSuggestion(suggestionId: string): { success: boolean } {
    const suggestions = this.loadPersonaSuggestions();
    const target = suggestions.find(s => s.id === suggestionId);
    if (!target) return { success: false };
    target.status = 'rejected';
    this.savePersonaSuggestions(suggestions);
    return { success: true };
  }

  // -------------------------------------------------------------
  // Analysis Meta
  // -------------------------------------------------------------
  public getMetaPath(): string {
    return path.join(this.baseDir, 'analysis-meta.json');
  }

  public loadMeta(): AnalysisMeta {
    const p = this.getMetaPath();
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
          lastSyncAt: data.lastSyncAt || null,
          lastAnalyzedAt: data.lastAnalyzedAt || null,
          lastAnalyzedFingerprint: data.lastAnalyzedFingerprint || null,
          currentFingerprint: data.currentFingerprint || null,
          analysisMode: data.analysisMode || 'MANUAL',
          status: data.status || 'idle',
          lastError: data.lastError || null,
          deepSeekVisionUsed: Boolean(data.deepSeekVisionUsed)
        };
      } catch {}
    }
    return {
      lastSyncAt: null,
      lastAnalyzedAt: null,
      lastAnalyzedFingerprint: null,
      currentFingerprint: null,
      analysisMode: 'MANUAL',
      status: 'idle',
      lastError: null,
      deepSeekVisionUsed: false
    };
  }

  public updateMeta(patch: Partial<AnalysisMeta>): AnalysisMeta {
    const current = this.loadMeta();
    const updated = { ...current, ...patch };
    this.ensureDirs();
    fs.writeFileSync(this.getMetaPath(), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  // -------------------------------------------------------------
  // Local Knowledge Lookup for Daily Replies
  // -------------------------------------------------------------
  /**
   * Fast, zero-overhead local keyword and relevance search over active Facts and Inferences.
   * Returns matching summary snippets to inject into AI prompt.
   */
  public findRelevantKnowledge(queryText: string, maxSnippets: number = 3): string[] {
    if (!queryText || typeof queryText !== 'string') return [];
    const queryLower = queryText.toLowerCase().trim();

    const kb = this.loadKnowledge();
    const matches: Array<{ text: string; score: number }> = [];

    // Check facts
    for (const fact of kb.facts) {
      if (!fact.enabled) continue;
      const contentLower = fact.content.toLowerCase();
      let score = 0;

      // Direct substring match
      if (contentLower.includes(queryLower) || queryLower.includes(contentLower)) {
        score += 5;
      }

      // Token match
      const words = queryLower.split(/[\s,，.。!！?？~、\-_/]+/);
      for (const w of words) {
        if (w.length >= 2 && contentLower.includes(w)) {
          score += 2;
        }
      }

      // Also check reverse tokens from content
      const contentWords = contentLower.split(/[\s,，.。!！?？~、\-_/]+/);
      for (const cw of contentWords) {
        if (cw.length >= 3 && queryLower.includes(cw)) {
          score += 2;
        }
      }

      if (score > 0) {
        matches.push({ text: `[事实] ${fact.content}`, score });
      }
    }

    // Check inferences
    for (const inf of kb.inferences) {
      if (!inf.enabled) continue;
      const contentLower = inf.content.toLowerCase();
      let score = 0;

      // Direct substring match
      if (contentLower.includes(queryLower) || queryLower.includes(contentLower)) {
        score += 4;
      }

      // Token match
      const words = queryLower.split(/[\s,，.。!！?？~、\-_/]+/);
      for (const w of words) {
        if (w.length >= 2 && contentLower.includes(w)) {
          score += 1.5;
        }
      }

      const contentWords = contentLower.split(/[\s,，.。!！?？~、\-_/]+/);
      for (const cw of contentWords) {
        if (cw.length >= 3 && queryLower.includes(cw)) {
          score += 1.5;
        }
      }

      if (score > 0) {
        matches.push({ text: `[推断] ${inf.content}`, score });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, maxSnippets).map(m => m.text);
  }
}
