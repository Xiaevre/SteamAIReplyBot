import { Logger } from '../../utils/logger';

export interface SteamTransportResult {
  httpStatus: number;
  rawJson: any | null;
  rawResponseText: string;
  networkError: string | null;
  sessionIdFound: boolean;
}

export interface PostCommentOptions {
  targetSteamId64: string;
  commentText: string;
  count?: number;
  targetProfileUrl?: string;
}

export class SteamCommentTransport {
  constructor(private logger: Logger) {}

  /**
   * Dispatches the authenticated Steam Comment HTTP POST inside the page context.
   * Leverages the page's authenticated WebSession and cookies (steamLoginSecure, sessionid).
   */
  public async postComment(page: any, options: PostCommentOptions): Promise<SteamTransportResult> {
    const { targetSteamId64, commentText, count = 6, targetProfileUrl } = options;

    // Strict Final Security Gate: targetSteamId64 must be a 17-digit numeric SteamID64
    const validTargetId = targetSteamId64 ? String(targetSteamId64).trim() : '';
    if (!validTargetId || !/^\d{17}$/.test(validTargetId)) {
      this.logger.error('SEND_TRANSPORT_INVALID_STEAMID', {
        targetSteamId64,
        targetProfileUrl,
        reason: 'targetSteamId64 must be a valid 17-digit numeric SteamID64'
      });
      return {
        httpStatus: 0,
        networkError: 'INVALID_STEAMID64: targetSteamId64 must match /^\\d{17}$/',
        rawJson: null,
        rawResponseText: '',
        sessionIdFound: true
      };
    }

    const endpoint = `/comment/Profile/post/${validTargetId}/-1/`;

    this.logger.info('SEND_TRANSPORT_POST', {
      endpoint,
      targetSteamId64: validTargetId,
      targetProfileUrl,
      textLength: commentText.length,
      textPreview: commentText.substring(0, 30)
    });

    try {
      const evalResult = await page.evaluate(
        async ({ targetId, text, commentCount }) => {
          if (!targetId || !/^\d{17}$/.test(String(targetId).trim())) {
            return {
              httpStatus: 0,
              networkError: 'INVALID_STEAMID64: targetSteamId64 must match /^\\d{17}$/',
              rawJson: null,
              rawResponseText: '',
              sessionIdFound: true
            };
          }

          let sessionId = (window as any).g_sessionID;
          if (!sessionId) {
            const m = document.cookie.match(/sessionid=([^;]+)/);
            if (m) sessionId = decodeURIComponent(m[1].trim());
          }

          if (!sessionId) {
            return {
              httpStatus: 0,
              networkError: 'SESSIONID_NOT_FOUND',
              rawJson: null,
              rawResponseText: '',
              sessionIdFound: false
            };
          }

          const targetUrl = `/comment/Profile/post/${targetId}/-1/`;
          const body = new URLSearchParams();
          body.append('comment', text);
          body.append('count', String(commentCount));
          body.append('sessionid', sessionId);

          try {
            const res = await fetch(targetUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: body.toString()
            });

            const httpStatus = res.status;
            const resText = await res.text();
            let rawJson: any = null;
            try {
              rawJson = JSON.parse(resText);
            } catch {
              rawJson = { parseError: true, preview: resText.substring(0, 300) };
            }

            return {
              httpStatus,
              networkError: null,
              rawJson,
              rawResponseText: resText,
              sessionIdFound: true
            };
          } catch (err: any) {
            return {
              httpStatus: 0,
              networkError: err.message || String(err),
              rawJson: null,
              rawResponseText: '',
              sessionIdFound: true
            };
          }
        },
        { targetId: targetSteamId64, text: commentText, commentCount: count }
      );

      // Masked diagnostic log (Never log sessionid or credentials)
      const hasSessionId = evalResult.sessionIdFound ?? (evalResult.networkError !== 'SESSIONID_NOT_FOUND');
      this.logger.info('SEND_TRANSPORT_DIAGNOSTIC', {
        endpoint,
        targetSteamId64,
        httpStatus: evalResult.httpStatus,
        sessionIdFound: hasSessionId,
        networkError: evalResult.networkError,
        responsePreview: evalResult.rawResponseText ? evalResult.rawResponseText.substring(0, 200) : ''
      });

      return {
        httpStatus: evalResult.httpStatus,
        networkError: evalResult.networkError || null,
        rawJson: evalResult.rawJson,
        rawResponseText: evalResult.rawResponseText || '',
        sessionIdFound: hasSessionId
      };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      this.logger.error('SEND_TRANSPORT_ERROR', {
        targetSteamId64,
        error: errMsg
      });
      return {
        httpStatus: 0,
        networkError: errMsg,
        rawJson: null,
        rawResponseText: '',
        sessionIdFound: false
      };
    }
  }
}
