import { NicknameMemoryRepository } from '../db/repositories/nicknameMemory';

export interface NicknameResolveOptions {
  steamId?: string;
  originalName?: string;
}

/**
 * NicknameResolver: Pure local resolver for generating safe, natural nicknames.
 *
 * Rules & Principles:
 * 1. Nickname is completely optional. Returns null when uncertain.
 * 2. Never generates awkward or forced nicknames (no indiscriminate "酱" appending).
 * 3. Never throws exceptions (safe fallback to null).
 * 4. Pure local rules, 0 AI calls.
 * 5. Leverages local NicknameMemoryRepository if available.
 */
export class NicknameResolver {
  constructor(private memoryRepo?: NicknameMemoryRepository) {}

  /**
   * Safe wrapper that never throws. Returns string or null.
   */
  public resolveSafe(steamId?: string, originalName?: string): string | null {
    try {
      return this.resolve(steamId, originalName);
    } catch {
      return null;
    }
  }

  /**
   * Resolves a natural nickname for the given Steam user.
   */
  public resolve(steamId?: string, originalName?: string): string | null {
    if (!originalName || typeof originalName !== 'string') {
      return null;
    }

    // 1. Check local memory first if steamId is provided
    if (steamId && this.memoryRepo) {
      try {
        const memory = this.memoryRepo.findBySteamId(steamId);
        if (memory && memory.preferred_name && memory.preferred_name.trim()) {
          return memory.preferred_name.trim();
        }
      } catch {
        // Silently ignore db lookup failure
      }
    }

    // 2. Pre-clean & sanitize raw nickname
    const cleaned = this.sanitize(originalName);
    if (!cleaned) {
      return null;
    }

    // 3. Safety validation: reject ads, urls, pure numbers, pure symbols, garbled text
    if (!this.isSafeName(cleaned, originalName)) {
      return null;
    }

    // 4. Resolve via local rule heuristics
    const resolved = this.extractNaturalNickname(cleaned);
    if (!resolved) {
      return null;
    }

    // 5. Store safe result in memory for future fast lookup
    if (steamId && this.memoryRepo) {
      try {
        this.memoryRepo.save({
          steamId,
          originalName,
          preferredName: resolved,
          source: 'local_rule',
          confidence: 0.9
        });
      } catch {
        // Silently ignore save failure
      }
    }

    return resolved;
  }

  /**
   * Sanitize decorative symbols and outer wrappers.
   */
  private sanitize(name: string): string {
    let s = name.trim();

    // Strip outer paired brackets: 【...】, [...], (...), （...）, 『...』, 「...」, 《...》
    const bracketPairs: [string, string][] = [
      ['【', '】'],
      ['[', ']'],
      ['(', ')'],
      ['（', '）'],
      ['『', '』'],
      ['「', '」'],
      ['《', '》'],
      ['{', '}'],
      ['<', '>']
    ];

    for (const [open, close] of bracketPairs) {
      if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
        s = s.slice(open.length, s.length - close.length).trim();
      }
    }

    // Strip leading and trailing decorative stars, sparkles, dots, dashes
    s = s.replace(/^[\s★☆✦✧✿❀🐾~～\-=_+`·•|/\\^]+/g, '');
    s = s.replace(/[\s★☆✦✧✿❀🐾~～\-=_+`·•|/\\^]+$/g, '');

    return s.trim();
  }

  /**
   * Validate safety: exclude spam, ads, URLs, garbled strings, pure symbols, or noisy strings.
   */
  private isSafeName(cleaned: string, original: string): boolean {
    if (!cleaned || cleaned.length === 0 || cleaned.length > 20) {
      return false;
    }

    // Must contain at least one CJK character, Kana, or Latin letter
    const hasValidLetters = /[\u4E00-\u9FA5\u3040-\u309F\u30A0-\u30FFa-zA-Z]/.test(cleaned);
    if (!hasValidLetters) {
      return false;
    }

    // Exclude pure numbers or dates (e.g. "12345678", "20240912")
    if (/^\d+$/.test(cleaned)) {
      return false;
    }

    // Exclude URLs, domain suffixes, or contact/ad indicators
    const adPattern = /(https?:\/\/|\.com|\.cn|\.net|\.org|\.tv|\.top|\.xyz|\.vip|t\.me|vx:|v:|微信|qq:|加v|淘)/i;
    if (adPattern.test(cleaned) || adPattern.test(original)) {
      return false;
    }

    // Exclude replacement characters or unprintable controls
    if (/\ufffd|[\u0000-\u001f]/.test(cleaned) || /\ufffd|[\u0000-\u001f]/.test(original)) {
      return false;
    }

    // Check symbol / noise ratio in original string: if symbols exceed 40%, reject
    const validCharsCount = (original.match(/[\u4E00-\u9FA5\u3040-\u309F\u30A0-\u30FFa-zA-Z0-9]/g) || []).length;
    if (validCharsCount / original.length < 0.5 && original.length > 5) {
      return false;
    }

    return true;
  }

  /**
   * Extract natural, short nickname from cleaned name.
   */
  private extractNaturalNickname(name: string): string | null {
    // 1. Pattern: Starts with "小" + 1~2 CJK characters (e.g. "小鱼", "小明", "小叮当")
    if (/^小[\u4E00-\u9FA5]{1,2}$/.test(name)) {
      return name;
    }

    // 2. Pattern: Starts with "阿" + 1~2 CJK characters (e.g. "阿伟", "阿强")
    if (/^阿[\u4E00-\u9FA5]{1,2}$/.test(name)) {
      return name;
    }

    // 3. Pattern: Suffix titles (XX酱, XX子, XX君, XX老师, XX喵, XX猫, XX哥, XX姐)
    // Preceded by 1~3 CJK characters (e.g. "樱花酱", "惠子", "风君", "王老师", "白猫", "大白喵")
    const suffixMatch = name.match(/^([\u4E00-\u9FA5]{1,3})(酱|子|君|老师|喵|猫|哥|姐)$/);
    if (suffixMatch) {
      return name;
    }

    // 4. Pattern: Clean Latin / English / Romaji single-word names (e.g. "Miku", "Alice", "Kuro")
    if (/^[A-Za-z][a-z0-9]{1,10}$/i.test(name)) {
      // Avoid random hex or machine-like strings (e.g. "abc12345", "user999")
      if (/^[a-f0-9]{6,}$/i.test(name) || /^user\d+/i.test(name)) {
        return null;
      }
      return name;
    }

    // 5. Pattern: Japanese Hiragana / Katakana short names (2~4 characters, e.g. "ミク", "サクラ")
    if (/^[\u3040-\u309F]{2,4}$/.test(name) || /^[\u30A0-\u30FF]{2,4}$/.test(name)) {
      return name;
    }

    // 6. Pattern: Pure CJK names (2, 3, or 4 characters)
    if (/^[\u4E00-\u9FA5]{2,4}$/.test(name)) {
      // 2 characters (e.g. "小鱼", "阿伟", "晴天", "星河", "白猫"): keep as-is
      if (name.length === 2) {
        return name;
      }

      // 3 characters (e.g. "猫羽雫"): shorten to "小雫" or last char
      if (name.length === 3) {
        const lastChar = name.slice(-1);
        return `小${lastChar}`;
      }

      // 4 characters (e.g. "凤梨罐头"): extract first 2-character word "凤梨"
      if (name.length === 4) {
        return name.slice(0, 2);
      }
    }

    return null;
  }
}
