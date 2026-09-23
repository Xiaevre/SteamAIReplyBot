import { AppDatabase } from '../database';

export interface MonitorStateRecord {
  id: number;
  last_seen_comment_id: string | null;
  updated_at: string;
}

export class MonitorStateRepository {
  constructor(private db: AppDatabase) {}

  public getLastSeenCommentId(): string | null {
    try {
      const row = this.db
        .prepare('SELECT last_seen_comment_id FROM comment_monitor_state WHERE id = 1')
        .get() as { last_seen_comment_id: string | null } | undefined;
      return row ? row.last_seen_comment_id : null;
    } catch {
      return null;
    }
  }

  public setLastSeenCommentId(commentId: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO comment_monitor_state (id, last_seen_comment_id, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_comment_id = excluded.last_seen_comment_id,
           updated_at = excluded.updated_at`
      )
      .run(commentId, now);
  }
}
