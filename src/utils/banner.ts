import { BotConfig } from '../config/schema';

export interface DashboardStats {
  mode: string;
  steamProfile: string;
  aiModel: string;
  checkRange: string;
  dryRun: boolean;
  repliesToday: number;
  localReplies: number;
  aiReplies: number;
  aiSavedRequests: number;
  spamCount: number;
  holidayReplies: number;
  visualExpressionReplies?: number;
  visualExpressionSaved?: number;
  memoryMb: number;
  uptimeStr: string;
  status: string;
}

export class Banner {
  public static print(stats: DashboardStats): void {
    const bannerText = `
========================================
Steam AI Comment Reply Bot
==========================

Mode:
${stats.mode}

Steam:
${stats.steamProfile || '(not configured)'}

AI:
${stats.aiModel}

Check:
${stats.checkRange}

Dry Run:
${stats.dryRun}

Replies Today:
${stats.repliesToday}

Local Replies:
${stats.localReplies}

AI Replies:
${stats.aiReplies}

AI Requests Saved:
${stats.aiSavedRequests}

Visual Expression Local Replies:
${stats.visualExpressionReplies ?? 0}

Visual Expression AI Requests Saved:
${stats.visualExpressionSaved ?? 0}

Spam:
${stats.spamCount}

Holiday Replies:
${stats.holidayReplies}

Memory:
${stats.memoryMb} MB

Uptime:
${stats.uptimeStr}

Status:
${stats.status}

========================================
`;
    console.log(bannerText.trim());
  }

  public static formatUptime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hrs}h ${mins}m`;
  }
}
