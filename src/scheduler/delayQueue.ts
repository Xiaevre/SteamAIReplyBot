import { ReplyTasksRepository, ReplyTaskRecord } from '../db/repositories/replyTasks';
import * as crypto from 'crypto';

export class DelayQueue {
  constructor(
    private replyTasksRepo: ReplyTasksRepository,
    private minDelaySeconds: number = 60,
    private maxDelaySeconds: number = 240
  ) {}

  public enqueueReplyTask(params: {
    steamCommentId: string;
    targetSteamId: string;
    targetProfileUrl: string;
    replyText: string;
  }): ReplyTaskRecord {
    const existing = this.replyTasksRepo.findByCommentId(params.steamCommentId);
    if (existing) {
      return existing;
    }

    const randomSeconds = Math.floor(
      Math.random() * (this.maxDelaySeconds - this.minDelaySeconds + 1) + this.minDelaySeconds
    );
    const scheduledTime = new Date(Date.now() + randomSeconds * 1000).toISOString();
    const taskId = 'task_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    const record: Omit<ReplyTaskRecord, 'id'> = {
      task_id: taskId,
      steam_comment_id: params.steamCommentId,
      target_steam_id: params.targetSteamId,
      target_profile_url: params.targetProfileUrl,
      reply_text: params.replyText,
      status: 'scheduled',
      scheduled_at: scheduledTime,
      attempt_count: 0,
      created_at: now
    };

    this.replyTasksRepo.insert(record);
    return { ...record };
  }

  public getReadyTasks(): ReplyTaskRecord[] {
    const nowIso = new Date().toISOString();
    return this.replyTasksRepo.getPendingScheduledTasks(nowIso);
  }
}
