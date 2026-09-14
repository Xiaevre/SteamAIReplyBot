export type AiDecisionType = 'NOT_NEEDED' | 'CALLED' | 'BLOCKED' | 'SKIPPED';

export type ReplySourceType =
  | 'LOCAL_TEMPLATE'
  | 'LOCAL_PHRASE'
  | 'VISUAL_LIBRARY'
  | 'VISUAL_GENERATOR'
  | 'DEEPSEEK'
  | 'HOLIDAY_TEMPLATE'
  | 'IMPORT_EXISTING'
  | 'NONE';

export type ActionType =
  | 'REPLY_LOCAL'
  | 'REPLY_AI'
  | 'SKIP'
  | 'SCHEDULED'
  | 'BLOCKED'
  | 'FAILED'
  | 'WAITING'
  | 'STEAM_MODERATION_PENDING';

export type SkipReasonType =
  | 'ALREADY_REPLIED'
  | 'ALREADY_PROCESSED'
  | 'IMPORT_EXISTING'
  | 'RECOVERY_REQUIRED'
  | 'STEAM_MODERATION_PENDING'
  | 'SPAM'
  | 'MISSING_COMMENT_ID'
  | 'MISSING_AUTHOR'
  | 'MISSING_STEAM_ID'
  | 'MISSING_PROFILE_URL'
  | 'CLASSIFICATION_FAILED'
  | 'RATE_LIMITED'
  | 'BOT_DISABLED'
  | 'EMERGENCY_STOPPED'
  | 'INVALID_TARGET'
  | 'UNKNOWN_ERROR'
  | 'NONE';

export interface CommentDiagnosticInfo {
  index: number;
  commentId: string;
  commenterName: string;
  commenterSteamId: string;
  commenterProfileUrl: string;
  originalComment: string;
  commentTime: string;
  databaseRecordExists: boolean;
  databaseStatus: string;
  classification: string;
  classificationConfidence: number;
  classificationSource: string;
  visualExpression: boolean;
  visualExpressionSubtype: string | null;
  visualExpressionConfidence: number;
  aiDecision: AiDecisionType;
  aiReason?: string;
  blockReason?: string;
  aiModel?: string;
  aiLatencyMs?: number;
  replySource: ReplySourceType;
  action: ActionType;
  skipReason: SkipReasonType;
  myProfileUrl: string;
  targetProfileUrl: string;
  direction: string;
  targetDirectionCheck: 'PASS' | 'FAIL';
}

export interface CommentScanSummaryInfo {
  totalComments: number;
  newComments: number;
  alreadyProcessed: number;
  spam: number;
  localReplies: number;
  visualExpressionLocal: number;
  deepseekReplies: number;
  aiRequests: number;
  aiRequestsBlocked: number;
  aiRequestsSaved: number;
  visualExpressionSaved: number;
  rateLimited: number;
  moderationPending: number;
  errors: number;
}

export class CommentDiagnosticLogger {
  public static formatConsoleDiagnostic(d: CommentDiagnosticInfo): string {
    const lines = [
      '----------------------------------------',
      `[COMMENT ${d.index}]`,
      'Comment ID:',
      d.commentId || '(none)',
      '',
      'Author:',
      d.commenterName || '(unknown)',
      '',
      'SteamID:',
      d.commenterSteamId || '(unknown)',
      '',
      'Profile:',
      d.commenterProfileUrl || '(none)',
      '',
      'Original:',
      d.originalComment || '(empty)',
      '',
      'Time:',
      d.commentTime || '(unknown)',
      '',
      'Database:',
      d.databaseRecordExists ? 'EXISTS' : 'NEW',
      '',
      'Status:',
      d.databaseStatus,
      '',
      'Classification:',
      d.classification,
      '',
      'Confidence:',
      d.classificationConfidence.toFixed(2),
      '',
      'Classification Source:',
      d.classificationSource,
      '',
      'Visual Expression:',
      d.visualExpression ? 'true' : 'false',
      '',
      'Visual Subtype:',
      d.visualExpressionSubtype || 'null',
      '',
      'Visual Confidence:',
      d.visualExpressionConfidence.toFixed(2),
      '',
      'AI Decision:',
      d.aiDecision
    ];

    if (d.aiReason) {
      lines.push('', 'AI Reason:', d.aiReason);
    }
    if (d.blockReason) {
      lines.push('', 'Block Reason:', d.blockReason);
    }
    if (d.aiModel) {
      lines.push('', 'AI Model:', d.aiModel);
    }
    if (d.aiLatencyMs !== undefined) {
      lines.push('', 'AI Latency:', `${d.aiLatencyMs}ms`);
    }

    lines.push(
      '',
      'Reply Source:',
      d.replySource,
      '',
      'Action:',
      d.action,
      '',
      'Skip Reason:',
      d.skipReason,
      '',
      'My Profile:',
      d.myProfileUrl || '(not configured)',
      '',
      'Target Profile:',
      d.targetProfileUrl || '(none)',
      '',
      'Direction:',
      d.direction,
      '',
      'TargetDirectionCheck:',
      d.targetDirectionCheck,
      '----------------------------------------'
    );

    return lines.join('\n');
  }

  public static formatSummary(s: CommentScanSummaryInfo): string {
    return [
      '========================================',
      'COMMENT SCAN SUMMARY',
      '========================================',
      '',
      'Total Comments:',
      s.totalComments.toString(),
      '',
      'New:',
      s.newComments.toString(),
      '',
      'Already Processed:',
      s.alreadyProcessed.toString(),
      '',
      'Spam:',
      s.spam.toString(),
      '',
      'Local Replies:',
      s.localReplies.toString(),
      '',
      'Visual Expression Local:',
      s.visualExpressionLocal.toString(),
      '',
      'DeepSeek Replies:',
      s.deepseekReplies.toString(),
      '',
      'AI Requests:',
      s.aiRequests.toString(),
      '',
      'AI Requests Blocked:',
      s.aiRequestsBlocked.toString(),
      '',
      'AI Requests Saved:',
      s.aiRequestsSaved.toString(),
      '',
      'Visual Expression AI Requests Saved:',
      s.visualExpressionSaved.toString(),
      '',
      'Rate Limited:',
      s.rateLimited.toString(),
      '',
      'Moderation Pending:',
      (s.moderationPending || 0).toString(),
      '',
      'Errors:',
      s.errors.toString(),
      '',
      '========================================'
    ].join('\n');
  }
}
