import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { SteamBrowserManager } from '../steam/browser';
import { Logger } from '../utils/logger';
import {
  FullProfileSnapshot,
  SteamProfileData,
  SteamGameHistory,
  ProfileVisualSnapshot,
  ProfileShowcase,
  ShowcaseItem,
  PlayedGameRecord,
  RecentGameRecord
} from './types';
import { ProfileSnapshotFingerprint } from './fingerprint';

export interface CollectorOptions {
  captureVisual?: boolean;
  assetsDir?: string;
}

export class SteamProfileCollector {
  constructor(
    private browserManager: SteamBrowserManager,
    private logger: Logger,
    private options: CollectorOptions = {}
  ) {}

  /**
   * Reads and extracts the bot owner's own Steam Profile, DIY styles, showcase metadata, and game history.
   * Completely read-only, non-destructive, and reuses the active authenticated browser context.
   */
  public async collectSelfProfile(knownSteamId?: string): Promise<FullProfileSnapshot> {
    this.logger.info('PROFILE_COLLECTOR_STARTED', { knownSteamId });
    const page = await this.browserManager.openEphemeralPage();

    try {
      // 1. Navigate to /my to establish same-origin context and resolve vanity URL / steamID
      this.logger.info('PROFILE_COLLECTOR_NAVIGATING_PROFILE', { url: 'https://steamcommunity.com/my' });
      await page.goto('https://steamcommunity.com/my', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Extract raw Profile Data from DOM
      const profileData: SteamProfileData = await page.evaluate((fallbackId?: string) => {
        const steamId =
          (window as any).g_steamID ||
          (window as any).g_rgProfileData?.steamid ||
          fallbackId ||
          '';

        const personaName =
          document.querySelector('.actual_persona_name')?.textContent?.trim() ||
          document.querySelector('.persona_name .actual_persona_name')?.textContent?.trim() ||
          'Steam User';

        const realName =
          document.querySelector('.header_real_name')?.textContent?.trim() || undefined;

        const customUrl = (window as any).g_rgProfileData?.url || window.location.href;

        const avatarImg = document.querySelector('.playerAvatar img, .playerAvatarAutoSizeInner img') as HTMLImageElement;
        const avatarUrl = avatarImg ? avatarImg.src : '';

        const levelText = document.querySelector('.persona_level, .persona_name .badge_info')?.textContent?.trim() || '0';
        const levelMatch = levelText.match(/\d+/);
        const level = levelMatch ? parseInt(levelMatch[0], 10) : 0;

        const summary =
          document.querySelector('.profile_summary')?.textContent?.trim() ||
          document.querySelector('.profile_summary_footer')?.textContent?.trim() ||
          '';

        // Background styling
        let backgroundUrl = '';
        const bgEl = document.querySelector('.no_header.profile_page, .profile_background_holder_content, .profile_animated_background') as HTMLElement;
        if (bgEl) {
          const style = window.getComputedStyle(bgEl);
          const bgImg = style.backgroundImage || '';
          const m = bgImg.match(/url\(["']?([^"']+)["']?\)/);
          if (m) backgroundUrl = m[1];
        }

        // Showcases (DIY area)
        const showcases: Array<{ type: string; title: string; items: Array<{ title?: string; text?: string; imageUrl?: string }> }> = [];
        const showcaseEls = document.querySelectorAll('.profile_customization_area .profile_customization');
        showcaseEls.forEach(el => {
          const title = el.querySelector('.profile_customization_header')?.textContent?.trim() || 'Showcase';
          const items: Array<{ title?: string; text?: string; imageUrl?: string }> = [];

          // Artwork / screenshot / badge slots
          el.querySelectorAll('.showcase_slot, .screenshot_showcase_item, .favoritegame_showcase, .badge_info').forEach(slot => {
            const itemTitle = slot.querySelector('.showcase_item_title, .title, a')?.textContent?.trim();
            const itemText = slot.querySelector('.showcase_item_description, .description, .badge_name')?.textContent?.trim();
            const img = slot.querySelector('img') as HTMLImageElement;
            items.push({
              title: itemTitle || undefined,
              text: itemText || undefined,
              imageUrl: img ? img.src : undefined
            });
          });

          showcases.push({
            type: el.className.replace('profile_customization', '').trim() || 'generic',
            title,
            items: items.slice(0, 10)
          });
        });

        // Detect custom symbols in summary
        const customSymbols: string[] = [];
        const symbolMatches = summary.match(/[\p{Extended_Pictographic}\u2600-\u27BF\u2800-\u28FF\u3040-\u30FF]/gu);
        if (symbolMatches) {
          symbolMatches.slice(0, 20).forEach(s => {
            if (!customSymbols.includes(s)) customSymbols.push(s);
          });
        }

        // Language detection hint
        const languagesDetected: string[] = [];
        if (/[\u4e00-\u9fa5]/.test(summary)) languagesDetected.push('zh');
        if (/[\u3040-\u30ff]/.test(summary)) languagesDetected.push('ja');
        if (/[a-zA-Z]{4,}/.test(summary)) languagesDetected.push('en');

        // Recent Games visible on main profile page
        const recentGames: Array<{ name: string; hoursTwoWeeks?: number; hoursTotal?: number; appId?: string }> = [];
        document.querySelectorAll('.recent_games .recent_game').forEach(gameEl => {
          const name = gameEl.querySelector('.game_name a')?.textContent?.trim();
          if (name) {
            const detailsText = gameEl.querySelector('.game_info_details')?.textContent || '';
            const hours2wMatch = detailsText.match(/([\d.,]+)\s*(?:hrs|小时|h)/i);
            const hoursTotalMatch = detailsText.match(/(?:总计|total|on record)\s*([\d.,]+)/i);
            const link = gameEl.querySelector('.game_name a') as HTMLAnchorElement;
            const appMatch = link ? link.href.match(/app\/(\d+)/) : null;

            recentGames.push({
              name,
              hoursTwoWeeks: hours2wMatch ? parseFloat(hours2wMatch[1].replace(',', '')) : undefined,
              hoursTotal: hoursTotalMatch ? parseFloat(hoursTotalMatch[1].replace(',', '')) : undefined,
              appId: appMatch ? appMatch[1] : undefined
            });
          }
        });

        return {
          steamId,
          personaName,
          realName,
          customUrl,
          avatarUrl,
          level,
          summary,
          backgroundUrl,
          showcases,
          customSymbols,
          languagesDetected,
          recentGames,
          replaySummary: 'unavailable'
        };
      }, knownSteamId).catch((err: any) => {
        this.logger.warn('PROFILE_COLLECTOR_EVAL_ERROR', err.message);
        return {
          steamId: knownSteamId || '',
          personaName: 'Steam User',
          avatarUrl: '',
          summary: '',
          showcases: [],
          customSymbols: [],
          languagesDetected: [],
          recentGames: [],
          replaySummary: 'unavailable'
        } as SteamProfileData;
      });

      // 2. Collect Games library data via resolved /games/?tab=all or /my/games/?tab=all
      let gamesUrl = 'https://steamcommunity.com/my/games/?tab=all';
      if (profileData.customUrl && profileData.customUrl.startsWith('http') && !profileData.customUrl.includes('/my')) {
        gamesUrl = `${profileData.customUrl.replace(/\/+$/, '')}/games/?tab=all`;
      }

      this.logger.info('PROFILE_COLLECTOR_NAVIGATING_GAMES', { url: gamesUrl });
      await page.goto(gamesUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }).catch((e: any) => {
        this.logger.warn('PROFILE_COLLECTOR_GAMES_NAV_WARN', { error: e.message });
      });

      // Allow scripts to run and populate rgGames / render game rows
      if (typeof (page as any).waitForLoadState === 'function') {
        await (page as any).waitForLoadState('load').catch(() => {});
      }
      if (typeof (page as any).waitForTimeout === 'function') {
        await (page as any).waitForTimeout(1500).catch(() => {});
      }

      const gamesHistory: SteamGameHistory = await page.evaluate((fallbackRecent: RecentGameRecord[]) => {
        const topPlayedGames: PlayedGameRecord[] = [];
        const recentActiveGames: RecentGameRecord[] = [];

        // Strategy A: Window global variable rgGames or g_rgGames
        let rawGames: any[] | null = null;
        if (Array.isArray((window as any).rgGames) && (window as any).rgGames.length > 0) {
          rawGames = (window as any).rgGames;
        } else if (Array.isArray((window as any).g_rgGames) && (window as any).g_rgGames.length > 0) {
          rawGames = (window as any).g_rgGames;
        }

        // Strategy B: Inline <script> tag containing var rgGames = [...]
        if (!rawGames || rawGames.length === 0) {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes('rgGames')) {
              const m = text.match(/var\s+rgGames\s*=\s*(\[\s*\{[\s\S]*?\}\s*\]);/);
              if (m) {
                try {
                  const parsed = JSON.parse(m[1]);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    rawGames = parsed;
                    break;
                  }
                } catch {}
              }
            }
          }
        }

        // Process raw games if available (from Strategy A or B)
        if (Array.isArray(rawGames) && rawGames.length > 0) {
          const sorted = [...rawGames].sort((a, b) => {
            const hA = parseFloat(String(a.hours_forever || '0').replace(/,/g, '')) || 0;
            const hB = parseFloat(String(b.hours_forever || '0').replace(/,/g, '')) || 0;
            return hB - hA;
          });

          sorted.slice(0, 30).forEach(g => {
            const hours = parseFloat(String(g.hours_forever || '0').replace(/,/g, '')) || 0;
            topPlayedGames.push({
              name: g.name || 'Unknown Game',
              hours,
              appId: String(g.appid || ''),
              lastPlayed: g.last_played ? new Date(g.last_played * 1000).toISOString() : undefined
            });
          });

          rawGames.filter(g => g.hours_2weeks).forEach(g => {
            recentActiveGames.push({
              name: g.name || 'Unknown Game',
              hoursTwoWeeks: parseFloat(String(g.hours_2weeks || '0').replace(/,/g, '')) || 0,
              appId: String(g.appid || '')
            });
          });

          return {
            totalGames: rawGames.length,
            topPlayedGames,
            recentActiveGames
          };
        }

        // Strategy C: DOM game rows (Legacy & Modern responsive layout selectors)
        const rowSelectors = [
          '.gameListRow',
          '[id^="game_"]',
          '.games_list_row',
          '[class*="gameslistitems_GameRow"]',
          '[class*="game_list_row"]'
        ];
        const rows = document.querySelectorAll(rowSelectors.join(', '));
        rows.forEach(r => {
          const nameEl = r.querySelector(
            '.gameListRowItemName, [class*="GameName"], [class*="game_name"], .game_name a, .title'
          );
          const name = nameEl?.textContent?.trim();

          const hoursEl = r.querySelector(
            '.hours_played, [class*="hours_played"], [class*="HoursPlayed"], [class*="playtime"], .hours'
          );
          const hoursText = hoursEl?.textContent?.trim() || '';
          const match = hoursText.match(/([\d.,]+)/);
          const hours = match ? parseFloat(match[1].replace(/,/g, '')) : 0;

          if (name) {
            topPlayedGames.push({ name, hours });
          }
        });

        if (topPlayedGames.length > 0) {
          return {
            totalGames: rows.length || topPlayedGames.length,
            topPlayedGames: topPlayedGames.sort((a, b) => b.hours - a.hours).slice(0, 20),
            recentActiveGames
          };
        }

        // Strategy D: Fallback to profile page recentGames if games tab returned 0 games
        if (Array.isArray(fallbackRecent) && fallbackRecent.length > 0) {
          return {
            totalGames: fallbackRecent.length,
            topPlayedGames: fallbackRecent.map(g => ({
              name: g.name,
              hours: g.hoursTotal || g.hoursTwoWeeks || 0,
              appId: g.appId
            })),
            recentActiveGames: fallbackRecent
          };
        }

        return {
          totalGames: 0,
          topPlayedGames: [],
          recentActiveGames: []
        };
      }, profileData.recentGames).catch(() => ({
        totalGames: profileData.recentGames.length,
        topPlayedGames: profileData.recentGames.map(g => ({
          name: g.name,
          hours: g.hoursTotal || g.hoursTwoWeeks || 0,
          appId: g.appId
        })),
        recentActiveGames: profileData.recentGames
      }));

      // 3. Collect Profile Visual Snapshot (if enabled)
      const visualSnapshot: ProfileVisualSnapshot = {
        visualSummary: {
          colorSchemeEstimate: profileData.backgroundUrl ? 'custom_theme' : 'default_dark',
          aestheticTone: profileData.showcases.length > 0 ? 'custom_curated' : 'minimalist',
          hasAnimatedBackground: (profileData.backgroundUrl || '').includes('.webm') || (profileData.backgroundUrl || '').includes('.mp4'),
          hasCustomArtwork: profileData.showcases.some(s => s.title.includes('艺术') || s.title.toLowerCase().includes('artwork')),
          badgeCount: profileData.level
        },
        screenshotHashes: []
      };

      if (this.options.captureVisual && this.options.assetsDir) {
        try {
          // Re-visit main profile for screenshot captures
          await page.goto('https://steamcommunity.com/my', { waitUntil: 'domcontentloaded', timeout: 20000 });
          const headerEl = await page.$('.profile_header_centered, .profile_header');
          if (headerEl) {
            const headerBuf = await headerEl.screenshot();
            const hHash = crypto.createHash('sha256').update(headerBuf).digest('hex').substring(0, 16);
            const headerFile = path.join(this.options.assetsDir, `header_${hHash}.png`);
            fs.writeFileSync(headerFile, headerBuf);
            visualSnapshot.headerScreenshotPath = headerFile;
            visualSnapshot.screenshotHashes.push(hHash);
          }

          const showcaseEl = await page.$('.profile_customization_area');
          if (showcaseEl) {
            const showcaseBuf = await showcaseEl.screenshot();
            const sHash = crypto.createHash('sha256').update(showcaseBuf).digest('hex').substring(0, 16);
            const showcaseFile = path.join(this.options.assetsDir, `showcase_${sHash}.png`);
            fs.writeFileSync(showcaseFile, showcaseBuf);
            visualSnapshot.showcaseScreenshotPath = showcaseFile;
            visualSnapshot.screenshotHashes.push(sHash);
          }
        } catch (visErr: any) {
          this.logger.warn('PROFILE_VISUAL_CAPTURE_SKIPPED', visErr.message);
        }
      }

      // Compute deterministic fingerprint
      const fingerprint = ProfileSnapshotFingerprint.compute(profileData, gamesHistory, visualSnapshot);

      const snapshot: FullProfileSnapshot = {
        version: '1.0',
        capturedAt: new Date().toISOString(),
        fingerprint,
        profile: profileData,
        games: gamesHistory,
        visual: visualSnapshot
      };

      this.logger.info('PROFILE_COLLECTOR_COMPLETED', {
        steamId: profileData.steamId,
        personaName: profileData.personaName,
        totalGames: gamesHistory.totalGames,
        showcasesCount: profileData.showcases.length,
        fingerprint
      });

      return snapshot;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
