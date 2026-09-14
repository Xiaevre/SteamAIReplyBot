import { AppDatabase } from '../database';

export interface InteractionUserRecord {
  steam_id: string;
  profile_url: string;
  display_name?: string;
  first_seen_at: string;
  last_interaction_at: string;
  interaction_count: number;
  language?: string;
  spam_count: number;
  replied_count: number;
  blacklisted: number;
}

export class InteractionUsersRepository {
  constructor(private db: AppDatabase) {}

  public findBySteamId(steamId: string): InteractionUserRecord | undefined {
    return this.db
      .prepare('SELECT * FROM interaction_users WHERE steam_id = ?')
      .get(steamId) as InteractionUserRecord | undefined;
  }

  public recordInteraction(data: {
    steamId: string;
    profileUrl: string;
    displayName?: string;
    language?: string;
    isSpam?: boolean;
    isReplied?: boolean;
  }): void {
    const now = new Date().toISOString();
    const existing = this.findBySteamId(data.steamId);

    if (!existing) {
      this.db.prepare(`
        INSERT INTO interaction_users (
          steam_id, profile_url, display_name, first_seen_at, last_interaction_at,
          interaction_count, language, spam_count, replied_count, blacklisted
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0)
      `).run(
        data.steamId,
        data.profileUrl,
        data.displayName || '',
        now,
        now,
        data.language || '',
        data.isSpam ? 1 : 0,
        data.isReplied ? 1 : 0
      );
    } else {
      this.db.prepare(`
        UPDATE interaction_users
        SET profile_url = ?,
            display_name = COALESCE(NULLIF(?, ''), display_name),
            last_interaction_at = ?,
            interaction_count = interaction_count + 1,
            language = COALESCE(NULLIF(?, ''), language),
            spam_count = spam_count + ?,
            replied_count = replied_count + ?
        WHERE steam_id = ?
      `).run(
        data.profileUrl,
        data.displayName || '',
        now,
        data.language || '',
        data.isSpam ? 1 : 0,
        data.isReplied ? 1 : 0,
        data.steamId
      );
    }
  }

  public getEligibleHolidayUsers(sinceIso: string, limit: number): InteractionUserRecord[] {
    return this.db
      .prepare(`
        SELECT * FROM interaction_users
        WHERE last_interaction_at >= ?
          AND blacklisted = 0
          AND spam_count = 0
        ORDER BY last_interaction_at DESC
        LIMIT ?
      `)
      .all(sinceIso, limit) as InteractionUserRecord[];
  }
}
