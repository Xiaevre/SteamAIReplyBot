export type TimePeriod = 'morning' | 'noon' | 'afternoon' | 'evening';

export interface TimeGreetingOptions {
  nickname?: string | null;
  date?: Date;
}

/**
 * Pure local time greeting generator based on local system time.
 * Supports morning (05:00-10:59), noon (11:00-13:59), afternoon (14:00-17:59), evening (18:00-04:59).
 */
export class TimeGreeting {
  private static GREETING_VARIANTS: Record<TimePeriod, string[]> = {
    morning: ['早上好～', '早上好呀～', '早安～'],
    noon: ['中午好～', '中午好呀～'],
    afternoon: ['下午好～', '下午好呀～'],
    evening: ['晚上好～', '晚上好呀～', '晚上好喔～']
  };

  /**
   * Determine time period from date:
   * 05:00–10:59 -> morning
   * 11:00–13:59 -> noon
   * 14:00–17:59 -> afternoon
   * 18:00–04:59 -> evening
   */
  public static getTimePeriod(date: Date = new Date()): TimePeriod {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const totalMinutes = hours * 60 + minutes;

    // 05:00–10:59 (300 to 659 mins)
    if (totalMinutes >= 300 && totalMinutes <= 659) {
      return 'morning';
    }
    // 11:00–13:59 (660 to 839 mins)
    if (totalMinutes >= 660 && totalMinutes <= 839) {
      return 'noon';
    }
    // 14:00–17:59 (840 to 1079 mins)
    if (totalMinutes >= 840 && totalMinutes <= 1079) {
      return 'afternoon';
    }
    // 18:00–04:59 (1080 to 1439 or 0 to 299 mins)
    return 'evening';
  }

  /**
   * Get all greeting variants for a given period
   */
  public static getVariants(period: TimePeriod): string[] {
    return TimeGreeting.GREETING_VARIANTS[period] || TimeGreeting.GREETING_VARIANTS.evening;
  }

  /**
   * Format a greeting with an optional nickname.
   * If nickname is present: "凤梨，晚上好呀～"
   * If nickname is absent: "晚上好呀～"
   */
  public static format(greeting: string, nickname?: string | null): string {
    const cleanNick = (nickname || '').trim();
    if (cleanNick) {
      return `${cleanNick}，${greeting}`;
    }
    return greeting;
  }

  /**
   * Generate a natural greeting for the given date and optional nickname.
   */
  public static generate(options: TimeGreetingOptions = {}): string {
    const date = options.date || new Date();
    const period = TimeGreeting.getTimePeriod(date);
    const variants = TimeGreeting.getVariants(period);
    const chosen = variants[Math.floor(Math.random() * variants.length)];
    return TimeGreeting.format(chosen, options.nickname);
  }
}
