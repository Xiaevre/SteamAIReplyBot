import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/paths';
import { TimeGreeting } from '../reply/timeGreeting';

export interface TemplatesMap {
  [category: string]: {
    [language: string]: string[];
  };
}

export class TemplateEngine {
  private templates: TemplatesMap = {};
  private recentRepliesQueue: string[] = [];
  private userRecentReplies: Map<string, string[]> = new Map();
  private maxHistory = 20;

  constructor(customPath?: string) {
    const tPath = customPath || path.resolve(getDataDir(), 'reply-templates.json');
    if (fs.existsSync(tPath)) {
      try {
        this.templates = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      } catch (e: any) {
        console.warn('[TemplateEngine] Failed to load templates:', e.message);
      }
    }
  }

  /**
   * Generates a natural time-based greeting reply with an optional nickname.
   */
  public getTimeGreetingReply(nickname?: string | null, date: Date = new Date(), steamId?: string): string {
    const period = TimeGreeting.getTimePeriod(date);
    const variants = TimeGreeting.getVariants(period);

    // Filter out recently used global replies
    let candidates = variants.filter(t => !this.recentRepliesQueue.includes(t));
    if (candidates.length === 0) {
      candidates = variants;
    }

    // Filter out recently used replies for this user
    if (steamId && this.userRecentReplies.has(steamId)) {
      const userHistory = this.userRecentReplies.get(steamId)!;
      const userFiltered = candidates.filter(t => !userHistory.includes(t));
      if (userFiltered.length > 0) {
        candidates = userFiltered;
      }
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    this.recordUsage(chosen, steamId);

    return TimeGreeting.format(chosen, nickname);
  }

  public getReply(category: string, lang: string, steamId?: string): string {
    const catTemplates =
      this.templates[category] ||
      this.templates['visual_expression'] ||
      this.templates['ascii_art'] ||
      this.templates['warm_social'] ||
      {};
    const langTemplates = catTemplates[lang] || catTemplates['zh'] || catTemplates['en'] || [];

    if (!langTemplates || langTemplates.length === 0) {
      return '✨ 感谢来踩！祝游戏愉快～';
    }

    // Filter out recently used global replies
    let candidates = langTemplates.filter(t => !this.recentRepliesQueue.includes(t));
    if (candidates.length === 0) {
      candidates = langTemplates;
    }

    // Filter out recently used replies for this user
    if (steamId && this.userRecentReplies.has(steamId)) {
      const userHistory = this.userRecentReplies.get(steamId)!;
      const userFiltered = candidates.filter(t => !userHistory.includes(t));
      if (userFiltered.length > 0) {
        candidates = userFiltered;
      }
    }

    // Random choice
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];

    // Record history
    this.recordUsage(chosen, steamId);
    return chosen;
  }

  private recordUsage(reply: string, steamId?: string): void {
    this.recentRepliesQueue.push(reply);
    if (this.recentRepliesQueue.length > this.maxHistory) {
      this.recentRepliesQueue.shift();
    }

    if (steamId) {
      if (!this.userRecentReplies.has(steamId)) {
        this.userRecentReplies.set(steamId, []);
      }
      const list = this.userRecentReplies.get(steamId)!;
      list.push(reply);
      if (list.length > 5) {
        list.shift();
      }
    }
  }
}
