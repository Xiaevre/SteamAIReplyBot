import { ReplyTasksRepository } from '../db/repositories/replyTasks';

export class RateLimiter {
  constructor(
    private replyTasksRepo: ReplyTasksRepository,
    private maxPerHour: number = 10,
    private maxPerDay: number = 50
  ) {}

  public canSendReply(): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const hourCount = this.replyTasksRepo.getRepliesSentCount(oneHourAgo);
    if (hourCount >= this.maxPerHour) {
      return { allowed: false, reason: `Hourly limit reached (${hourCount}/${this.maxPerHour})` };
    }

    const dayCount = this.replyTasksRepo.getRepliesSentCount(oneDayAgo);
    if (dayCount >= this.maxPerDay) {
      return { allowed: false, reason: `Daily limit reached (${dayCount}/${this.maxPerDay})` };
    }

    return { allowed: true };
  }
}
