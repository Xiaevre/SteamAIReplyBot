import { SteamBrowserManager } from './browser';
import { Logger } from '../utils/logger';

export interface DiagnoseSendResult {
  targetSteamId64: string;
  targetProfileUrl: string;
  endpoint: string;
  method: string;
  requestHeadersMasked: Record<string, string>;
  requestBodyMasked: string;
  httpStatus: number;
  rawResponseBody: string;
  rawJson: any;
  success: boolean;
  error?: string;
  parsedCommentId?: string;
  hasCommentsHtml: boolean;
  commentsHtmlLength: number;
  sessionState: {
    hasLoginCookie: boolean;
    hasSessionIdCookie: boolean;
    pageSteamId?: string | null;
    accountPulldown?: string | null;
  };
  targetPageDom: {
    hasCommentArea: boolean;
    hasCommentForm: boolean;
    hasTextarea: boolean;
    restrictedNotice?: string | null;
  };
  classification:
    | 'SUCCESS'
    | 'RATE_LIMITED'
    | 'PERMISSION_DENIED'
    | 'COMMENT_REJECTED_BY_STEAM'
    | 'SESSION_INVALID'
    | 'NETWORK_ERROR';
}

export async function executeDiagnoseSend(
  browserManager: SteamBrowserManager,
  targetSteamId64: string,
  commentText: string,
  logger: Logger
): Promise<DiagnoseSendResult> {
  if (!targetSteamId64 || !/^\d{17}$/.test(String(targetSteamId64).trim())) {
    throw new Error(`Invalid targetSteamId64: must be a 17-digit numeric string, got "${targetSteamId64}"`);
  }

  const targetProfileUrl = `https://steamcommunity.com/profiles/${targetSteamId64}`;
  const endpoint = `/comment/Profile/post/${targetSteamId64}/-1/`;

  logger.info('DIAGNOSE_SEND_STARTED', {
    targetSteamId64,
    targetProfileUrl,
    commentText
  });

  const page = await browserManager.openEphemeralPage();

  try {
    // 1. Inspect cookies in current persistent browser context
    const ctx = page.context();
    const cookies = await ctx.cookies('https://steamcommunity.com');
    const hasLoginCookie = cookies.some((c: any) => c.name === 'steamLoginSecure' && c.value.length > 10);
    const hasSessionIdCookie = cookies.some((c: any) => c.name === 'sessionid');

    // 2. Navigate to target profile (same-origin setup as production Hybrid Sender)
    await page.goto(targetProfileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // 3. Inspect DOM state on target profile
    const domInfo = await page.evaluate(() => {
      const restrictedEl = document.querySelector('.commentthread_restricted');
      const areaEl = document.querySelector('.commentthread_area');
      const formEl = document.querySelector('form[id^="commentthread_Profile_"]');
      const textarea = document.querySelector('textarea.commentthread_textarea');
      const accountPulldown = document.querySelector('#account_pulldown');

      return {
        hasCommentArea: Boolean(areaEl),
        hasCommentForm: Boolean(formEl),
        hasTextarea: Boolean(textarea),
        restrictedNotice: restrictedEl ? restrictedEl.textContent?.trim() : null,
        pageSteamId: (window as any).g_steamID || null,
        accountPulldown: accountPulldown ? accountPulldown.textContent?.trim() : null
      };
    });

    // 4. Dispatch the exact same Hybrid POST using page.evaluate (Zero auto-retry)
    const fetchResult = await page.evaluate(
      async ({ targetId, text }) => {
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
            rawResponseText: ''
          };
        }

        const targetUrl = `/comment/Profile/post/${targetId}/-1/`;
        const body = new URLSearchParams();
        body.append('comment', text);
        body.append('count', '6');
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
            rawResponseText: resText
          };
        } catch (err: any) {
          return {
            httpStatus: 0,
            networkError: err.message || String(err),
            rawJson: null,
            rawResponseText: ''
          };
        }
      },
      { targetId: targetSteamId64, text: commentText }
    );

    const httpStatus = fetchResult.httpStatus;
    const rawJson = fetchResult.rawJson || {};
    const rawResponseText = fetchResult.rawResponseText || (rawJson ? JSON.stringify(rawJson) : '');
    const isSuccess = Boolean(rawJson.success);
    const errorStr = rawJson.error ? String(rawJson.error) : undefined;
    const commentsHtml = typeof rawJson.comments_html === 'string' ? rawJson.comments_html : '';
    const hasCommentsHtml = commentsHtml.length > 0;
    const commentsHtmlLength = commentsHtml.length;

    // Parse comment ID from comments_html if present
    let parsedCommentId: string | undefined;
    if (hasCommentsHtml) {
      const idMatch = commentsHtml.match(/id=["']comment_(\d+)["']/i);
      if (idMatch && idMatch[1]) {
        parsedCommentId = `comment_${idMatch[1]}`;
      }
    }

    // Classify response
    let classification: DiagnoseSendResult['classification'] = 'COMMENT_REJECTED_BY_STEAM';
    if (fetchResult.networkError || httpStatus === 0) {
      classification = 'NETWORK_ERROR';
    } else if (isSuccess) {
      classification = 'SUCCESS';
    } else {
      const errLower = (errorStr || '').toLowerCase();
      if (errLower.includes('frequently') || errLower.includes('often') || errLower.includes('cooldown') || httpStatus === 429) {
        classification = 'RATE_LIMITED';
      } else if (
        (errLower.includes('setting') && errLower.includes('friend')) ||
        errLower.includes('privilege') ||
        errLower.includes('only allow friends')
      ) {
        classification = 'PERMISSION_DENIED';
      } else if (
        errLower.includes('session') ||
        errLower.includes('login') ||
        errLower.includes('auth') ||
        errLower.includes('logged in')
      ) {
        classification = 'SESSION_INVALID';
      } else {
        classification = 'COMMENT_REJECTED_BY_STEAM';
      }
    }

    const result: DiagnoseSendResult = {
      targetSteamId64,
      targetProfileUrl,
      endpoint,
      method: 'POST',
      requestHeadersMasked: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': targetProfileUrl,
        'Cookie': '[MASKED]'
      },
      requestBodyMasked: `comment=${encodeURIComponent(commentText)}&count=6&sessionid=[MASKED]`,
      httpStatus,
      rawResponseBody: rawResponseText,
      rawJson,
      success: isSuccess,
      error: errorStr,
      parsedCommentId,
      hasCommentsHtml,
      commentsHtmlLength,
      sessionState: {
        hasLoginCookie,
        hasSessionIdCookie,
        pageSteamId: domInfo.pageSteamId,
        accountPulldown: domInfo.accountPulldown
      },
      targetPageDom: {
        hasCommentArea: domInfo.hasCommentArea,
        hasCommentForm: domInfo.hasCommentForm,
        hasTextarea: domInfo.hasTextarea,
        restrictedNotice: domInfo.restrictedNotice
      },
      classification
    };

    // Complete Diagnostic Logging (Strict: Never log credentials/sessionid/cookie)
    logger.info('DIAGNOSE_SEND_RESULT', {
      url: `https://steamcommunity.com${endpoint}`,
      method: 'POST',
      headers: result.requestHeadersMasked,
      postBody: result.requestBodyMasked,
      httpStatus,
      responseBody: rawResponseText,
      classification,
      success: isSuccess,
      error: errorStr,
      sessionState: result.sessionState,
      targetPageDom: result.targetPageDom
    });

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
