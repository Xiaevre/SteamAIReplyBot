import { VisualExpressionDetector, VisualExpressionResult, VisualArtSubtype } from '../rules/visualExpressionDetector';

/**
 * VisualReplyGenerator: Implements visual expression mirroring & dynamic imitation
 * for Steam comments without calling external AI.
 */
export class VisualReplyGenerator {
  /**
   * Main entry point for visual reply generation.
   * Analyzes the incoming visual content and generates a stylistically matched response.
   * If imitation is not possible or fails, safely returns fallbackReply.
   */
  public static generate(
    content: string,
    visualResult?: VisualExpressionResult,
    fallbackReply: string = ''
  ): string {
    const text = (content || '').trim();
    if (!text) return fallbackReply;

    try {
      const vr = visualResult || VisualExpressionDetector.detect(text);
      const subtype = vr.subtype;

      // 1. Emoji Pixel Art / Emoji Art: Mirror dominant emoji or colors with a reactive micro-pattern
      if (subtype === 'emoji_pixel_art' || subtype === 'emoji_art') {
        const mirroredEmoji = this.imitateEmojiPixelArt(text);
        if (mirroredEmoji) return mirroredEmoji;
      }

      // 2. ASCII / Unicode / Block / Braille Art: Mirror style with safe-length ASCII response
      if (
        subtype === 'ascii_art' ||
        subtype === 'block_art' ||
        subtype === 'box_drawing_art' ||
        subtype === 'braille_art' ||
        subtype === 'unicode_art' ||
        subtype === 'mixed_symbol_art'
      ) {
        const mirroredAscii = this.imitateAsciiArt(text, subtype);
        if (mirroredAscii) return mirroredAscii;
      }

      // 3. Simple Emoji sequence (1-6 emojis): Match emotion & respond
      const pureEmojiReply = this.imitateSimpleEmoji(text);
      if (pureEmojiReply) {
        return pureEmojiReply;
      }

      // 4. Kaomoji / Facial Expression: Emotion mirroring
      if (subtype === 'large_kaomoji' || this.isKaomoji(text)) {
        const mirroredKaomoji = this.imitateKaomoji(text);
        if (mirroredKaomoji) return mirroredKaomoji;
      }

      // Fallback to original template reply if imitation didn't produce a specialized response
      return fallbackReply || '✨ (o´ω`o)ﾉ ✨';
    } catch {
      return fallbackReply;
    }
  }

  /**
   * Priority 1: Emoji Pixel Art imitation.
   * Extracts dominant emojis/colors from opponent's art and creates a corresponding mini badge or heart.
   */
  private static imitateEmojiPixelArt(content: string): string | null {
    // Extract all emojis
    const emojiMatches = content.match(/\p{Extended_Pictographic}/gu);
    if (!emojiMatches || emojiMatches.length === 0) return null;

    // Count frequency to find dominant emoji and secondary emoji
    const freqMap: { [e: string]: number } = {};
    for (const e of emojiMatches) {
      freqMap[e] = (freqMap[e] || 0) + 1;
    }

    const sortedEmojis = Object.keys(freqMap).sort((a, b) => freqMap[b] - freqMap[a]);
    const primary = sortedEmojis[0] || '🟦';
    const secondary = sortedEmojis.length > 1 ? sortedEmojis[1] : '⬜';

    // Generates a compact 5x5 mirrored pixel heart using opponent's primary & secondary emojis
    // Format:
    // [sec][prim][sec][prim][sec]
    // [prim][prim][prim][prim][prim]
    // [sec][prim][prim][prim][sec]
    // [sec][sec][prim][sec][sec]
    // [sec][sec][sec][sec][sec]
    const p = primary;
    const s = secondary;

    const pattern = [
      `${s}${p}${s}${p}${s}`,
      `${p}${p}${p}${p}${p}`,
      `${s}${p}${p}${p}${s}`,
      `${s}${s}${p}${s}${s}`
    ].join('\n');

    return pattern;
  }

  /**
   * Priority 2: ASCII / Block / Braille Art imitation.
   * Responds in the same character family while keeping length strictly bounded (< 500 chars).
   */
  private static imitateAsciiArt(content: string, subtype: VisualArtSubtype): string | null {
    // Braille Art (U+2800 ~ U+28FF)
    if (subtype === 'braille_art' || /[\u2800-\u28FF]/.test(content)) {
      return [
        '⢀⡤⣄⡀⠀⠀⠀⠀⣀⣤⡀',
        '⢠⡏⠀⠈⠳⡄⢠⠞⠁⠀⢹⡄',
        '⠘⣇⠀⠀⠀⠹⠏⠀⠀⠀⢸⠃',
        '⠀⠘⢧⡀⠀⠀⠀⠀⠀⡴⠃⠀',
        '⠀⠀⠈⠙⠶⢤⣤⠶⠋⠀⠀⠀'
      ].join('\n');
    }

    // Block Elements (█, ░, ▒, ▓, ▀, ▄)
    if (subtype === 'block_art' || /[\u2580-\u259F]/.test(content)) {
      const hasShade = /[░▒▓]/.test(content);
      if (hasShade) {
        return [
          '░░██░░██░░',
          '░████████░',
          '░░██████░░',
          '░░░░██░░░░'
        ].join('\n');
      }
      return [
        '▄▀▀▀▀▄',
        '█  ▄▄ █',
        '█ ▀▀▀ █',
        ' ▀▄▄▀ '
      ].join('\n');
    }

    // Classic ASCII layout (characters like /, \, |, _, ^, *, etc.)
    return [
      '  /\\_/\\  ',
      ' ( o.o ) ',
      '  > ^ <  '
    ].join('\n');
  }

  /**
   * Priority 3: Simple Emoji sequence imitation.
   * Matches emotion/context and responds with an escalating or harmonious combo.
   */
  private static imitateSimpleEmoji(content: string): string | null {
    const raw = content.trim();
    // Only handle if content is primarily emojis and short (<= 8 emojis, <= 30 code points)
    const emojis = raw.match(/\p{Extended_Pictographic}/gu);
    if (!emojis || emojis.length === 0 || emojis.length > 8) return null;

    // Remove emojis, variation selectors, and whitespace to check remaining non-emoji text
    const nonEmojiRemainder = raw.replace(/\p{Extended_Pictographic}|\p{Emoji_Component}|[\s\uFE00-\uFE0F]/gu, '');
    // If there's non-emoji text, it's not a pure/simple emoji comment
    if (nonEmojiRemainder.length > 4) return null;

    const firstEmoji = emojis[0];

    // Category: Fire / Energy
    if (/[🔥⚡💥🚀✨]/u.test(firstEmoji)) {
      return '⚡🔥✨💪';
    }
    // Category: Love / Hearts / Warmth
    if (/[❤️🧡💛💚💙💜🖤🤍🤎💖💗💓💞💕💌🥰😍]/u.test(firstEmoji)) {
      return '🥰💖✨';
    }
    // Category: Approval / Respect / Thumbs
    if (/[👍👏🤝🙌🫡👑💯⭐]/u.test(firstEmoji)) {
      return '🤝👑✨';
    }
    // Category: Joy / Fun / Laugh
    if (/[😂🤣😄😁🎉🥳🍻]/u.test(firstEmoji)) {
      return '🍻🥳✨';
    }
    // Category: Gaming / Controller / Cool
    if (/[🎮🕹️😎🏆🎲🎯]/u.test(firstEmoji)) {
      return '🎮🏆 GG!';
    }
    // Category: Mystery / Thinking / Cute
    if (/[🤔🧐👀🌸🐱🐈]/u.test(firstEmoji)) {
      return '🌸 (o´ω`o)ﾉ';
    }

    // Echo with sparkle
    return `${emojis.slice(0, 3).join('')} ✨`;
  }

  /**
   * Priority 4: Kaomoji emotion imitation.
   */
  private static imitateKaomoji(content: string): string | null {
    // Hug / Cute / Loving
    if (/づ|♥|❤|◕|‿|｡/.test(content)) {
      return '(づ｡◕‿‿◕｡)づ ✨';
    }
    // Wave / Greeting / Happy
    if (/[ﾉノฅ=ﾟヮﾟ]/.test(content)) {
      return 'ฅ^•ﻌ•^ฅ 🐾';
    }
    // Bow / Polite / Respectful
    if (/[mｍ_＿]/.test(content)) {
      return '( _ _ )* ﾍﾟｺｯ';
    }

    return '(｡♥‿♥｡) ✨';
  }

  private static isKaomoji(text: string): boolean {
    return /\([^\)]{1,15}\)|（[^）]{1,15}）|[◕•｡◕‿◕｡ωฅ=ﾟヮﾟ]|づ[^\s]+づ/.test(text);
  }
}
