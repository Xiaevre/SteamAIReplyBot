export interface ModerationDetectionResult {
  isModerationPending: boolean;
  confidence: number;
  matchedPattern?: string;
}

export class SteamModerationDetector {
  // Key phrase patterns for Chinese and English Steam automated moderation placeholders
  private static MODERATION_PATTERNS = [
    {
      regex: /此留言正在等待(?:我们|STEAM|Steam)?(?:的)?自动内容检查系统分析/i,
      weight: 0.99,
      id: 'zh_auto_content_check_awaiting'
    },
    {
      regex: /等待(?:我们|STEAM|Steam)?(?:的)?自动内容检查系统/i,
      weight: 0.95,
      id: 'zh_content_check_system'
    },
    {
      regex: /在(?:我们)?证实其内容无害.*留言将暂时隐藏/i,
      weight: 0.99,
      id: 'zh_content_temporarily_hidden'
    },
    {
      regex: /awaiting analysis by our automated content check system/i,
      weight: 0.99,
      id: 'en_awaiting_automated_check'
    },
    {
      regex: /automated content check system/i,
      weight: 0.95,
      id: 'en_content_check_system'
    },
    {
      regex: /until we(?:'ve| have) verified.*(?:temporarily hidden|hidden temporarily)/i,
      weight: 0.98,
      id: 'en_temporarily_hidden'
    },
    {
      regex: /this comment is awaiting analysis/i,
      weight: 0.96,
      id: 'en_awaiting_analysis'
    }
  ];

  public static detect(text: string): ModerationDetectionResult {
    if (!text || typeof text !== 'string') {
      return { isModerationPending: false, confidence: 0 };
    }

    // Normalize: strip HTML tags, entity spaces, and collapse multiple whitespaces/newlines
    const normalized = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized.length === 0) {
      return { isModerationPending: false, confidence: 0 };
    }

    for (const pattern of this.MODERATION_PATTERNS) {
      if (pattern.regex.test(normalized)) {
        return {
          isModerationPending: true,
          confidence: pattern.weight,
          matchedPattern: pattern.id
        };
      }
    }

    // Compound keyword check for fuzzy / slightly altered Steam wording
    const lower = normalized.toLowerCase();
    const hasZhCheck =
      lower.includes('自动内容检查') ||
      (lower.includes('内容检查') && lower.includes('暂时隐藏')) ||
      (lower.includes('留言正在等待') && lower.includes('分析')) ||
      (lower.includes('等待') && lower.includes('内容') && lower.includes('系统分析'));
    const hasEnCheck =
      (lower.includes('content check') || lower.includes('content-check')) &&
      (lower.includes('awaiting') || lower.includes('hidden') || lower.includes('temporarily'));

    if (hasZhCheck || hasEnCheck) {
      return {
        isModerationPending: true,
        confidence: 0.92,
        matchedPattern: hasZhCheck ? 'zh_compound_keyword' : 'en_compound_keyword'
      };
    }

    return {
      isModerationPending: false,
      confidence: 0
    };
  }
}
