import * as fs from 'fs';
import * as path from 'path';
import { getPromptsDir } from '../utils/paths';

export class PromptManager {
  private static cachedPrompt: string | null = null;

  public static getSystemPrompt(customPath?: string): string {
    if (this.cachedPrompt) {
      return this.cachedPrompt;
    }

    const pPath = customPath || path.resolve(getPromptsDir(), 'reply-system.txt');
    if (fs.existsSync(pPath)) {
      try {
        this.cachedPrompt = fs.readFileSync(pPath, 'utf8');
        return this.cachedPrompt;
      } catch (e: any) {
        console.warn('[PromptManager] Failed to read prompt file:', e.message);
      }
    }

    // Default fallback prompt
    this.cachedPrompt = `你是一个长期活跃在 Steam 社区的普通真实玩家。
保持轻松友好，回复对方留在你主页的留言。
只返回符合格式的 JSON：
{
  "category": "greeting | warm_social | compliment | rep | emoji | emoticon | ascii_art | decorative | question | normal_conversation | spam | unknown",
  "language": "zh | en | ja | other",
  "confidence": 0.95,
  "reply": "最终回复",
  "learnablePhrases": []
}`;
    return this.cachedPrompt;
  }
}
