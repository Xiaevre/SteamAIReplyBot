import { ReplyDecisionResult } from './replyDecision';
import { VisualExpressionResult } from '../rules/visualExpressionDetector';
import { VisualItemType } from './visualLibrary';

// ============================================================
// Forward-Compatible Extension Interfaces
// ============================================================

/**
 * Persona profile for controlling reply voice, tone, and preferences.
 * Forward-compatible stub for future Persona system.
 */
export interface PersonaProfile {
  name: string;
  tone: 'friendly' | 'playful' | 'polite' | 'cool' | 'scholarly';
  traits: string[];
  preferredMoods: string[];
  avoidMoods: string[];
  preferredReplyLength: 'short' | 'medium' | 'detailed';
  allowEmoji: boolean;
  allowKaomoji: boolean;
  allowVisualReply: boolean;
}

/**
 * Relationship context for adapting replies based on interaction depth.
 * Forward-compatible stub for future Relationship system.
 */
export interface RelationshipContext {
  relationshipLevel: 'stranger' | 'visitor' | 'regular' | 'friend';
  interactionCount: number;
  lastInteractionAt?: string;
  mutualGames?: number;
}

/**
 * Knowledge context for augmenting replies with custom game/user context.
 * Forward-compatible stub for future Knowledge / RAG system.
 */
export interface KnowledgeContext {
  matchedSnippets?: string[];
  customKeywords?: string[];
}

// ============================================================
// Core Strategy & Plan Types
// ============================================================

export type ReplyStrategyType =
  | 'MIRROR'       // Use similar medium (e.g. braille -> braille, ascii -> ascii)
  | 'COMPLEMENT'   // Respond with complementary visual form (e.g. braille -> kaomoji)
  | 'CURATED'      // Directly drawn from curated library
  | 'KAOMOJI'      // Japanese kaomoji expression
  | 'EMOJI'        // Emoji combination / badge
  | 'ASCII'        // ASCII art
  | 'BRAILLE'      // Curated Braille art
  | 'STEAM'        // Steam-themed +rep / gaming motif
  | 'TEXT'         // Natural text template / AI text
  | 'GENERATOR'    // Procedural generation
  | 'NONE';        // Skip / no reply

export type ReplySourceType =
  | 'VISUAL_LIBRARY'
  | 'VISUAL_GENERATOR'
  | 'LOCAL_TEMPLATE'
  | 'DEEPSEEK'
  | 'NONE';

export interface ReplyPlan {
  action: 'LOCAL_REPLY' | 'AI_REPLY' | 'SKIP';
  source: ReplySourceType;
  strategy: ReplyStrategyType;
  libraryType?: VisualItemType;
  tags?: string[];
  mood?: string[];
  allowFallbackGenerator: boolean;
  fallbackReply?: string;
  reason: string;
}

export interface ReplyContext {
  commentId: string;
  commenterName: string;
  commenterSteamId: string;
  commenterProfileUrl: string;
  content: string;
  timestampStr?: string;

  // Analysis & classification inputs
  classification: {
    category: string;
    confidence: number;
    language: string;
    isVisualExpression: boolean;
    isSpam: boolean;
    replySource?: string;
    reply?: string;
  };
  visualResult?: VisualExpressionResult;
  decision: ReplyDecisionResult;

  // Forward-compatible extension points
  persona?: PersonaProfile;
  relationship?: RelationshipContext;
  knowledge?: KnowledgeContext;
}

// ============================================================
// ReplyStrategyEngine Implementation
// ============================================================

export class ReplyStrategyEngine {
  /**
   * Evaluates the unified ReplyContext and generates a concrete ReplyPlan.
   * Does NOT execute the reply, touch Steam, or modify databases.
   */
  public static plan(ctx: ReplyContext): ReplyPlan {
    // 1. If spam or explicitly skipped by initial decision
    if (ctx.decision.action === 'SKIP' || ctx.classification.isSpam) {
      return {
        action: 'SKIP',
        source: 'NONE',
        strategy: 'NONE',
        allowFallbackGenerator: false,
        reason: ctx.decision.reason || 'SPAM_OR_BLOCKED'
      };
    }

    // 2. Visual Expression Handling (Priority: Curated Library -> Fallback Generator -> Template)
    if (ctx.classification.isVisualExpression || ctx.decision.type === 'visual_expression') {
      const vr = ctx.visualResult;
      const subtype = vr?.subtype || ctx.classification.category;

      let libraryType: VisualItemType = 'kaomoji';
      let strategy: ReplyStrategyType = 'COMPLEMENT';
      let tags: string[] = ['warm', 'friendly'];
      let mood: string[] = ['happy'];

      if (subtype === 'braille_art') {
        libraryType = 'braille';
        strategy = 'MIRROR';
        tags = ['compact', 'heart', 'paw', 'star'];
      } else if (
        subtype === 'ascii_art' ||
        subtype === 'box_drawing_art' ||
        subtype === 'block_art' ||
        subtype === 'unicode_art' ||
        subtype === 'mixed_symbol_art'
      ) {
        libraryType = 'ascii';
        strategy = 'MIRROR';
        tags = ['compact', 'mini', 'bunny', 'star'];
      } else if (subtype === 'emoji_pixel_art' || subtype === 'emoji_art') {
        libraryType = 'emoji';
        strategy = 'EMOJI';
        tags = ['gaming', 'cozy', 'victory'];
      } else if (subtype === 'large_kaomoji' || subtype === 'kaomoji') {
        libraryType = 'kaomoji';
        strategy = 'KAOMOJI';
        mood = ['happy', 'friendly', 'playful'];
      } else {
        // Complementary fallback for unknown visual forms
        libraryType = 'kaomoji';
        strategy = 'COMPLEMENT';
        mood = ['friendly', 'warm'];
      }

      // Persona adjustments (if persona profile provided)
      if (ctx.persona) {
        if (!ctx.persona.allowVisualReply) {
          return {
            action: 'LOCAL_REPLY',
            source: 'LOCAL_TEMPLATE',
            strategy: 'TEXT',
            allowFallbackGenerator: false,
            fallbackReply: ctx.classification.reply || '✨ 祝游戏愉快！',
            reason: 'PERSONA_SUPPRESS_VISUAL'
          };
        }
        if (ctx.persona.preferredMoods.length > 0) {
          mood = ctx.persona.preferredMoods;
        }
      }

      return {
        action: 'LOCAL_REPLY',
        source: 'VISUAL_LIBRARY',
        strategy,
        libraryType,
        tags,
        mood,
        allowFallbackGenerator: true,
        fallbackReply: ctx.classification.reply || '',
        reason: `VISUAL_STRATEGY_${strategy}_FOR_${subtype}`
      };
    }

    // 3. Known Local Template Categories (greetings, holidays, warm social)
    if (ctx.classification.category !== 'unknown' && ctx.classification.reply) {
      return {
        action: 'LOCAL_REPLY',
        source: 'LOCAL_TEMPLATE',
        strategy: 'TEXT',
        allowFallbackGenerator: false,
        fallbackReply: ctx.classification.reply,
        reason: `LOCAL_CATEGORY_${ctx.classification.category}`
      };
    }

    // 4. Natural Language Comments -> AI Reply via DeepSeek
    if (ctx.decision.type === 'normal' || ctx.decision.action === 'AI_REPLY') {
      return {
        action: 'AI_REPLY',
        source: 'DEEPSEEK',
        strategy: 'TEXT',
        allowFallbackGenerator: false,
        reason: 'NATURAL_TEXT_AI_REPLY'
      };
    }

    // 5. Default Fallback
    return {
      action: 'AI_REPLY',
      source: 'DEEPSEEK',
      strategy: 'TEXT',
      allowFallbackGenerator: false,
      reason: 'DEFAULT_AI_FALLBACK'
    };
  }
}
