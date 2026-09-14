export type ArtKind = 'steam_emoticon' | 'kaomoji' | 'emoji' | 'ascii_art' | 'decorative' | 'none';

export interface ArtEvaluation {
  kind: ArtKind;
  confidence: number;
  symbolRatio: number;
  emojiRatio: number;
  lineCount: number;
  detectedSteamEmotes: string[];
}

export class AsciiArtDetector {
  // Steam official emoticon regex: :something:
  private static STEAM_EMOTE_REGEX = /:[a-zA-Z0-9_+-]{2,30}:/g;

  // Unicode Emoji regex
  private static EMOJI_REGEX = /[\p{Extended_Pictographic}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

  // Common Kaomoji facial patterns
  private static KAOMOJI_PATTERNS = [
    /\([^\)]{1,15}\)/, // Parentheses with facial expressions
    /（[^）]{1,15}）/,
    /[◕•｡◕‿◕｡ωฅ=ﾟヮﾟ]/,
    /づ[^\s]+づ/,
    /\(^[\s\S]+\)/
  ];

  // Box drawing, blocks, geometric symbols, and Braille characters
  private static ASCII_BLOCK_REGEX = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2800-\u28FF\u2E80-\u2FD5\u3000-\u303F\uFF00-\uFFEF#*@%~`|/\\_=-]{3,}/;

  public static evaluate(text: string): ArtEvaluation {
    const raw = text.trim();
    if (!raw) {
      return { kind: 'none', confidence: 0, symbolRatio: 0, emojiRatio: 0, lineCount: 0, detectedSteamEmotes: [] };
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    const lineCount = lines.length;

    // 1. Steam Emoticons
    const steamEmotes = raw.match(this.STEAM_EMOTE_REGEX) || [];
    const textWithoutSteamEmotes = raw.replace(this.STEAM_EMOTE_REGEX, '').trim();

    if (steamEmotes.length > 0 && textWithoutSteamEmotes.length < 15) {
      return {
        kind: 'steam_emoticon',
        confidence: 0.98,
        symbolRatio: 1,
        emojiRatio: 0,
        lineCount,
        detectedSteamEmotes: steamEmotes
      };
    }

    // 2. Emoji ratio
    const emojiMatches = raw.match(this.EMOJI_REGEX) || [];
    const emojiCount = emojiMatches.length;
    const totalChars = Array.from(raw.replace(/\s/g, '')).length;
    const emojiRatio = totalChars > 0 ? emojiCount / totalChars : 0;

    if (emojiRatio > 0.6 || (emojiCount >= 3 && totalChars <= 10)) {
      return {
        kind: 'emoji',
        confidence: 0.95,
        symbolRatio: emojiRatio,
        emojiRatio,
        lineCount,
        detectedSteamEmotes: steamEmotes
      };
    }

    // 3. Kaomoji
    const isKaomoji = this.KAOMOJI_PATTERNS.some(pat => pat.test(raw));
    // Check if alphanumeric count is very small
    const alphanumericCount = (raw.match(/[\p{L}\p{N}]/gu) || []).length;
    if (isKaomoji && alphanumericCount <= 8) {
      return {
        kind: 'kaomoji',
        confidence: 0.96,
        symbolRatio: 0.8,
        emojiRatio,
        lineCount,
        detectedSteamEmotes: steamEmotes
      };
    }

    // 4. ASCII Art / Large Symbol / Multi-line Art
    const symbolMatches = raw.match(/[^\p{L}\p{N}\s]/gu) || [];
    const symbolRatio = totalChars > 0 ? symbolMatches.length / totalChars : 0;

    if (lineCount >= 3 || this.ASCII_BLOCK_REGEX.test(raw) || (totalChars > 20 && symbolRatio > 0.65)) {
      return {
        kind: 'ascii_art',
        confidence: 0.94,
        symbolRatio,
        emojiRatio,
        lineCount,
        detectedSteamEmotes: steamEmotes
      };
    }

    // 5. Decorative symbols
    if (symbolRatio > 0.5 && totalChars <= 30) {
      return {
        kind: 'decorative',
        confidence: 0.88,
        symbolRatio,
        emojiRatio,
        lineCount,
        detectedSteamEmotes: steamEmotes
      };
    }

    return {
      kind: 'none',
      confidence: 0,
      symbolRatio,
      emojiRatio,
      lineCount,
      detectedSteamEmotes: steamEmotes
    };
  }
}
