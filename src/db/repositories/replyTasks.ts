import { AppDatabase } from '../database';

export interface ReplyTaskRecord {
  id?: number;
  task_id: string;
  steam_comment_id: string;
  target_steam_id: string;
  target_profile_url: string;
  reply_text: string;
  status: string; // 'scheduled' | 'waiting' | 'sending' | 'replied' | 'skipped' | 'failed' | 'uncertain_send_state' | 'UNCERTAIN_VERIFY_PENDING' | 'UNCERTAIN_VERIFYING' | 'UNCERTAIN_DELAYED_RECHECK' | 'UNCERTAIN_FINAL' | 'SAFE_TO_RESEND'
  scheduled_at: string;
  started_at?: string;
  completed_at?: string;
  attempt_count: number;
  transport_retry_count?: number;
  uncertain_resend_count?: number;
  uncertain_verify_count?: number;
  uncertain_last_checked_at?: string;
  reply_fingerprint?: string;
  created_at: string;
}

export class ReplyTasksRepository {
  constructor(private db: AppDatabase) {}

  public findByCommentId(commentId: string): ReplyTaskRecord | undefined {
    return this.db
      .prepare('SELECT * FROM reply_tasks WHERE steam_comment_id = ?')
      .get(commentId) as ReplyTaskRecord | undefined;
  }

  public findByTaskId(taskId: string): ReplyTaskRecord | undefined {
    return this.db
      .prepare('SELECT * FROM reply_tasks WHERE task_id = ?')
      .get(taskId) as ReplyTaskRecord | undefined;
  }

  public insert(task: Omit<ReplyTaskRecord, 'id'>): number | bigint {
    const stmt = this.db.prepare(`
      INSERT INTO reply_tasks (
        task_id, steam_comment_id, target_steam_id, target_profile_url,
        reply_text, status, scheduled_at, started_at, completed_at,
        attempt_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      task.task_id,
      task.steam_comment_id,
      task.target_steam_id,
      task.target_profile_url,
      task.reply_text,
      task.status,
      task.scheduled_at,
      task.started_at || null,
      task.completed_at || null,
      task.attempt_count ?? 0,
      task.created_at
    );

    return res.lastInsertRowid;
  }

  public updateStatus(
    taskId: string,
    status: string,
    extra?: {
      started_at?: string;
      completed_at?: string;
      attempt_count?: number;
      scheduled_at?: string;
      transport_retry_count?: number;
      uncertain_resend_count?: number;
      uncertain_verify_count?: number;
      uncertain_last_checked_at?: string;
      reply_fingerprint?: string;
    }
  ): void {
    let query = 'UPDATE reply_tasks SET status = ?';
    const params: any[] = [status];

    if (extra?.started_at !== undefined) {
      query += ', started_at = ?';
      params.push(extra.started_at);
    }
    if (extra?.completed_at !== undefined) {
      query += ', completed_at = ?';
      params.push(extra.completed_at);
    }
    if (extra?.attempt_count !== undefined) {
      query += ', attempt_count = ?';
      params.push(extra.attempt_count);
    }
    if (extra?.scheduled_at !== undefined) {
      query += ', scheduled_at = ?';
      params.push(extra.scheduled_at);
    }
    if (extra?.transport_retry_count !== undefined) {
      query += ', transport_retry_count = ?';
      params.push(extra.transport_retry_count);
    }
    if (extra?.uncertain_resend_count !== undefined) {
      query += ', uncertain_resend_count = ?';
      params.push(extra.uncertain_resend_count);
    }
    if (extra?.uncertain_verify_count !== undefined) {
      query += ', uncertain_verify_count = ?';
      params.push(extra.uncertain_verify_count);
    }
    if (extra?.uncertain_last_checked_at !== undefined) {
      query += ', uncertain_last_checked_at = ?';
      params.push(extra.uncertain_last_checked_at);
    }
    if (extra?.reply_fingerprint !== undefined) {
      query += ', reply_fingerprint = ?';
      params.push(extra.reply_fingerprint);
    }

    query += ' WHERE task_id = ?';
    params.push(taskId);

    this.db.prepare(query).run(...params);
  }

  public getPendingScheduledTasks(beforeIso: string): ReplyTaskRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM reply_tasks WHERE status IN ('scheduled', 'waiting') AND scheduled_at <= ? ORDER BY attempt_count ASC, scheduled_at ASC"
      )
      .all(beforeIso) as ReplyTaskRecord[];
  }

  public getOldestPendingTask(): ReplyTaskRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM reply_tasks WHERE status IN ('scheduled', 'waiting') ORDER BY scheduled_at ASC LIMIT 1"
      )
      .get() as ReplyTaskRecord | undefined;
  }

  public getUnfinishedSendingTasks(): ReplyTaskRecord[] {
    return this.db
      .prepare("SELECT * FROM reply_tasks WHERE status = 'sending'")
      .all() as ReplyTaskRecord[];
  }

  public getUncertainTasks(limit: number = 3): ReplyTaskRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM reply_tasks WHERE status IN ('uncertain_send_state', 'UNCERTAIN_VERIFY_PENDING', 'UNCERTAIN_DELAYED_RECHECK') ORDER BY id ASC LIMIT ?"
      )
      .all(limit) as ReplyTaskRecord[];
  }

  public getUncertainTasksCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM reply_tasks WHERE status IN ('uncertain_send_state', 'UNCERTAIN_VERIFY_PENDING', 'UNCERTAIN_DELAYED_RECHECK')"
      )
      .get() as { count: number } | undefined;
    return row?.count || 0;
  }

  public getModerationPendingTasks(limit: number = 3): ReplyTaskRecord[] {
    return this.db
      .prepare("SELECT * FROM reply_tasks WHERE status = 'submitted_moderation_pending' ORDER BY id ASC LIMIT ?")
      .all(limit) as ReplyTaskRecord[];
  }

  public getModerationPendingTasksCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM reply_tasks WHERE status = 'submitted_moderation_pending'")
      .get() as { count: number } | undefined;
    return row?.count || 0;
  }

  public cancelAllPendingTasks(): number {
    const res = this.db
      .prepare(
        "UPDATE reply_tasks SET status = 'skipped', completed_at = ? WHERE status IN ('scheduled', 'waiting')"
      )
      .run(new Date().toISOString());
    return res.changes;
  }

  public getWaitingForLoginTasks(): ReplyTaskRecord[] {
    return this.db
      .prepare("SELECT * FROM reply_tasks WHERE status = 'waiting_for_login'")
      .all() as ReplyTaskRecord[];
  }

  public getWaitingForLoginTasksCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM reply_tasks WHERE status = 'waiting_for_login'")
      .get() as { count: number } | undefined;
    return row?.count || 0;
  }

  public resumeWaitingForLoginTasks(): number {
    const res = this.db
      .prepare("UPDATE reply_tasks SET status = 'waiting' WHERE status = 'waiting_for_login'")
      .run();
    return res.changes;
  }

  public getRepliesSentCount(sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM reply_tasks WHERE status = 'replied' AND completed_at >= ?")
      .get(sinceIso) as { count: number } | undefined;
    return row?.count || 0;
  }

  public getRecentTasksDetailed(limit: number = 50, statusFilter?: string): any[] {
    let query = `
      SELECT 
        rt.id,
        rt.task_id,
        rt.steam_comment_id,
        rt.target_steam_id,
        rt.target_profile_url,
        rt.reply_text,
        rt.status as task_status,
        rt.scheduled_at,
        rt.started_at,
        rt.completed_at,
        rt.attempt_count,
        rt.created_at,
        c.commenter_name,
        c.content as comment_content,
        c.classification,
        c.reply_source,
        c.error_message
      FROM reply_tasks rt
      LEFT JOIN comments c ON rt.steam_comment_id = c.steam_comment_id
    `;
    const params: any[] = [];
    if (statusFilter && statusFilter !== 'all') {
      query += ` WHERE rt.status = ?`;
      params.push(statusFilter);
    }
    query += ` ORDER BY rt.created_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(query).all(...params);
  }

  public getTotalCount(): number {
    try {
      const row = this.db.prepare('SELECT count(*) as c FROM reply_tasks').get() as any;
      return row ? row.c : 0;
    } catch {
      return 0;
    }
  }
}
