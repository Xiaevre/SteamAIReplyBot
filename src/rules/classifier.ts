import * as fs from 'fs';
import * as path from 'path';
import { SpamFilter } from './spamFilter';
import { AsciiArtDetector } from './asciiArtDetector';
import { VisualExpressionDetector } from './visualExpressionDetector';
import { TemplateEngine } from './templateEngine';
import { getPhrasesPath } from '../utils/paths';

export interface PhraseRecord {
  phrase: string;
  normalized: string;
  category: string;
  language: string;
  confidence: number;
  hitCount: number;
  status: 'candidate' | 'stable';
  lastHit: string;
  source: 'manual' | 'rule' | 'ai_learned';
  replyTemplates?: string[];
}

export interface ClassificationResult {
  category: string;
  language: 'zh' | 'en' | 'ja' | 'other';
  confidence: number;
  replySource: 'LOCAL_RULE' | 'LOCAL_PHRASE' | 'LOCAL_TEMPLATE' | 'DEEPSEEK' | 'NONE';
  reply: string;
  isSpam: boolean;
  isVisualExpression?: boolean;
  visualSubtype?: string;
}

export class LocalClassifier {
  private phrases: PhraseRecord[] = [];
  private templateEngine: TemplateEngine;

  constructor(templateEngine?: TemplateEngine, phrasesPath?: string) {
    this.templateEngine = templateEngine || new TemplateEngine();
    this.loadPhrases(phrasesPath);
  }

  public loadPhrases(customPath?: string): void {
    const pPath = customPath || getPhrasesPath();
    if (fs.existsSync(pPath)) {
      try {
        this.phrases = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      } catch (e: any) {
        console.warn('[Classifier] Failed to load phrases:', e.message);
      }
    }
  }

  public static detectLanguage(text: string): 'zh' | 'en' | 'ja' | 'other' {
    // Japanese Hiragana & Katakana
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
      return 'ja';
    }
    // Chinese characters (CJK Unified Ideographs)
    if (/[\u4E00-\u9FFF]/.test(text)) {
      return 'zh';
    }
    // English Latin letters
    if (/[a-zA-Z]/.test(text)) {
      return 'en';
    }
    return 'zh'; // default
  }

  public classify(text: string, steamId?: string): ClassificationResult {
    const trimmed = text.trim();
    const language = LocalClassifier.detectLanguage(trimmed);

    // 1. Spam filter check first
    const spamCheck = SpamFilter.evaluate(trimmed);
    if (spamCheck.isSpam) {
      return {
        category: 'spam',
        language,
        confidence: 0.98,
        replySource: 'NONE',
        reply: '',
        isSpam: true
      };
    }

    const lower = trimmed.toLowerCase();

    // 2. Visual Expression / Emoji Pixel Art / Braille / Multi-line Art detection
    const visualResult = VisualExpressionDetector.detect(trimmed);
    const visualSubtypes = [
      'emoji_pixel_art',
      'emoji_art',
      'braille_art',
      'ascii_art',
      'unicode_art',
      'block_art',
      'box_drawing_art',
      'mixed_symbol_art',
      'large_kaomoji',
      'decorative_multiline'
    ];

    if (
      visualResult.isVisualExpression &&
      visualResult.confidence >= 0.90 &&
      !visualResult.hasSignificantNaturalLanguage &&
      visualSubtypes.includes(visualResult.subtype)
    ) {
      const reply = this.templateEngine.getReply(visualResult.subtype, language, steamId);
      return {
        category: visualResult.subtype,
        language,
        confidence: visualResult.confidence,
        replySource: 'LOCAL_RULE',
        reply,
        isSpam: false,
        isVisualExpression: true,
        visualSubtype: visualResult.subtype
      };
    }

    // 3. Phrase Knowledge Base match
    for (const item of this.phrases) {
      if (item.status === 'stable' && lower.includes(item.normalized.toLowerCase())) {
        let reply = '';
        if (item.replyTemplates && item.replyTemplates.length > 0) {
          reply = item.replyTemplates[Math.floor(Math.random() * item.replyTemplates.length)];
        } else {
          reply = this.templateEngine.getReply(item.category, item.language || language, steamId);
        }
        return {
          category: item.category,
          language: (item.language as any) || language,
          confidence: item.confidence || 0.95,
          replySource: 'LOCAL_PHRASE',
          reply,
          isSpam: false
        };
      }
    }

    // 4. Steam Emoticons, Single-line Kaomoji, Emojis, and fallbacks
    if (!visualResult.hasSignificantNaturalLanguage) {
      const artEval = AsciiArtDetector.evaluate(trimmed);
      if (artEval.kind !== 'none') {
        const reply = this.templateEngine.getReply(artEval.kind, language, steamId);
        return {
          category: artEval.kind,
          language,
          confidence: artEval.confidence,
          replySource: 'LOCAL_RULE',
          reply,
          isSpam: false,
          isVisualExpression: true,
          visualSubtype: artEval.kind
        };
      }
    }

    // 4. Common rule heuristics
    // +rep
    if (/\+rep\b|\brep\+/i.test(lower)) {
      return {
        category: 'rep',
        language,
        confidence: 0.98,
        replySource: 'LOCAL_RULE',
        reply: this.templateEngine.getReply('rep', language, steamId),
        isSpam: false
      };
    }

    // Warm social /踩 /脚印 /互暖
    if (/互暖|互踩|来踩|踩踩|暖暖|留个?脚印|来逛逛|路过|来看看|踩一下|回踩/i.test(trimmed)) {
      return {
        category: 'warm_social',
        language,
        confidence: 0.97,
        replySource: 'LOCAL_RULE',
        reply: this.templateEngine.getReply('warm_social', language, steamId),
        isSpam: false
      };
    }

    // Greetings
    if (
      /^(hi|hello|hey|yo|good\s*(morning|night|afternoon|day)|greetings)\b/i.test(lower) ||
      /^(你好|嗨|哈喽|早上好|早安|晚安|午好|嗨嗨|嗨喽|打扰了|早|晚)(呀|啊|啦|哇|哦|呢|滴)?[!！~～\s]*$/i.test(trimmed) ||
      /^(こんにちは|おはよう(ございます)?|こんばんは|やっほー)[!！~～\s]*$/i.test(trimmed)
    ) {
      return {
        category: 'greeting',
        language,
        confidence: 0.96,
        replySource: 'LOCAL_RULE',
        reply: this.templateEngine.getReply('greeting', language, steamId),
        isSpam: false
      };
    }

    // Compliment
    if (
      /nice\s*(profile|artwork|background|showcase)|cute|cool|awesome|pretty|beautiful/i.test(lower) ||
      /好看|好可爱|好帅|漂亮|精致|太赞了|赞赞|好耶|爱了/i.test(trimmed) ||
      /可愛い|かっこいい|すてき|綺麗/i.test(trimmed)
    ) {
      return {
        category: 'compliment',
        language,
        confidence: 0.95,
        replySource: 'LOCAL_RULE',
        reply: this.templateEngine.getReply('compliment', language, steamId),
        isSpam: false
      };
    }

    // Short friendly words
    if (trimmed.length <= 6 && /^[a-zA-Z\u4E00-\u9FA5\s!~.]+$/.test(trimmed)) {
      if (/赞|好|耶|棒|强|666|牛|nice|good/i.test(trimmed)) {
        return {
          category: 'short_positive',
          language,
          confidence: 0.90,
          replySource: 'LOCAL_RULE',
          reply: this.templateEngine.getReply('short_positive', language, steamId),
          isSpam: false
        };
      }
    }

    // Unmatched: Needs DeepSeek AI
    return {
      category: 'unknown',
      language,
      confidence: 0,
      replySource: 'DEEPSEEK',
      reply: '',
      isSpam: false
    };
  }
}
