import { SteamTransportResult } from './steamCommentTransport';

export type ClassifiedTransportStatus =
  | 'SUCCESS'
  | 'TARGET_REJECTION_CANDIDATE'
  | 'TARGET_REJECTED'
  | 'TARGET_PERMISSION_UNKNOWN'
  | 'RATE_LIMITED'
  | 'DUPLICATE'
  | 'STEAM_TRANSIENT_ERROR'
  | 'NETWORK_ERROR'
  | 'POTENTIAL_SESSION_INVALID'
  | 'UNKNOWN_STEAM_ERROR';

export interface ClassifiedSendResult {
  status: ClassifiedTransportStatus;
  rawError?: string;
  commentsHtml?: string;
  parsedCommentId?: string;
  message?: string;
}

export class SteamSendErrorClassifier {
  /**
   * Classifies a raw Steam transport result into a clean domain status.
   */
  public static classify(transportResult: SteamTransportResult): ClassifiedSendResult {
    const { httpStatus, networkError, rawJson, rawResponseText, sessionIdFound } = transportResult;

    if (sessionIdFound === false || networkError === 'SESSIONID_NOT_FOUND') {
      return {
        status: 'POTENTIAL_SESSION_INVALID',
        rawError: 'SESSIONID_NOT_FOUND',
        message: 'Steam sessionid cookie or global variable not found in page'
      };
    }

    if (networkError || httpStatus === 0) {
      return {
        status: 'NETWORK_ERROR',
        rawError: networkError || 'NETWORK_FAILURE',
        message: `Network error or timeout: ${networkError || 'HTTP 0'}`
      };
    }

    // Success path
    if (rawJson && Boolean(rawJson.success)) {
      const commentsHtml = typeof rawJson.comments_html === 'string' ? rawJson.comments_html : '';
      let parsedCommentId: string | undefined = undefined;

      // Extract comment ID (e.g. id="comment_123456789" or commentthread_comment)
      const idMatch = commentsHtml.match(/id=["']comment_(\d+)["']/);
      if (idMatch) {
        parsedCommentId = `comment_${idMatch[1]}`;
      } else {
        const altMatch = commentsHtml.match(/commentthread_comment_author_link_(\d+)/);
        if (altMatch) {
          parsedCommentId = `comment_${altMatch[1]}`;
        }
      }

      return {
        status: 'SUCCESS',
        commentsHtml,
        parsedCommentId,
        message: 'Comment submitted successfully'
      };
    }

    // Server-side errors (HTTP 5xx)
    if (httpStatus >= 500) {
      return {
        status: 'STEAM_TRANSIENT_ERROR',
        rawError: `HTTP_${httpStatus}`,
        message: `Steam Community server transient error (HTTP ${httpStatus})`
      };
    }

    // Explicit HTTP 401 / 403
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        status: 'POTENTIAL_SESSION_INVALID',
        rawError: `HTTP_${httpStatus}`,
        message: `Steam returned unauthenticated HTTP status ${httpStatus}`
      };
    }

    // Parse error string
    const errorStr = rawJson && rawJson.error ? String(rawJson.error).trim() : '';
    const errLower = (errorStr || rawResponseText || '').toLowerCase();

    // 1. Rate limiting
    if (
      httpStatus === 429 ||
      errLower.includes('frequently') ||
      errLower.includes('too quickly') ||
      errLower.includes('cooldown') ||
      errLower.includes('slow down') ||
      errLower.includes('wait a few minutes')
    ) {
      return {
        status: 'RATE_LIMITED',
        rawError: errorStr || 'RATE_LIMITED',
        message: errorStr || 'Rate limit exceeded on Steam comments'
      };
    }

    // 2. Duplicate comment
    if (
      errLower.includes('duplicate') ||
      errLower.includes('already posted') ||
      errLower.includes('identical')
    ) {
      return {
        status: 'DUPLICATE',
        rawError: errorStr || 'DUPLICATE',
        message: errorStr || 'Duplicate comment already posted'
      };
    }

    // 3. Target Rejection Candidate (Target Privacy / Friends Only / Comments Blocked)
    // Note: "此帐户的设置不允许您添加留言。" is a TARGET_REJECTION_CANDIDATE.
    // The final status is confirmed by Session Re-check in commentSender:
    // Session VALID -> TARGET_REJECTED
    // Session INVALID -> SESSION_INVALID
    if (
      errLower.includes('此帐户的设置不允许您添加留言') ||
      errLower.includes('此账户的设置不允许您添加留言') ||
      errLower.includes('settings on this account do not allow') ||
      errLower.includes('settings of this account do not allow') ||
      errLower.includes('only allow friends') ||
      errLower.includes('only friends') ||
      errLower.includes('privilege') ||
      errLower.includes('thread is locked') ||
      errLower.includes('commenting has been disabled')
    ) {
      return {
        status: 'TARGET_REJECTION_CANDIDATE',
        rawError: errorStr || 'TARGET_REJECTED',
        message: errorStr || 'Target user settings do not allow comments'
      };
    }

    // 4. Session / Auth explicitly indicated in response body
    if (
      errLower.includes('you must be logged in') ||
      errLower.includes('please log in') ||
      errLower.includes('session expired') ||
      errLower.includes('not logged in')
    ) {
      return {
        status: 'POTENTIAL_SESSION_INVALID',
        rawError: errorStr || 'SESSION_EXPIRED',
        message: errorStr || 'Steam reported session is not logged in'
      };
    }

    // 5. Fallback for other Steam business errors
    return {
      status: 'UNKNOWN_STEAM_ERROR',
      rawError: errorStr || 'UNKNOWN_ERROR',
      message: errorStr || `Unknown Steam comment failure (HTTP ${httpStatus})`
    };
  }
}
