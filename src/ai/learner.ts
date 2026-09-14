import * as fs from 'fs';
import * as path from 'path';
import { PhraseRecord } from '../rules/classifier';
import { getPhrasesPath } from '../utils/paths';

export class AiLearner {
  private phrasesPath: string;
  private phrases: PhraseRecord[] = [];

  constructor(customPath?: string) {
    this.phrasesPath = customPath || getPhrasesPath();
    this.load();
  }

  public load(): void {
    if (fs.existsSync(this.phrasesPath)) {
      try {
        this.phrases = JSON.parse(fs.readFileSync(this.phrasesPath, 'utf8'));
      } catch (e: any) {
        console.warn('[AiLearner] Failed to read phrases:', e.message);
      }
    }
  }

  public save(): void {
    try {
      const dir = path.dirname(this.phrasesPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.phrasesPath, JSON.stringify(this.phrases, null, 2), 'utf8');
    } catch (e: any) {
      console.warn('[AiLearner] Failed to save phrases:', e.message);
    }
  }

  public getPhrases(): PhraseRecord[] {
    return this.phrases;
  }

  public processAiObservation(data: {
    phrases: string[];
    category: string;
    language: string;
    confidence: number;
    sampleReply?: string;
  }): { promotedCount: number; updatedCount: number } {
    if (!data.phrases || data.phrases.length === 0 || data.confidence < 0.85) {
      return { promotedCount: 0, updatedCount: 0 };
    }

    let promotedCount = 0;
    let updatedCount = 0;
    const now = new Date().toISOString();

    for (const rawPhrase of data.phrases) {
      const phrase = rawPhrase.trim();
      // Only learn short, meaningful phrases (2 to 15 chars, no URLs/code)
      if (phrase.length < 2 || phrase.length > 20 || /https?:\/\/|[0-9]{5,}/.test(phrase)) {
        continue;
      }

      const normalized = phrase.toLowerCase();
      const existing = this.phrases.find(p => p.normalized === normalized);

      if (!existing) {
        // 1st observation: candidate
        this.phrases.push({
          phrase,
          normalized,
          category: data.category,
          language: data.language,
          confidence: data.confidence,
          hitCount: 1,
          status: 'candidate',
          lastHit: now,
          source: 'ai_learned',
          replyTemplates: data.sampleReply ? [data.sampleReply] : []
        });
        updatedCount++;
      } else {
        // Existing phrase observed
        existing.lastHit = now;

        // Check if category and language are consistent
        if (existing.category === data.category && existing.language === data.language) {
          existing.hitCount++;
          // Increase or smooth confidence
          existing.confidence = Math.min(0.99, (existing.confidence + data.confidence) / 2);

          if (data.sampleReply && (!existing.replyTemplates || !existing.replyTemplates.includes(data.sampleReply))) {
            existing.replyTemplates = existing.replyTemplates || [];
            if (existing.replyTemplates.length < 5) {
              existing.replyTemplates.push(data.sampleReply);
            }
          }

          // Revision 5: Strict Promotion: 3 independent hits with high confidence (>= 0.90)
          if (existing.status === 'candidate' && existing.hitCount >= 3 && existing.confidence >= 0.90) {
            existing.status = 'stable';
            promotedCount++;
            console.log(`[AiLearner] Phrase "${phrase}" PROMOTED to stable local rule!`);
          }
          updatedCount++;
        } else {
          // Category conflict detected! Penalize confidence
          existing.confidence = Math.max(0.5, existing.confidence - 0.2);
          console.warn(`[AiLearner] Category conflict for "${phrase}": existing ${existing.category}, new ${data.category}. Confidence lowered to ${existing.confidence.toFixed(2)}`);
          if (existing.status === 'stable' && existing.confidence < 0.75) {
            existing.status = 'candidate'; // Demote if conflicting
          }
        }
      }
    }

    if (updatedCount > 0 || promotedCount > 0) {
      this.save();
    }

    return { promotedCount, updatedCount };
  }
}
