export type VisualArtSubtype =
  | 'emoji_pixel_art'
  | 'emoji_art'
  | 'braille_art'
  | 'ascii_art'
  | 'unicode_art'
  | 'block_art'
  | 'box_drawing_art'
  | 'mixed_symbol_art'
  | 'large_kaomoji'
  | 'decorative_multiline'
  | 'mixed_expression'
  | 'none';

export interface VisualExpressionMetrics {
  visualDensity: number;
  lineCount: number;
  averageLineLength: number;
  lineLengthVariance: number;
  symbolDensity: number;
  emojiDensity: number;
  brailleDensity: number;
  blockElementDensity: number;
  boxDrawingDensity: number;
  geometricSymbolDensity: number;
  alphanumericRatio: number;
  naturalLanguageWordCount: number;
  layoutConsistencyScore: number;
  artScore: number;
}

export interface VisualExpressionResult {
  isVisualExpression: boolean;
  subtype: VisualArtSubtype;
  confidence: number;
  hasSignificantNaturalLanguage: boolean;
  naturalLanguageSnippet?: string;
  metrics: VisualExpressionMetrics;
}

export class VisualExpressionDetector {
  // Emoji Color Blocks: Large colored squares, medium/small squares
  private static EMOJI_COLOR_BLOCK_REGEX = /^[\u{1F7E0}-\u{1F7EB}\u2B1B\u2B1C\u25FC-\u25FE\u25AA\u25AB]$/u;

  // Unicode Braille range: U+2800 ~ U+28FF
  private static BRAILLE_REGEX = /^[\u2800-\u28FF]$/;

  // Block Elements range: U+2580 ~ U+259F
  private static BLOCK_ELEMENT_REGEX = /^[\u2580-\u259F]$/;

  // Box Drawing range: U+2500 ~ U+257F
  private static BOX_DRAWING_REGEX = /^[\u2500-\u257F]$/;

  // Geometric & Miscellaneous Symbols: U+25A0~U+25FF, U+2600~U+26FF, U+2700~U+27BF, U+2190~U+21FF
  private static GEOMETRIC_REGEX = /^[\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2190-\u21FF]$/;

  // Visual ASCII layout characters
  private static VISUAL_ASCII_REGEX = /^[#*@%~`|/\\_=\-+^$><:.;!]$/;

  // Extended Pictographic / Emoji regex
  private static GENERAL_EMOJI_REGEX = /^\p{Extended_Pictographic}$/u;

  // Unicode Invisible Layout Fillers / Spacing:
  // Hangul Filler U+3164, Braille blank U+2800, Zero Width Space U+200B, Word Joiner U+2060, etc.
  private static UNICODE_LAYOUT_FILLER_REGEX = /^[\u3164\u2800\u200B-\u200F\u2060\uFEFF]$/;

  // Variation Selectors (e.g. VS16 U+FE0F for emoji presentation)
  private static VARIATION_SELECTOR_REGEX = /^[\uFE00-\uFE0F]$/;

  // Chinese & Japanese ideographs / kana
  private static CJK_REGEX = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/;

  // Kaomoji common patterns
  private static KAOMOJI_PATTERNS = [
    /\([^\)]{1,15}\)/,
    /（[^）]{1,15}）/,
    /[◕•｡◕‿◕｡ωฅ=ﾟヮﾟ]/,
    /づ[^\s]+づ/
  ];

  public static detect(text: string): VisualExpressionResult {
    const raw = text ? text.trim() : '';
    if (!raw) {
      return {
        isVisualExpression: false,
        subtype: 'none',
        confidence: 0,
        hasSignificantNaturalLanguage: false,
        metrics: this.createEmptyMetrics()
      };
    }

    const rawLines = raw.split(/\r?\n/);
    const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);
    const lineCount = lines.length;

    // Grapheme / codepoint array of non-whitespace characters
    // Exclude standard whitespace, unicode layout fillers (e.g. U+3164 Hangul Filler, U+2800 Braille Blank, ZWSP),
    // and Variation Selectors (U+FE00-U+FE0F, such as U+FE0F VS16 on emoji blocks)
    const normalizedRaw = raw
      .replace(/[\s\u3164\u2800\u200B-\u200F\u2060\uFEFF]/g, '')
      .replace(/[\uFE00-\uFE0F]/g, '');
    const allChars = Array.from(normalizedRaw);
    const totalChars = allChars.length;

    if (totalChars === 0) {
      return {
        isVisualExpression: false,
        subtype: 'none',
        confidence: 0,
        hasSignificantNaturalLanguage: false,
        metrics: this.createEmptyMetrics()
      };
    }

    // Counters for character types
    let emojiColorBlockCount = 0;
    let emojiCount = 0;
    let brailleCount = 0;
    let blockElementCount = 0;
    let boxDrawingCount = 0;
    let geometricCount = 0;
    let visualAsciiCount = 0;
    let alphanumericCount = 0;
    let otherSymbolCount = 0;

    for (const char of allChars) {
      if (this.EMOJI_COLOR_BLOCK_REGEX.test(char)) {
        emojiColorBlockCount++;
        emojiCount++;
      } else if (this.BRAILLE_REGEX.test(char)) {
        brailleCount++;
      } else if (this.BLOCK_ELEMENT_REGEX.test(char)) {
        blockElementCount++;
      } else if (this.BOX_DRAWING_REGEX.test(char)) {
        boxDrawingCount++;
      } else if (this.GEOMETRIC_REGEX.test(char)) {
        geometricCount++;
      } else if (this.GENERAL_EMOJI_REGEX.test(char)) {
        emojiCount++;
      } else if (this.VISUAL_ASCII_REGEX.test(char)) {
        visualAsciiCount++;
      } else if (/^[a-zA-Z0-9]$/.test(char)) {
        alphanumericCount++;
      } else if (!this.CJK_REGEX.test(char)) {
        otherSymbolCount++;
      }
    }

    // Line length statistics
    const lineLengths = lines.map(line => Array.from(line.replace(/\s+/g, ' ')).length);
    const averageLineLength = lineLengths.reduce((a, b) => a + b, 0) / (lineCount || 1);
    const lineLengthVariance =
      lineLengths.reduce((acc, len) => acc + Math.pow(len - averageLineLength, 2), 0) / (lineCount || 1);
    const stdDev = Math.sqrt(lineLengthVariance);

    // Natural language analysis
    const cjkChars = (raw.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const latinWords = (raw.match(/\b[a-zA-Z]{2,}\b/g) || []).filter(
      w => !['rep', 'gg', 'wp', 'gl', 'hf', 'thx', 'ty', 'xd'].includes(w.toLowerCase())
    );
    const naturalLanguageWordCount = cjkChars + latinWords.length;

    // Meaningful natural language snippet
    const nlLines = lines.filter(l => this.CJK_REGEX.test(l) || /\b[a-zA-Z]{3,}\b/.test(l));
    const naturalLanguageSnippet = nlLines.length > 0 ? nlLines.join(' ') : undefined;

    // Significant natural language threshold: e.g. "这也太可爱了" (6 chars) or 3+ words
    const hasSignificantNaturalLanguage = naturalLanguageWordCount >= 4 || cjkChars >= 3;

    // Densities
    const symbolCount =
      brailleCount + blockElementCount + boxDrawingCount + geometricCount + visualAsciiCount + otherSymbolCount;
    const visualCharCount =
      emojiCount + brailleCount + blockElementCount + boxDrawingCount + geometricCount + visualAsciiCount;

    const visualDensity = totalChars > 0 ? visualCharCount / totalChars : 0;
    const symbolDensity = totalChars > 0 ? symbolCount / totalChars : 0;
    const emojiDensity = totalChars > 0 ? emojiCount / totalChars : 0;
    const brailleDensity = totalChars > 0 ? brailleCount / totalChars : 0;
    const blockElementDensity = totalChars > 0 ? blockElementCount / totalChars : 0;
    const boxDrawingDensity = totalChars > 0 ? boxDrawingCount / totalChars : 0;
    const geometricSymbolDensity = totalChars > 0 ? geometricCount / totalChars : 0;
    const alphanumericRatio = totalChars > 0 ? alphanumericCount / totalChars : 0;

    // Layout consistency evaluation
    let layoutConsistencyScore = 0;
    if (lineCount >= 3) {
      if (stdDev <= 1.2) {
        layoutConsistencyScore = 0.98;
      } else if (stdDev <= 2.5) {
        layoutConsistencyScore = 0.92;
      } else if (stdDev <= 4.5) {
        layoutConsistencyScore = 0.82;
      } else if (stdDev <= 7.0) {
        layoutConsistencyScore = 0.65;
      } else {
        layoutConsistencyScore = 0.40;
      }

      if (lineCount >= 4) {
        layoutConsistencyScore = Math.min(1.0, layoutConsistencyScore + 0.05);
      }
    } else if (lineCount === 2) {
      layoutConsistencyScore = stdDev <= 1.5 ? 0.75 : 0.45;
    } else {
      layoutConsistencyScore = 0.20;
    }

    // Composite Art Score
    let artScore = 0;
    if (lineCount >= 3) {
      artScore = visualDensity * 0.45 + layoutConsistencyScore * 0.35 + (Math.min(lineCount, 8) / 8) * 0.2;
      if (alphanumericRatio > 0.2) {
        artScore -= alphanumericRatio * 0.3;
      }
    } else {
      artScore = visualDensity * 0.5 + (Math.min(visualCharCount, 20) / 20) * 0.5;
    }
    artScore = Math.max(0, Math.min(1, Math.round(artScore * 100) / 100));

    // Subtype Identification
    let subtype: VisualArtSubtype = 'none';

    const visualCategoriesCount = [
      emojiCount > 0,
      brailleCount > 0,
      blockElementCount > 0,
      boxDrawingCount > 0,
      geometricCount > 0
    ].filter(Boolean).length;

    // 1. Mixed Symbol Art (e.g. Braille + Emoji + Block Element + Box)
    if (lineCount >= 3 && visualDensity >= 0.65 && visualCategoriesCount >= 2) {
      // If one type is overwhelming (e.g. 95% braille and 1 dot), keep specific type
      const maxSingleDensity = Math.max(
        brailleDensity,
        emojiDensity,
        blockElementDensity,
        boxDrawingDensity,
        geometricSymbolDensity
      );
      if (maxSingleDensity >= 0.85) {
        if (brailleDensity >= 0.85) subtype = 'braille_art';
        else if (emojiColorBlockCount >= 6) subtype = 'emoji_pixel_art';
        else if (blockElementDensity >= 0.85) subtype = 'block_art';
        else if (boxDrawingDensity >= 0.85) subtype = 'box_drawing_art';
        else subtype = 'mixed_symbol_art';
      } else {
        subtype = 'mixed_symbol_art';
      }
    }
    // 2. Braille Art
    else if (brailleDensity >= 0.35 || brailleCount >= 8) {
      subtype = 'braille_art';
    }
    // 3. Emoji Pixel Art (Color Blocks)
    // Either multi-line layout (lineCount >= 3) OR dense color block collection (emojiColorBlockCount >= 6) with no significant natural language
    else if (
      (emojiColorBlockCount >= 6 && lineCount >= 3) ||
      (emojiColorBlockCount >= 8 && naturalLanguageWordCount <= 1) ||
      (emojiColorBlockCount >= 6 && naturalLanguageWordCount === 0 && (totalChars <= emojiColorBlockCount * 1.5 || emojiDensity >= 0.7))
    ) {
      subtype = 'emoji_pixel_art';
    }
    // 4. Block Element Art
    else if (blockElementDensity >= 0.35 || (blockElementCount >= 6 && lineCount >= 3)) {
      subtype = 'block_art';
    }
    // 5. Box Drawing Art
    else if (boxDrawingDensity >= 0.2 || (boxDrawingCount >= 4 && lineCount >= 3)) {
      subtype = 'box_drawing_art';
    }
    // 6. Unicode Geometric Art
    else if (geometricSymbolDensity >= 0.35 && lineCount >= 3) {
      subtype = 'unicode_art';
    }
    // 7. General Emoji Art
    else if (emojiDensity >= 0.5 && lineCount >= 3) {
      subtype = 'emoji_art';
    }
    // 8. Traditional ASCII Art
    else if (visualAsciiCount >= 10 && lineCount >= 3 && visualDensity >= 0.65) {
      subtype = 'ascii_art';
    }
    // 9. Large Kaomoji (multi-line large expressions)
    else if (
      lineCount >= 2 &&
      this.KAOMOJI_PATTERNS.some(pat => pat.test(raw)) &&
      symbolDensity >= 0.55 &&
      naturalLanguageWordCount <= 2
    ) {
      subtype = 'large_kaomoji';
    }
    // 10. Decorative Multiline
    else if (lineCount >= 2 && visualDensity >= 0.65 && totalChars >= 12) {
      subtype = 'decorative_multiline';
    }
    // 11. Single-line or low-structure mixed expression
    else if (emojiDensity >= 0.6 || (totalChars <= 15 && emojiCount >= 3)) {
      subtype = 'mixed_expression';
    }

    // Confidence Calculation
    let confidence = 0;
    if (subtype === 'emoji_pixel_art') {
      if (lineCount >= 3 && emojiColorBlockCount >= 6) {
        confidence = 0.99;
      } else if (emojiColorBlockCount >= 12 && naturalLanguageWordCount === 0) {
        confidence = 0.99;
      } else if (emojiColorBlockCount >= 6 && naturalLanguageWordCount === 0) {
        confidence = 0.96;
      } else {
        confidence = 0.92;
      }
    } else if (subtype === 'braille_art' && (brailleCount >= 8 || brailleDensity >= 0.6)) {
      confidence = 0.98;
    } else if (subtype === 'block_art' && lineCount >= 3 && blockElementDensity >= 0.4) {
      confidence = 0.98;
    } else if (subtype === 'box_drawing_art' && lineCount >= 3 && boxDrawingCount >= 4) {
      confidence = 0.96;
    } else if (subtype === 'mixed_symbol_art' && lineCount >= 3 && visualDensity >= 0.7) {
      confidence = 0.97;
    } else if (subtype === 'unicode_art' && lineCount >= 3 && visualDensity >= 0.7) {
      confidence = 0.95;
    } else if (subtype === 'emoji_art' && lineCount >= 3 && emojiDensity >= 0.6) {
      confidence = 0.95;
    } else if (subtype === 'ascii_art' && lineCount >= 3 && visualDensity >= 0.7) {
      confidence = 0.95;
    } else if (subtype === 'decorative_multiline' && lineCount >= 3 && visualDensity >= 0.7) {
      confidence = 0.92;
    } else if (subtype === 'large_kaomoji') {
      confidence = 0.92;
    } else if (subtype === 'mixed_expression') {
      confidence = 0.75;
    }

    // Boost confidence if layout consistency and visual density are both extremely high
    if (confidence >= 0.9 && layoutConsistencyScore >= 0.9 && visualDensity >= 0.85) {
      confidence = Math.min(0.99, confidence + 0.02);
    }

    // Critical Separation Rule: Normal Language + Art
    // If the comment has significant natural language, it MUST NOT be classified as pure visual expression.
    let isVisualExpression = false;
    if (hasSignificantNaturalLanguage) {
      isVisualExpression = false;
      confidence = Math.min(confidence, 0.7); // Downgrade confidence below 0.90
    } else if (confidence >= 0.9 && subtype !== 'none' && subtype !== 'mixed_expression') {
      isVisualExpression = true;
    }

    const metrics: VisualExpressionMetrics = {
      visualDensity: Math.round(visualDensity * 100) / 100,
      lineCount,
      averageLineLength: Math.round(averageLineLength * 100) / 100,
      lineLengthVariance: Math.round(lineLengthVariance * 100) / 100,
      symbolDensity: Math.round(symbolDensity * 100) / 100,
      emojiDensity: Math.round(emojiDensity * 100) / 100,
      brailleDensity: Math.round(brailleDensity * 100) / 100,
      blockElementDensity: Math.round(blockElementDensity * 100) / 100,
      boxDrawingDensity: Math.round(boxDrawingDensity * 100) / 100,
      geometricSymbolDensity: Math.round(geometricSymbolDensity * 100) / 100,
      alphanumericRatio: Math.round(alphanumericRatio * 100) / 100,
      naturalLanguageWordCount,
      layoutConsistencyScore: Math.round(layoutConsistencyScore * 100) / 100,
      artScore
    };

    return {
      isVisualExpression,
      subtype,
      confidence: Math.round(confidence * 100) / 100,
      hasSignificantNaturalLanguage,
      naturalLanguageSnippet,
      metrics
    };
  }

  private static createEmptyMetrics(): VisualExpressionMetrics {
    return {
      visualDensity: 0,
      lineCount: 0,
      averageLineLength: 0,
      lineLengthVariance: 0,
      symbolDensity: 0,
      emojiDensity: 0,
      brailleDensity: 0,
      blockElementDensity: 0,
      boxDrawingDensity: 0,
      geometricSymbolDensity: 0,
      alphanumericRatio: 0,
      naturalLanguageWordCount: 0,
      layoutConsistencyScore: 0,
      artScore: 0
    };
  }
}
