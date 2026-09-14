import { InteractionUsersRepository } from '../db/repositories/interactionUsers';
import { HolidayRepository, HolidayMessageRecord } from '../db/repositories/holiday';
import { BotConfig } from '../config/schema';

export interface HolidayDefinition {
  id: string;
  name: string;
  month: number; // 1-12
  day: number;   // 1-31
  messages: { [lang: string]: string[] };
}

export class HolidayEngine {
  private static KNOWN_HOLIDAYS: HolidayDefinition[] = [
    {
      id: 'new_year',
      name: '元旦 / New Year',
      month: 1,
      day: 1,
      messages: {
        zh: ['🎉 新年快乐！新的一年祝你游戏把把大吉大利，生活顺心顺意！', '✨ 新年快乐！感谢过去相遇，新的一年天天开心！'],
        en: ['🎉 Happy New Year! Wishing you victory and great fun in your games this year!', '✨ Happy New Year! Hope this year brings you joy and lots of achievements!'],
        ja: ['🎉 あけましておめでとうございます！今年も楽しくゲームしましょうね！', '✨ 新年おめでとうございます！良い一年になりますように！']
      }
    },
    {
      id: 'lunar_new_year',
      name: '春节 / Spring Festival',
      month: 1,
      day: 29, // Lunar New Year approximate or date
      messages: {
        zh: ['🧧 新春快乐！祝你龙马精神，财运亨通，抽卡全出金！', '🏮 祝你和家人新春大吉，万事如意，天天好心情！'],
        en: ['🧧 Happy Spring Festival! Wishing you good luck, health, and prosperity!'],
        ja: ['🧧 春節おめでとうございます！幸運に満ちた一年になりますように！']
      }
    },
    {
      id: 'christmas',
      name: '圣诞节 / Christmas',
      month: 12,
      day: 25,
      messages: {
        zh: ['🎄 圣诞快乐！愿你度过一个温馨愉快的冬日假期～', '❄️ 圣诞快乐！祝你收获满满的快乐和欧气！'],
        en: ['🎄 Merry Christmas! Wishing you a warm and joyful holiday season! ❄️', '🎁 Merry Christmas! Hope Santa brings you all the games on your wishlist!'],
        ja: ['🎄 メリークリスマス！素敵なホリデーシーズンをお過ごしください！❄️']
      }
    }
  ];

  constructor(
    private interactionRepo: InteractionUsersRepository,
    private holidayRepo: HolidayRepository,
    private config: BotConfig
  ) {}

  public getTodayHoliday(nowDate: Date = new Date()): HolidayDefinition | null {
    const month = nowDate.getMonth() + 1;
    const day = nowDate.getDate();
    return HolidayEngine.KNOWN_HOLIDAYS.find(h => h.month === month && h.day === day) || null;
  }

  public isWithinSendWindow(nowDate: Date = new Date()): boolean {
    const hours = nowDate.getHours();
    const minutes = nowDate.getMinutes();
    const currentMinutes = hours * 60 + minutes;

    const [startH, startM] = this.config.HOLIDAY_SEND_START.split(':').map(Number);
    const [endH, endM] = this.config.HOLIDAY_SEND_END.split(':').map(Number);

    const startMinutes = startH * 60 + (startM || 0);
    const endMinutes = endH * 60 + (endM || 0);

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  public planHolidayGreetingsForToday(nowDate: Date = new Date()): number {
    const holiday = this.getTodayHoliday(nowDate);
    if (!holiday) return 0;

    const todayStr = nowDate.toISOString().substring(0, 10);
    const alreadySentToday = this.holidayRepo.getCountSentToday(todayStr);
    const remainingQuota = this.config.MAX_HOLIDAY_MESSAGES_PER_DAY - alreadySentToday;
    if (remainingQuota <= 0) return 0;

    // Only users who commented on my profile within HOLIDAY_ACTIVE_DAYS (default 30 days)
    const activeCutoffIso = new Date(
      nowDate.getTime() - this.config.HOLIDAY_ACTIVE_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const candidates = this.interactionRepo.getEligibleHolidayUsers(activeCutoffIso, 20);
    let scheduledCount = 0;

    const [startH, startM] = this.config.HOLIDAY_SEND_START.split(':').map(Number);
    const [endH, endM] = this.config.HOLIDAY_SEND_END.split(':').map(Number);
    const startMs = new Date(nowDate).setHours(startH, startM || 0, 0, 0);
    const endMs = new Date(nowDate).setHours(endH, endM || 0, 0, 0);
    const windowSpan = Math.max(1000, endMs - Math.max(startMs, nowDate.getTime()));

    for (const user of candidates) {
      if (scheduledCount >= remainingQuota) break;

      // Check if this holiday message was already recorded for this user
      const existing = this.holidayRepo.findExisting(holiday.id, user.steam_id);
      if (existing) continue;

      // Select message
      const lang = user.language || this.config.DEFAULT_LANGUAGE || 'zh';
      const msgList = holiday.messages[lang] || holiday.messages['zh'] || holiday.messages['en'];
      const chosenMsg = msgList[Math.floor(Math.random() * msgList.length)];

      // Randomized staggered send time between now and window end
      const randomOffset = Math.floor(Math.random() * windowSpan);
      const scheduledAt = new Date(Math.max(nowDate.getTime(), startMs) + randomOffset).toISOString();

      this.holidayRepo.insert({
        holiday_id: holiday.id,
        steam_id: user.steam_id,
        profile_url: user.profile_url,
        message: chosenMsg,
        status: 'scheduled',
        scheduled_at: scheduledAt,
        created_at: new Date().toISOString()
      });

      scheduledCount++;
    }

    return scheduledCount;
  }
}
