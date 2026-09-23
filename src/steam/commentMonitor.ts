import { SteamBrowserManager } from './browser';
import { Logger } from '../utils/logger';
import { SteamSessionManager } from './session';

export interface DiscoveredComment {
  commentId: string;
  commenterName: string;
  commenterProfileUrl: string;
  commenterSteamId: string;
  content: string;
  timestampStr?: string;
}

export class CommentMonitor {
  private lastSessionValid: boolean = true;
  public catchupLimitExceeded: boolean = false;
  public lastCatchupStats: {
    fetchedCount: number;
    pageCount: number;
    oldestId: string | null;
    newestId: string | null;
  } = {
    fetchedCount: 0,
    pageCount: 0,
    oldestId: null,
    newestId: null
  };

  constructor(
    private browserManager: SteamBrowserManager,
    private myProfileUrl: string,
    private logger: Logger
  ) {}

  public isSessionValid(): boolean {
    return this.lastSessionValid;
  }

  public setSessionValid(valid: boolean): void {
    this.lastSessionValid = valid;
  }

  public async extractCommentsFromPage(page: any): Promise<DiscoveredComment[]> {
    return await page.$$eval(
      '.commentthread_comment',
      (elements: any[]) => {
        const results: any[] = [];
        for (const el of elements) {
          // e.g. id="comment_123456789"
          const commentId = el.id || el.getAttribute('data-commentid') || '';
          const authorEl = el.querySelector('.commentthread_author_link');
          const commenterName = authorEl ? authorEl.textContent.trim() : '';
          const commenterProfileUrl = authorEl ? authorEl.getAttribute('href') : '';

          // Extract Steam ID from author avatar or profile link
          const avatarEl = el.querySelector('.commentthread_comment_avatar a');
          const profileUrl = commenterProfileUrl || (avatarEl ? avatarEl.getAttribute('href') : '') || '';

          // Extract steamid from miniprofile or numeric profile URL
          let commenterSteamId = '';
          const rawMini = (authorEl ? authorEl.getAttribute('data-miniprofile') : null)
            || (avatarEl ? avatarEl.getAttribute('data-miniprofile') : null)
            || el.getAttribute('data-miniprofile')
            || '';

          if (rawMini) {
            const trimmedMini = String(rawMini).trim();
            if (/^\d{17}$/.test(trimmedMini)) {
              commenterSteamId = trimmedMini;
            } else if (/^\d{1,10}$/.test(trimmedMini)) {
              try {
                const id64 = (76561197960265728n + BigInt(trimmedMini)).toString();
                if (/^\d{17}$/.test(id64)) {
                  commenterSteamId = id64;
                }
              } catch {}
            }
          }

          if (!commenterSteamId && profileUrl) {
            const match = profileUrl.match(/\/profiles\/(\d{17})/);
            if (match) {
              commenterSteamId = match[1];
            }
          }

          const textEl = el.querySelector('.commentthread_comment_text');
          let content = '';
          if (textEl) {
            const clone = textEl.cloneNode(true);
            const brs = clone.querySelectorAll('br');
            for (const br of brs) {
              br.replaceWith('\n');
            }
            content = (clone.textContent || '').trim();
          }
          const timeEl = el.querySelector('.commentthread_comment_timestamp');
          const timestampStr = timeEl ? timeEl.textContent.trim() : '';

          if (commentId && content && profileUrl) {
            results.push({
              commentId,
              commenterName,
              commenterProfileUrl: profileUrl,
              commenterSteamId,
              content,
              timestampStr
            });
          }
        }
        return results;
      }
    );
  }

  public static async triggerNextPage(page: any): Promise<boolean> {
    try {
      const paged = await page.evaluate(async () => {
        // Method 1: Check window.g_rgCommentThreads for native Steam comment thread instance
        const threads = (window as any).g_rgCommentThreads;
        if (threads) {
          for (const key of Object.keys(threads)) {
            const t = threads[key];
            if (t && typeof t.NextPage === 'function') {
              const prevPage = t.m_iCurrentPage;
              t.NextPage();
              return { triggered: true, prevPage };
            }
          }
        }

        // Method 2: Check pagination buttons in DOM
        const pageBtns = Array.from(document.querySelectorAll('.commentthread_pagelinks .pagebtn'));
        const nextBtn = pageBtns.find((el: any) =>
          el.textContent.includes('>') ||
          el.id.includes('next') ||
          (el.getAttribute('onclick') && el.getAttribute('onclick').includes('NextPage'))
        ) || pageBtns[pageBtns.length - 1];

        if (nextBtn && !nextBtn.classList.contains('disabled')) {
          (nextBtn as HTMLElement).click();
          return { triggered: true };
        }
        return { triggered: false };
      });

      if (!paged || !paged.triggered) {
        return false;
      }

      // Wait briefly for AJAX page response to render
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(1500);
      }
      return true;
    } catch {
      return false;
    }
  }

  public async triggerNextPage(page: any): Promise<boolean> {
    return CommentMonitor.triggerNextPage(page);
  }

  public async fetchComments(lastSeenCommentId?: string, maxCatchup: number = 500): Promise<DiscoveredComment[]> {
    if (!this.myProfileUrl) {
      this.logger.warn('MONITOR_SKIPPED', 'STEAM_PROFILE_URL is not configured');
      return [];
    }

    this.catchupLimitExceeded = false;
    this.lastCatchupStats = {
      fetchedCount: 0,
      pageCount: 1,
      oldestId: null,
      newestId: null
    };

    const page = await this.browserManager.openEphemeralPage();
    try {
      this.logger.info('MONITOR_REFRESHING', {
        profileUrl: this.myProfileUrl,
        lastSeenCommentId: lastSeenCommentId || null,
        maxCatchup,
        reason: 'NEW_CYCLE_POLL'
      });

      // 1. Disable HTTP caching on this request to ensure latest Steam comment state
      try {
        const client = await page.context().newCDPSession(page);
        await client.send('Network.setCacheDisabled', { cacheDisabled: true });
      } catch {
        // Fallback for browsers without direct CDP session support
      }

      // 2. Fresh navigation to Steam profile with cache-busting timestamp parameter
      const freshUrl = this.myProfileUrl.includes('?')
        ? `${this.myProfileUrl}&_t=${Date.now()}`
        : `${this.myProfileUrl}?_t=${Date.now()}`;

      await page.goto(freshUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // 3. Wait for comments container or timeout
      await page.waitForSelector('.commentthread_comments, .profile_comment_area', { timeout: 15000 }).catch(() => {});

      // 4. Wait for comment entries to render if comments are present
      await page.waitForSelector('.commentthread_comment', { timeout: 5000 }).catch(() => {});

      this.logger.info('MONITOR_REFRESHED', {
        profileUrl: this.myProfileUrl,
        url: page.url()
      });

      // 5. Inspect session validity on monitor page
      const sessionCheck = await SteamSessionManager.checkLightweightSession(page);
      this.lastSessionValid = sessionCheck.valid;
      if (!sessionCheck.valid) {
        this.logger.warn('LOGIN_REQUIRED', {
          reason: 'MONITOR_DETECTED_SESSION_INVALID',
          detail: sessionCheck.reason,
          profileUrl: this.myProfileUrl
        });
      } else {
        this.logger.info('MONITOR_SESSION_HEALTHY', {
          profileUrl: this.myProfileUrl,
          steamId: sessionCheck.steamId
        });
      }

      // 6. Page 1 initial comment extraction
      const allComments: DiscoveredComment[] = [];
      const seenIds = new Set<string>();

      const page1Comments = await this.extractCommentsFromPage(page);
      for (const c of page1Comments) {
        if (!seenIds.has(c.commentId)) {
          seenIds.add(c.commentId);
          allComments.push(c);
        }
      }

      let pageCount = 1;

      // 7. Incremental Pagination / Catch-up Loop
      if (lastSeenCommentId && !seenIds.has(lastSeenCommentId)) {
        this.logger.info('MONITOR_CATCHUP_PAGINATING', {
          lastSeenCommentId,
          page1Count: allComments.length
        });

        while (allComments.length < maxCatchup) {
          try {
            const hasNext = await this.triggerNextPage(page);
            if (!hasNext) {
              this.logger.info('MONITOR_PAGINATION_END_REACHED', {
                totalPages: pageCount,
                totalCommentsFetched: allComments.length
              });
              break;
            }

            pageCount++;
            const nextPageComments = await this.extractCommentsFromPage(page);
            if (nextPageComments.length === 0) break;

            let addedThisPage = 0;
            for (const c of nextPageComments) {
              if (!seenIds.has(c.commentId)) {
                seenIds.add(c.commentId);
                allComments.push(c);
                addedThisPage++;
              }
            }

            if (addedThisPage === 0) {
              // No new comments despite pagination; stop loop
              break;
            }

            if (seenIds.has(lastSeenCommentId)) {
              this.logger.info('MONITOR_CATCHUP_CURSOR_REACHED', {
                lastSeenCommentId,
                pagesRead: pageCount,
                totalCommentsFetched: allComments.length
              });
              break;
            }
          } catch (pageErr: any) {
            this.logger.warn('MONITOR_PAGINATION_NETWORK_ERROR', {
              error: pageErr.message || String(pageErr),
              pagesRead: pageCount,
              commentsFetchedSoFar: allComments.length
            });
            break;
          }
        }
      }

      // Check safety cap
      if (allComments.length >= maxCatchup && lastSeenCommentId && !seenIds.has(lastSeenCommentId)) {
        this.catchupLimitExceeded = true;
        this.logger.warn('CATCHUP_LIMIT_EXCEEDED', {
          lastSeenCommentId,
          fetchedCount: allComments.length,
          pageCount,
          oldestFetchedCommentId: allComments[allComments.length - 1]?.commentId || null,
          newestFetchedCommentId: allComments[0]?.commentId || null,
          maxCatchup
        });
      }

      // Record telemetry
      this.lastCatchupStats = {
        fetchedCount: allComments.length,
        pageCount,
        oldestId: allComments[allComments.length - 1]?.commentId || null,
        newestId: allComments[0]?.commentId || null
      };

      // 8. Truncate comments at lastSeenCommentId if found
      let finalComments = allComments;
      if (lastSeenCommentId && seenIds.has(lastSeenCommentId)) {
        const lastIdx = allComments.findIndex(c => c.commentId === lastSeenCommentId);
        if (lastIdx >= 0) {
          // Keep only comments newer than lastSeenCommentId
          finalComments = allComments.slice(0, lastIdx);
        }
      } else if (allComments.length > maxCatchup) {
        finalComments = allComments.slice(0, maxCatchup);
      }

      this.logger.info('MONITOR_FETCHED', {
        count: finalComments.length,
        commentIds: finalComments.map(c => c.commentId),
        latestCommentId: finalComments.length > 0 ? finalComments[0].commentId : null,
        latestAuthor: finalComments.length > 0 ? finalComments[0].commenterName : null,
        pageCount,
        catchupLimitExceeded: this.catchupLimitExceeded
      });

      return finalComments;
    } catch (e: any) {
      this.logger.error('MONITOR_FETCH_ERROR', e.message);
      return [];
    } finally {
      try {
        await page.close();
      } catch {
        // Ignore
      }
    }
  }
}
