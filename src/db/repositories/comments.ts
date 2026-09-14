import { AppDatabase } from '../database';
import * as crypto from 'crypto';

export interface CommentRecord {
  id?: number;
  steam_comment_id: string;
  commenter_steam_id: string;
  commenter_name?: string;
  commenter_profile_url: string;
  content: string;
  content_hash?: string;
  language?: string;
  classification?: string;
  classification_confidence?: number;
  reply_source?: string;
  reply?: string;
  status: string; // 'detected' | 'classified' | 'waiting' | 'generating' | 'generated' | 'sending' | 'replied' | 'skipped' | 'failed' | 'uncertain_send_state'
  created_at: string;
  updated_at: string;
  replied_at?: string;
  error_message?: string;
}

export class CommentsRepository {
  constructor(private db: AppDatabase) {}

  public static computeHash(content: string): string {
    return crypto.createHash('sha256').update(content.trim()).digest('hex');
  }

  public findByCommentId(commentId: string): CommentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM comments WHERE steam_comment_id = ?')
      .get(commentId) as CommentRecord | undefined;
  }

  public insert(comment: Omit<CommentRecord, 'id'>): number | bigint {
    const hash = comment.content_hash || CommentsRepository.computeHash(comment.content);
    const stmt = this.db.prepare(`
      INSERT INTO comments (
        steam_comment_id, commenter_steam_id, commenter_name, commenter_profile_url,
        content, content_hash, language, classification, classification_confidence,
        reply_source, reply, status, created_at, updated_at, replied_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      comment.steam_comment_id,
      comment.commenter_steam_id,
      comment.commenter_name || '',
      comment.commenter_profile_url,
      comment.content,
      hash,
      comment.language || '',
      comment.classification || '',
      comment.classification_confidence ?? 0,
      comment.reply_source || '',
      comment.reply || '',
      comment.status,
      comment.created_at,
      comment.updated_at,
      comment.replied_at || null,
      comment.error_message || null
    );

    return res.lastInsertRowid;
  }

  public updateStatus(
    commentId: string,
    status: string,
    extra?: { reply?: string; reply_source?: string; error_message?: string; replied_at?: string }
  ): void {
    const now = new Date().toISOString();
    let query = 'UPDATE comments SET status = ?, updated_at = ?';
    const params: any[] = [status, now];

    if (extra?.reply !== undefined) {
      query += ', reply = ?';
      params.push(extra.reply);
    }
    if (extra?.reply_source !== undefined) {
      query += ', reply_source = ?';
      params.push(extra.reply_source);
    }
    if (extra?.error_message !== undefined) {
      query += ', error_message = ?';
      params.push(extra.error_message);
    }
    if (extra?.replied_at !== undefined) {
      query += ', replied_at = ?';
      params.push(extra.replied_at);
    }

    query += ' WHERE steam_comment_id = ?';
    params.push(commentId);

    this.db.prepare(query).run(...params);
  }

  public updateContentAndStatus(
    commentId: string,
    content: string,
    status: string,
    extra?: {
      classification?: string;
      classification_confidence?: number;
      reply?: string;
      reply_source?: string;
      language?: string;
      error_message?: string;
    }
  ): void {
    const now = new Date().toISOString();
    const hash = CommentsRepository.computeHash(content);
    let query = 'UPDATE comments SET content = ?, content_hash = ?, status = ?, updated_at = ?';
    const params: any[] = [content, hash, status, now];

    if (extra?.classification !== undefined) {
      query += ', classification = ?';
      params.push(extra.classification);
    }
    if (extra?.classification_confidence !== undefined) {
      query += ', classification_confidence = ?';
      params.push(extra.classification_confidence);
    }
    if (extra?.reply !== undefined) {
      query += ', reply = ?';
      params.push(extra.reply);
    }
    if (extra?.reply_source !== undefined) {
      query += ', reply_source = ?';
      params.push(extra.reply_source);
    }
    if (extra?.language !== undefined) {
      query += ', language = ?';
      params.push(extra.language);
    }
    if (extra?.error_message !== undefined) {
      query += ', error_message = ?';
      params.push(extra.error_message);
    }

    query += ' WHERE steam_comment_id = ?';
    params.push(commentId);

    this.db.prepare(query).run(...params);
  }

  public getUnfinishedSendingComments(): CommentRecord[] {
    return this.db
      .prepare("SELECT * FROM comments WHERE status = 'sending'")
      .all() as CommentRecord[];
  }

  public getStatsToday(holidayCount: number = 0): {
    totalReplies: number;
    localReplies: number;
    aiReplies: number;
    spamCount: number;
    visualExpressionReplies: number;
    visualExpressionSaved: number;
  } {
    const todayPrefix = new Date().toISOString().substring(0, 10);
    const todayBoundary = todayPrefix + 'T00:00:00.000Z';

    // 1. Replied comments strictly determined by replied_at >= today 00:00:00
    // Exclude baseline imports (scanned existing comments, not sent by bot)
    const repliedRows = this.db.prepare(`
      SELECT reply_source, classification
      FROM comments
      WHERE status = 'replied'
        AND replied_at >= ?
        AND (reply_source IS NULL OR reply_source != 'IMPORT_EXISTING')
    `).all(todayBoundary) as Array<{ reply_source: string; classification: string }>;

    // 2. Incoming comments created today for classification/spam/saved metrics
    const incomingRows = this.db.prepare(`
      SELECT reply_source, classification, status
      FROM comments
      WHERE created_at >= ?
    `).all(todayBoundary) as Array<{ reply_source: string; classification: string; status: string }>;

    const visualSubtypes = new Set([
      'emoji_pixel_art',
      'emoji_art',
      'braille_art',
      'ascii_art',
      'unicode_art',
      'block_art',
      'box_drawing_art',
      'mixed_symbol_art',
      'large_kaomoji',
      'decorative_multiline'
    ]);

    let localReplies = 0;
    let aiReplies = 0;
    let visualExpressionReplies = 0;

    for (const r of repliedRows) {
      if (r.reply_source === 'DEEPSEEK') {
        aiReplies++;
      } else {
        // Any other source (LOCAL_ONLY, LOCAL_TEMPLATE, LOCAL_RULE, VISUAL_GENERATOR, VISUAL_LIBRARY, etc.)
        localReplies++;
      }
      if (visualSubtypes.has(r.classification)) {
        visualExpressionReplies++;
      }
    }

    let spamCount = 0;
    let visualExpressionSaved = 0;

    for (const r of incomingRows) {
      if (visualSubtypes.has(r.classification) && r.reply_source !== 'DEEPSEEK') {
        visualExpressionSaved++;
      }
      if (r.classification === 'spam') {
        spamCount++;
      }
    }

    const totalReplies = localReplies + aiReplies + (holidayCount || 0);

    return { totalReplies, localReplies, aiReplies, spamCount, visualExpressionReplies, visualExpressionSaved };
  }

  public getTotalCount(): number {
    try {
      const row = this.db.prepare('SELECT count(*) as c FROM comments').get() as any;
      return row ? row.c : 0;
    } catch {
      return 0;
    }
  }

  public getLatestComment(): CommentRecord | undefined {
    try {
      return this.db.prepare('SELECT * FROM comments ORDER BY id DESC LIMIT 1').get() as CommentRecord | undefined;
    } catch {
      return undefined;
    }
  }
}
