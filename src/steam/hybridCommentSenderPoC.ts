import { SteamBrowserManager } from './browser';
import { Logger } from '../utils/logger';
import { SteamModerationDetector } from '../rules/moderationDetector';

export type HybridSendClassification =
  | 'SUCCESS'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'SESSION_INVALID'
  | 'MODERATION_PENDING'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface HybridSendPoCResult {
  targetSteamId64: string;
  endpoint: string;
  httpStatus: number;
  responseKeys: string[];
  success: boolean;
  error?: string;
  hasCommentsHtml: boolean;
  commentsHtmlLength: number;
  commentsHtmlSnippet?: string;
  parsedCommentId?: string;
  timelastpost?: number;
  classification: HybridSendClassification;
  targetPageVerified: boolean;
  targetPageContentPreview?: string;
  targetPageModerationPending: boolean;
}

export class HybridCommentSenderPoC {
  constructor(
    private browserManager: SteamBrowserManager,
    private logger: Logger
  ) {}

  public async executePoC(
    targetSteamId64: string,
    targetProfileUrl: string,
    commentText: string
  ): Promise<HybridSendPoCResult> {
    if (!targetSteamId64 || !/^\d{17}$/.test(String(targetSteamId64).trim())) {
      throw new Error(`Invalid targetSteamId64: must be a 17-digit numeric string, got "${targetSteamId64}"`);
    }

    const page = await this.browserManager.openEphemeralPage();
    const endpoint = `/comment/Profile/post/${targetSteamId64}/-1/`;

    try {
      this.logger.info('HYBRID_POC_NAVIGATING_TARGET', {
        targetProfileUrl,
        targetSteamId64
      });

      // 1. Navigate to target profile to establish same-origin context and cookies
      await page.goto(targetProfileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // 2. Perform same-origin HTTP POST inside page context using active session
      this.logger.info('HYBRID_POC_DISPATCHING_FETCH', {
        endpoint,
        textPreview: commentText.substring(0, 30)
      });

      const fetchResult = await page.evaluate(
        async ({ targetSteamId, textToSend }) => {
          // Resolve sessionid safely from window global or cookie
          let sessionId = (window as any).g_sessionID;
          if (!sessionId) {
            const m = document.cookie.match(/sessionid=([^;]+)/);
            if (m) sessionId = decodeURIComponent(m[1].trim());
          }

          if (!sessionId) {
            return {
              httpStatus: 0,
              networkError: 'SESSIONID_NOT_FOUND_IN_COOKIE',
              rawJson: null
            };
          }

          const targetUrl = `/comment/Profile/post/${targetSteamId}/-1/`;
          const body = new URLSearchParams();
          body.append('comment', textToSend);
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
              rawJson
            };
          } catch (err: any) {
            return {
              httpStatus: 0,
              networkError: err.message || String(err),
              rawJson: null
            };
          }
        },
        { targetSteamId: targetSteamId64, textToSend: commentText }
      );

      // 3. Process Response without logging sensitive data
      const httpStatus = fetchResult.httpStatus;
      const rawJson = fetchResult.rawJson || {};
      const responseKeys = Object.keys(rawJson);
      const isSuccess = Boolean(rawJson.success);
      const errorStr = rawJson.error ? String(rawJson.error) : undefined;
      const commentsHtml = typeof rawJson.comments_html === 'string' ? rawJson.comments_html : '';
      const hasCommentsHtml = commentsHtml.length > 0;
      const commentsHtmlLength = commentsHtml.length;
      const timelastpost = typeof rawJson.timelastpost === 'number' ? rawJson.timelastpost : undefined;

      // Extract parsed comment ID if present in HTML
      let parsedCommentId: string | undefined = undefined;
      const idMatch = commentsHtml.match(/id=["']comment_(\d+)["']/);
      if (idMatch) {
        parsedCommentId = `comment_${idMatch[1]}`;
      }

      // Safe summary snippet (tag-stripped, max 100 chars)
      let commentsHtmlSnippet: string | undefined = undefined;
      if (hasCommentsHtml) {
        const stripped = commentsHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        commentsHtmlSnippet = stripped.substring(0, 100);
      }

      // 4. Response Classification
      let classification: HybridSendClassification = 'UNKNOWN_ERROR';
      if (fetchResult.networkError || httpStatus === 0) {
        classification = 'NETWORK_ERROR';
      } else if (isSuccess) {
        const modDetect = SteamModerationDetector.detect(commentsHtml);
        if (modDetect.isModerationPending) {
          classification = 'MODERATION_PENDING';
        } else {
          classification = 'SUCCESS';
        }
      } else {
        const errLower = (errorStr || '').toLowerCase();
        if (errLower.includes('frequently') || errLower.includes('cooldown') || errLower.includes('rate')) {
          classification = 'RATE_LIMITED';
        } else if (
          errLower.includes('setting') ||
          errLower.includes('privilege') ||
          errLower.includes('friend') ||
          errLower.includes('private') ||
          errLower.includes('allow')
        ) {
          classification = 'PERMISSION_DENIED';
        } else if (errLower.includes('network') || errLower.includes('session') || errLower.includes('login')) {
          classification = 'SESSION_INVALID';
        } else {
          classification = 'UNKNOWN_ERROR';
        }
      }

      this.logger.info('HYBRID_POC_RESPONSE_CLASSIFIED', {
        targetSteamId64,
        endpoint,
        httpStatus,
        responseKeys,
        success: isSuccess,
        error: errorStr,
        hasCommentsHtml,
        commentsHtmlLength,
        parsedCommentId,
        timelastpost,
        classification
      });

      // 5. Post-send Verification on Target Profile
      await page.waitForTimeout(4000);
      const reloadUrl = targetProfileUrl.includes('?')
        ? `${targetProfileUrl}&_poc=${Date.now()}`
        : `${targetProfileUrl}?_poc=${Date.now()}`;

      await page.goto(reloadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForSelector('.commentthread_comments, .profile_comment_area', { timeout: 10000 }).catch(() => {});

      const verificationData = await page.evaluate(() => {
        const comments = Array.from(document.querySelectorAll('.commentthread_comment'));
        return comments.map(el => {
          const textEl = el.querySelector('.commentthread_comment_text');
          const authorEl = el.querySelector('.commentthread_author_link');
          return {
            id: el.id,
            author: (authorEl?.textContent || '').trim(),
            text: (textEl?.textContent || '').trim().replace(/\s+/g, ' ')
          };
        });
      });

      let targetPageVerified = false;
      let targetPageModerationPending = false;
      let targetPageContentPreview: string | undefined = undefined;

      const cleanExpected = commentText.trim().replace(/\s+/g, ' ');
      for (const item of verificationData) {
        if (item.text.includes(cleanExpected)) {
          targetPageVerified = true;
          targetPageContentPreview = item.text.substring(0, 60);
          break;
        }
      }

      // Check if top comments exhibit moderation placeholder
      for (const item of verificationData.slice(0, 3)) {
        if (SteamModerationDetector.detect(item.text).isModerationPending) {
          targetPageModerationPending = true;
          if (!targetPageContentPreview) {
            targetPageContentPreview = item.text.substring(0, 60);
          }
          break;
        }
      }

      const result: HybridSendPoCResult = {
        targetSteamId64,
        endpoint,
        httpStatus,
        responseKeys,
        success: isSuccess,
        error: errorStr,
        hasCommentsHtml,
        commentsHtmlLength,
        commentsHtmlSnippet,
        parsedCommentId,
        timelastpost,
        classification,
        targetPageVerified,
        targetPageContentPreview,
        targetPageModerationPending
      };

      this.logger.info('HYBRID_POC_COMPLETED', {
        success: result.success,
        classification: result.classification,
        targetPageVerified: result.targetPageVerified,
        targetPageModerationPending: result.targetPageModerationPending
      });

      return result;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
