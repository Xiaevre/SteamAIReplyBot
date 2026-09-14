import { VisualExpressionDetector } from '../rules/visualExpressionDetector';
import { SpamFilter } from '../rules/spamFilter';

export type DecisionType = 'visual_expression' | 'spam' | 'normal' | 'unknown';
export type DecisionAction = 'LOCAL_REPLY' | 'SKIP' | 'AI_REPLY' | 'NONE';

export interface ReplyDecisionResult {
  type: DecisionType;
  action: DecisionAction;
  confidence: number;
  reason: string;
}

/**
 * ReplyDecision: First-stage local decision module for incoming Steam comments.
 * Evaluates comment characteristics before delegating to AI or local templates.
 */
export class ReplyDecision {
  public static evaluate(content: string): ReplyDecisionResult {
    const text = (content || '').trim();

    if (!text) {
      return {
        type: 'unknown',
        action: 'NONE',
        confidence: 0,
        reason: 'EMPTY_CONTENT'
      };
    }

    // 1. Check for spam / advertising
    const spamCheck = SpamFilter.evaluate(text);
    if (spamCheck.isSpam) {
      return {
        type: 'spam',
        action: 'SKIP',
        confidence: Math.min(1, spamCheck.score / 100),
        reason: spamCheck.reasons.join(', ') || 'SPAM_FILTER_TRIGGERED'
      };
    }

    // 2. Check for emoji / ASCII art / pixel art / big visual expressions
    const visualCheck = VisualExpressionDetector.detect(text);
    if (visualCheck.isVisualExpression) {
      return {
        type: 'visual_expression',
        action: 'LOCAL_REPLY',
        confidence: visualCheck.confidence,
        reason: visualCheck.subtype || 'VISUAL_EXPRESSION'
      };
    }

    // 3. Check for normal text comments (contains readable words/characters, length >= 2)
    // Chinese/Japanese/English natural text
    const hasNaturalText = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/.test(text);
    if (hasNaturalText && text.length >= 2) {
      return {
        type: 'normal',
        action: 'AI_REPLY',
        confidence: 0.9,
        reason: 'NATURAL_TEXT'
      };
    }

    // 4. Other unclassified / unknown patterns
    return {
      type: 'unknown',
      action: 'NONE',
      confidence: 0.5,
      reason: 'UNRECOGNIZED_PATTERN'
    };
  }
}
