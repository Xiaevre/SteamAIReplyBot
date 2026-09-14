import { AppDatabase } from '../database';

export interface HolidayMessageRecord {
  id?: number;
  holiday_id: string;
  steam_id: string;
  profile_url: string;
  message: string;
  status: string; // 'scheduled' | 'sent' | 'skipped' | 'failed'
  scheduled_at: string;
  sent_at?: string;
  created_at: string;
}

export class HolidayRepository {
  constructor(private db: AppDatabase) {}

  public findExisting(holidayId: string, steamId: string): HolidayMessageRecord | undefined {
    return this.db
      .prepare('SELECT * FROM holiday_messages WHERE holiday_id = ? AND steam_id = ?')
      .get(holidayId, steamId) as HolidayMessageRecord | undefined;
  }

  public insert(record: Omit<HolidayMessageRecord, 'id'>): number | bigint {
    const res = this.db.prepare(`
      INSERT INTO holiday_messages (
        holiday_id, steam_id, profile_url, message, status, scheduled_at, sent_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.holiday_id,
      record.steam_id,
      record.profile_url,
      record.message,
      record.status,
      record.scheduled_at,
      record.sent_at || null,
      record.created_at
    );
    return res.lastInsertRowid;
  }

  public getCountSentToday(todayPrefix: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM holiday_messages WHERE status = 'sent' AND sent_at >= ?")
      .get(todayPrefix + 'T00:00:00.000Z') as { count: number } | undefined;
    return row?.count || 0;
  }

  public getPendingScheduled(beforeIso: string): HolidayMessageRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM holiday_messages WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC"
      )
      .all(beforeIso) as HolidayMessageRecord[];
  }

  public markSent(id: number): void {
    this.db.prepare("UPDATE holiday_messages SET status = 'sent', sent_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id
    );
  }
}
