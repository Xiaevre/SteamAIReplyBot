import * as crypto from 'crypto';
import { SteamProfileData, SteamGameHistory, ProfileVisualSnapshot } from './types';

export class ProfileSnapshotFingerprint {
  /**
   * Computes a deterministic SHA-256 fingerprint across profile, game, and visual snapshots.
   */
  public static compute(
    profile: SteamProfileData,
    games: SteamGameHistory,
    visual?: ProfileVisualSnapshot
  ): string {
    const showcasesNormalized = (profile.showcases || []).map(s => ({
      type: s.type || '',
      title: s.title || '',
      itemCount: s.items ? s.items.length : 0,
      itemTexts: (s.items || []).map(i => `${i.title || ''}:${i.text || ''}`).join('|')
    }));

    const topGamesNormalized = (games.topPlayedGames || []).slice(0, 15).map(g => ({
      name: g.name || '',
      hours: Math.round(g.hours || 0)
    }));

    const recentGamesNormalized = (games.recentActiveGames || []).map(g => ({
      name: g.name || '',
      hoursTwoWeeks: Math.round(g.hoursTwoWeeks || 0)
    }));

    const payload = {
      steamId: profile.steamId || '',
      personaName: (profile.personaName || '').trim(),
      level: profile.level || 0,
      summary: (profile.summary || '').trim(),
      avatarUrl: (profile.avatarUrl || '').trim(),
      backgroundUrl: (profile.backgroundUrl || '').trim(),
      showcases: showcasesNormalized,
      topGames: topGamesNormalized,
      recentGames: recentGamesNormalized,
      visualHashes: visual?.screenshotHashes || []
    };

    const serialized = JSON.stringify(payload);
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
  }
}
