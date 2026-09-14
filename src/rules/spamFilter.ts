export interface SpamEvaluationResult {
  isSpam: boolean;
  score: number;
  reasons: string[];
}

export class SpamFilter {
  // Hard spam keywords (immediate high weight)
  private static HARD_SPAM_PATTERNS = [
    /free\s*skins?/i,
    /cheap\s*skins?/i,
    /free\s*knife/i,
    /claim\s*skins?/i,
    /giveaway/i,
    /csgo\s*skins?/i,
    /cs2\s*skins?/i,
    /promo\s*code/i,
    /promo\s*code\s*[:=]/i,
    /withdraw\s*free/i,
    /steamcommunity\.com\/tradeoffer\/new\/\?partner=/i, // unsolicited trade offer
    /t\.me\//i,
    /telegram/i,
    /discord\.gg\/[a-zA-Z0-9_-]+/i,
    /join\s*my\s*discord/i,
    /join\s*our\s*discord/i,
    /加\s*[qQ群]/i,
    /加\s*微信/i,
    /免费领取/i,
    /免费送/i,
    /高价回收/i,
    /包赔/i,
    /博彩/i,
    /外围/i,
    /发牌/i,
    /菠菜/i,
    /挂机刷/i,
    /兼职/i,
    /日赚/i,
    /出\s*刀/i,
    /收\s*刀/i,
    /带单/i,
    /投资/i,
    /返现/i
  ];

  // Mild suspicious keywords (needs combination with URLs or other signals)
  private static MILD_SUSPICIOUS_PATTERNS = [
    /https?:\/\//i,
    /www\./i,
    /\.com\b/i,
    /\.ru\b/i,
    /\.gg\b/i,
    /\.top\b/i,
    /\.xyz\b/i,
    /\.link\b/i,
    /discord/i,
    /trade/i,
    /bonus/i,
    /code\b/i,
    /win\b/i,
    /click/i,
    /link/i,
    /group/i,
    /community/i,
    /check\s*out/i
  ];

  public static evaluate(text: string): SpamEvaluationResult {
    let score = 0;
    const reasons: string[] = [];
    const normalized = text.toLowerCase();

    // Check hard spam patterns
    for (const pat of this.HARD_SPAM_PATTERNS) {
      if (pat.test(normalized)) {
        score += 60;
        reasons.push(`Hard spam trigger: ${pat.source}`);
      }
    }

    // Check URL presence
    const hasUrl = /https?:\/\/|[a-zA-Z0-9-]+\.(com|ru|gg|top|xyz|club|shop|cc|link|site)/i.test(normalized);
    if (hasUrl) {
      score += 35;
      reasons.push('Contains URL/Domain');
    }

    // Check mild suspicious patterns in combination
    let mildHits = 0;
    for (const pat of this.MILD_SUSPICIOUS_PATTERNS) {
      if (pat.test(normalized)) {
        mildHits++;
      }
    }

    if (mildHits >= 2) {
      score += mildHits * 15;
      reasons.push(`Multiple mild indicators (${mildHits})`);
    }

    // High uppercase ratio in long text
    const cleanLetters = text.replace(/[^a-zA-Z]/g, '');
    if (cleanLetters.length > 20) {
      const upperCount = (text.match(/[A-Z]/g) || []).length;
      if (upperCount / cleanLetters.length > 0.8) {
        score += 20;
        reasons.push('Excessive uppercase text');
      }
    }

    const isSpam = score >= 50;
    return { isSpam, score, reasons };
  }
}
