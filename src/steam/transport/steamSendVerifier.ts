import { Logger } from '../../utils/logger';
import { SteamModerationDetector } from '../../rules/moderationDetector';

export type PageVerificationResult =
  | 'FOUND'
  | 'MODERATION_PENDING'
  | 'NOT_FOUND'
  | 'VERIFY_FAILED';

export interface VerifyCommentOptions {
  expectedText: string;
  parsedCommentId?: string;
  botSteamId?: string;
  botProfileUrl?: string;
  targetSteamId?: string;
  sendStartedAt?: number;
  postAttemptedAt?: number;
  verifyStartedAt?: number;
  windowSecondsBefore?: number;
  windowSecondsAfter?: number;
}

export class SteamSendVerifier {
  constructor(
    private myProfileUrl: string,
    private logger: Logger,
    private mySteamId?: string
  ) {}

  public setBotSteamId(steamId: string): void {
    this.mySteamId = steamId;
  }

  /**
   * Helper: Matches whether a comment author matches the Bot's identity (URL or SteamID).
   */
  public static isSameAuthor(
    authorProfileUrl: string,
    authorMiniProfile: string,
    botProfileUrl: string,
    botSteamId?: string
  ): boolean {
    if (!botProfileUrl && !botSteamId) {
      return true; // No bot identity provided, cannot exclude
    }

    const normAuthor = authorProfileUrl ? authorProfileUrl.replace(/\/+$/, '').toLowerCase() : '';
    const normBot = botProfileUrl ? botProfileUrl.replace(/\/+$/, '').toLowerCase() : '';

    if (normAuthor && normBot && (normAuthor === normBot || normAuthor.endsWith(normBot) || normBot.endsWith(normAuthor))) {
      return true;
    }

    if (botSteamId) {
      if (authorProfileUrl && authorProfileUrl.includes(botSteamId)) {
        return true;
      }
      if (authorMiniProfile) {
        const trimmed = authorMiniProfile.trim();
        if (/^\d{17}$/.test(trimmed) && trimmed === botSteamId) {
          return true;
        }
        if (/^\d{1,10}$/.test(trimmed)) {
          try {
            const id64 = (76561197960265728n + BigInt(trimmed)).toString();
            if (id64 === botSteamId) {
              return true;
            }
          } catch {
            // ignore
          }
        }
      }
    }

    return false;
  }

  /**
   * Helper: Checks if the comment's timestamp falls within the reasonable postAttempted window.
   */
  public static isWithinTimeWindow(
    dataTimestamp: number | null,
    postAttemptedAt?: number,
    windowBeforeSec = 60,
    windowAfterSec = 180
  ): boolean {
    if (!postAttemptedAt) {
      return true; // No time window provided
    }
    if (dataTimestamp === null || dataTimestamp === undefined || isNaN(dataTimestamp)) {
      return true; // Timestamp missing on element, do not rule out
    }
    const postAttemptSec = Math.floor(postAttemptedAt / 1000);
    const minSec = postAttemptSec - windowBeforeSec;
    const maxSec = postAttemptSec + windowAfterSec;
    return dataTimestamp >= minSec && dataTimestamp <= maxSec;
  }

  /**
   * Checks if target profile DOM has confirmed restriction elements before sending.
   */
  public async checkTargetDomRestricted(page: any): Promise<boolean> {
    try {
      const isRestricted = await page
        .$eval(
          '.commentthread_restricted, .profile_comment_area_restricted, #commentthread_Profile_empty_restricted',
          () => true
        )
        .catch(() => false);
      return Boolean(isRestricted);
    } catch {
      return false;
    }
  }

  /**
   * Reloads and verifies whether the posted comment or a moderation placeholder appears on the target profile.
   */
  public async verifyOnTargetProfile(
    page: any,
    targetProfileUrl: string,
    expectedTextOrOptions: string | VerifyCommentOptions,
    parsedCommentId?: string
  ): Promise<PageVerificationResult> {
    const opts: VerifyCommentOptions =
      typeof expectedTextOrOptions === 'string'
        ? { expectedText: expectedTextOrOptions, parsedCommentId }
        : expectedTextOrOptions;

    this.logger.info('SEND_VERIFYING', {
      targetProfileUrl,
      parsedCommentId: opts.parsedCommentId || parsedCommentId,
      expectedTextPreview: (opts.expectedText || '').substring(0, 30),
      postAttemptedAt: opts.postAttemptedAt
    });

    try {
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(2000).catch(() => {});
      }

      // Clean reload with cache buster
      const reloadUrl = targetProfileUrl.includes('?')
        ? `${targetProfileUrl}&_v=${Date.now()}`
        : `${targetProfileUrl}?_v=${Date.now()}`;

      await page.goto(reloadUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForSelector('.commentthread_comments, .profile_comment_area', { timeout: 8000 }).catch(() => {});

      const result = await this.verifyCommentInPage(page, opts);
      return result;
    } catch (err: any) {
      this.logger.warn('SEND_VERIFY_EXCEPTION', {
        targetProfileUrl,
        error: err.message || String(err)
      });
      return 'VERIFY_FAILED';
    }
  }

  /**
   * Scans existing comments in page DOM to confirm author, text, timestamp, or moderation notices.
   */
  public async verifyCommentInPage(
    page: any,
    expectedTextOrOptions: string | VerifyCommentOptions,
    parsedCommentId?: string
  ): Promise<PageVerificationResult> {
    try {
      const opts: VerifyCommentOptions =
        typeof expectedTextOrOptions === 'string'
          ? { expectedText: expectedTextOrOptions, parsedCommentId }
          : expectedTextOrOptions;

      const cleanExpected = (opts.expectedText || '').trim().replace(/\s+/g, ' ');
      const targetCommentId = opts.parsedCommentId || parsedCommentId;
      const botUrl = opts.botProfileUrl || this.myProfileUrl;
      const botId = opts.botSteamId || this.mySteamId;

      // 1. Direct parsedCommentId DOM existence check (Strongest proof of creation)
      if (targetCommentId && typeof page.$ === 'function') {
        const commentIdSelector = targetCommentId.startsWith('#')
          ? targetCommentId
          : `#${targetCommentId}`;
        const hasElement = await page.$(commentIdSelector).catch(() => null);
        if (hasElement) {
          const elText =
            (typeof hasElement.textContent === 'function'
              ? await hasElement.textContent().catch(() => '')
              : '') || '';
          const mod = SteamModerationDetector.detect(elText);
          if (mod.isModerationPending) {
            this.logger.info('SEND_VERIFY_COMMENT_ID_MODERATION', { parsedCommentId: targetCommentId });
            return 'MODERATION_PENDING';
          }
          const cleanActual = elText.trim().replace(/\s+/g, ' ');
          if (cleanActual === cleanExpected || cleanActual.includes(cleanExpected)) {
            this.logger.info('SEND_VERIFY_COMMENT_ID_MATCH', { parsedCommentId: targetCommentId });
            return 'FOUND';
          }
          // Element with the exact ID created by Steam exists in DOM! Even if text is hidden, it is under moderation
          this.logger.info('SEND_VERIFY_COMMENT_ID_EXISTS_UNDER_MODERATION', { parsedCommentId: targetCommentId });
          return 'MODERATION_PENDING';
        }
      }

      // 2. Scan individual comment items on target profile
      const comments = await page
        .$$eval('.commentthread_comment, .profile_comment_area .comment', (els: any[]) => {
          return els.map((el) => {
            if (!el) return null;
            // Support pre-parsed mock comment objects in unit tests
            if (typeof el === 'object' && el.text !== undefined && el.profileUrl !== undefined) {
              return el;
            }

            const authorLink = typeof el.querySelector === 'function'
              ? el.querySelector('.commentthread_author_link, .author a, .commentthread_comment_author a')
              : null;
            const avatarLink = typeof el.querySelector === 'function'
              ? el.querySelector('.commentthread_comment_avatar a, .commentthread_avatar a')
              : null;
            const authorText = authorLink ? authorLink.textContent?.trim() : '';
            const authorHref = authorLink
              ? ((authorLink as any).href || (typeof authorLink.getAttribute === 'function' ? authorLink.getAttribute('href') : '') || (typeof authorLink.getAttribute === 'function' ? authorLink.getAttribute('') : ''))
              : '';
            const avatarHref = avatarLink
              ? ((avatarLink as any).href || (typeof avatarLink.getAttribute === 'function' ? avatarLink.getAttribute('href') : ''))
              : '';

            // miniprofile or author steamid
            const rawMini =
              (authorLink && typeof authorLink.getAttribute === 'function' ? authorLink.getAttribute('data-miniprofile') : null) ||
              (avatarLink && typeof avatarLink.getAttribute === 'function' ? avatarLink.getAttribute('data-miniprofile') : null) ||
              (typeof el.getAttribute === 'function' ? el.getAttribute('data-miniprofile') : null) ||
              '';

            // timestamp from data-timestamp
            const timeEl = typeof el.querySelector === 'function'
              ? el.querySelector('.commentthread_comment_timestamp, [data-timestamp]')
              : null;
            const dataTimestampStr = timeEl && typeof timeEl.getAttribute === 'function'
              ? timeEl.getAttribute('data-timestamp')
              : null;
            const dataTimestamp = dataTimestampStr ? parseInt(dataTimestampStr, 10) : null;
            const timeTitle = timeEl && typeof timeEl.getAttribute === 'function' ? timeEl.getAttribute('title') : '';
            const timeText = timeEl ? timeEl.textContent?.trim() : '';

            const contentEl = typeof el.querySelector === 'function'
              ? el.querySelector('.commentthread_comment_text, .comment_text')
              : null;
            const text = contentEl ? contentEl.textContent?.trim() : '';
            const fullText = el.textContent?.trim() || '';

            return {
              id: el.id || '',
              author: authorText,
              profileUrl: authorHref || avatarHref || '',
              rawMini: rawMini || '',
              dataTimestamp,
              timeTitle,
              timeText,
              text,
              fullText
            };
          }).filter(Boolean);
        })
        .catch(() => []);

      for (const c of comments) {
        // A. Match parsedCommentId if present in scanned list
        if (targetCommentId && c.id === targetCommentId) {
          const modDetect =
            SteamModerationDetector.detect(c.text || '') ||
            SteamModerationDetector.detect(c.fullText || '');
          if (modDetect.isModerationPending) {
            return 'MODERATION_PENDING';
          }
          const cleanActual = (c.text || c.fullText || '').trim().replace(/\s+/g, ' ');
          if (cleanActual === cleanExpected || cleanActual.includes(cleanExpected)) {
            return 'FOUND';
          }
          return 'MODERATION_PENDING';
        }

        // B. Moderation Placeholder Check (Must bind to current send per Safety Rule 2)
        const textMod = SteamModerationDetector.detect(c.text || '');
        const fullMod = SteamModerationDetector.detect(c.fullText || '');
        const hasModNotice = textMod.isModerationPending || fullMod.isModerationPending;

        if (hasModNotice) {
          // 1. Direct comment ID match
          if (targetCommentId && c.id === targetCommentId) {
            this.logger.info('SEND_VERIFY_MODERATION_COMMENT_ID_MATCH', { commentId: c.id });
            return 'MODERATION_PENDING';
          }

          const isAuthorMatched = SteamSendVerifier.isSameAuthor(c.profileUrl, c.rawMini, botUrl, botId);
          const isTimeMatched = SteamSendVerifier.isWithinTimeWindow(
            c.dataTimestamp,
            opts.postAttemptedAt,
            opts.windowSecondsBefore ?? 60,
            opts.windowSecondsAfter ?? 180
          );

          // 2. Author and time window match
          if (isAuthorMatched && isTimeMatched) {
            this.logger.info('SEND_VERIFY_MODERATION_BOUND_MATCH', {
              commentId: c.id,
              author: c.author,
              profileUrl: c.profileUrl
            });
            return 'MODERATION_PENDING';
          }

          // 3. Foreign user or old historical moderation notice
          const isExplicitOtherAuthor = Boolean(c.profileUrl) && !isAuthorMatched;
          const isHistorical = c.dataTimestamp !== null && c.dataTimestamp !== undefined && !isTimeMatched;
          if (isExplicitOtherAuthor || isHistorical) {
            this.logger.info('SEND_VERIFY_OTHER_MODERATION_SKIPPED', {
              commentId: c.id,
              author: c.author,
              profileUrl: c.profileUrl,
              dataTimestamp: c.dataTimestamp
            });
            continue;
          }

          // 4. Anonymous / unbound moderation placeholder -> cannot authoritatively bind to this send!
          // Per requirement: lower confidence, if insufficient evidence -> VERIFY_FAILED (maps to UNCERTAIN)
          this.logger.warn('SEND_VERIFY_MODERATION_UNBOUND_INSUFFICIENT', {
            commentId: c.id,
            reason: 'Moderation notice found but cannot be authoritatively bound to current send'
          });
          return 'VERIFY_FAILED';
        }

        // C. Check Text Match
        const cleanActual = (c.text || '').trim().replace(/\s+/g, ' ');
        const isTextMatched = cleanActual === cleanExpected || cleanActual.includes(cleanExpected);
        if (!isTextMatched) {
          continue;
        }

        // D. Identity Constraint Check: MUST be authored by the Bot!
        const isAuthorMatched = SteamSendVerifier.isSameAuthor(c.profileUrl, c.rawMini, botUrl, botId);
        if (!isAuthorMatched) {
          this.logger.info('SEND_VERIFY_OTHER_USER_SAME_TEXT_SKIPPED', {
            commentId: c.id,
            author: c.author,
            profileUrl: c.profileUrl,
            expectedAuthor: botUrl
          });
          continue;
        }

        // E. Time Window Constraint Check: MUST be within postAttemptedAt reasonable window!
        const isTimeMatched = SteamSendVerifier.isWithinTimeWindow(
          c.dataTimestamp,
          opts.postAttemptedAt,
          opts.windowSecondsBefore ?? 60,
          opts.windowSecondsAfter ?? 180
        );
        if (!isTimeMatched) {
          this.logger.info('SEND_VERIFY_HISTORICAL_COMMENT_SKIPPED', {
            commentId: c.id,
            commentTimestamp: c.dataTimestamp,
            postAttemptedAt: opts.postAttemptedAt
          });
          continue;
        }

        // All 3 constraints satisfied: Content + Bot Identity + Time Window!
        this.logger.info('SEND_VERIFY_CONFIRMED_MATCH', {
          commentId: c.id,
          author: c.author,
          timestamp: c.dataTimestamp
        });
        return 'FOUND';
      }

      // 3. Thread container-wide Moderation Notice Check
      const threadText =
        typeof page.$eval === 'function'
          ? await page
              .$eval(
                '.commentthread_comments, .profile_comment_area, .commentthread_area',
                (el: any) => el.textContent || ''
              )
              .catch(() => '')
          : '';
      if (typeof threadText === 'string' && threadText) {
        const threadMod = SteamModerationDetector.detect(threadText);
        if (threadMod.isModerationPending) {
          this.logger.info('SEND_VERIFY_THREAD_MODERATION_DETECTED', {
            matchedPattern: threadMod.matchedPattern
          });
          return 'MODERATION_PENDING';
        }
      }

      // 4. Page body-wide Moderation Notice Check
      const pageBodyText =
        typeof page.evaluate === 'function'
          ? await page
              .evaluate(() => (document.body ? document.body.innerText : ''))
              .catch(() => '')
          : '';
      if (typeof pageBodyText === 'string' && pageBodyText) {
        const bodyMod = SteamModerationDetector.detect(pageBodyText);
        if (bodyMod.isModerationPending) {
          this.logger.info('SEND_VERIFY_BODY_MODERATION_DETECTED', {
            matchedPattern: bodyMod.matchedPattern
          });
          return 'MODERATION_PENDING';
        }
      }

      return 'NOT_FOUND';
    } catch (err: any) {
      this.logger.warn('SEND_VERIFY_IN_PAGE_EXCEPTION', {
        error: err.message || String(err)
      });
      return 'VERIFY_FAILED';
    }
  }
}
