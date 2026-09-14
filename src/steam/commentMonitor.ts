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

  public async fetchComments(): Promise<DiscoveredComment[]> {
    if (!this.myProfileUrl) {
      this.logger.warn('MONITOR_SKIPPED', 'STEAM_PROFILE_URL is not configured');
      return [];
    }

    const page = await this.browserManager.openEphemeralPage();
    try {
      this.logger.info('MONITOR_REFRESHING', {
        profileUrl: this.myProfileUrl,
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

      const comments: DiscoveredComment[] = await page.$$eval(
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

            // Extract steamid from miniprofile (author link, avatar link, or comment container) or numeric profile URL
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
                  // Steam 32-bit AccountID to 64-bit SteamID: 76561197960265728n + BigInt(accountID)
                  const id64 = (76561197960265728n + BigInt(trimmedMini)).toString();
                  if (/^\d{17}$/.test(id64)) {
                    commenterSteamId = id64;
                  }
                } catch {
                  // ignore
                }
              }
            }

            if (!commenterSteamId && profileUrl) {
              const match = profileUrl.match(/\/profiles\/(\d{17})/);
              if (match) {
                commenterSteamId = match[1];
              }
            }
            // CRITICAL: If profileUrl is a vanity URL (/id/xxxxx), do NOT assign the vanity name to commenterSteamId!
            // If commenterSteamId is empty or vanity, CommentSender safely resolves the 17-digit numeric SteamID64 from the profile page DOM.

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

      this.logger.info('MONITOR_FETCHED', {
        count: comments.length,
        commentIds: comments.map(c => c.commentId),
        latestCommentId: comments.length > 0 ? comments[0].commentId : null,
        latestAuthor: comments.length > 0 ? comments[0].commenterName : null
      });
      return comments;
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
