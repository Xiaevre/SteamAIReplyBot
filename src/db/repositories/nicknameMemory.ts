import { AppDatabase } from '../database';

export interface NicknameMemoryRecord {
  steam_id: string;
  original_name: string;
  preferred_name: string;
  source: string;
  confidence: number;
  updated_at: string;
}

export class NicknameMemoryRepository {
  constructor(private db: AppDatabase) {}

  public findBySteamId(steamId: string): NicknameMemoryRecord | undefined {
    try {
      return this.db
        .prepare('SELECT * FROM nickname_memory WHERE steam_id = ?')
        .get(steamId) as NicknameMemoryRecord | undefined;
    } catch {
      return undefined;
    }
  }

  public save(data: {
    steamId: string;
    originalName: string;
    preferredName: string;
    source?: string;
    confidence?: number;
  }): void {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO nickname_memory (
          steam_id, original_name, preferred_name, source, confidence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(steam_id) DO UPDATE SET
          original_name = excluded.original_name,
          preferred_name = excluded.preferred_name,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `).run(
        data.steamId,
        data.originalName,
        data.preferredName,
        data.source || 'local_rule',
        data.confidence ?? 1.0,
        now
      );
    } catch (e: any) {
      console.warn('[NicknameMemoryRepo] Failed to save nickname memory:', e.message);
    }
  }

  public setPreferredName(steamId: string, preferredName: string): void {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        UPDATE nickname_memory
        SET preferred_name = ?,
            source = 'user_override',
            updated_at = ?
        WHERE steam_id = ?
      `).run(preferredName, now, steamId);
    } catch (e: any) {
      console.warn('[NicknameMemoryRepo] Failed to set preferred name:', e.message);
    }
  }
}
