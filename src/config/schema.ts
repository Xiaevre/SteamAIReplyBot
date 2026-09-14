export interface BotConfig {
  STEAM_PROFILE_URL: string;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_MODEL: string;
  DEEPSEEK_BASE_URL?: string;

  CHECK_INTERVAL_MIN_SECONDS: number;
  CHECK_INTERVAL_MAX_SECONDS: number;

  DRY_RUN: boolean;

  MAX_REPLIES_PER_HOUR: number;
  MAX_REPLIES_PER_DAY: number;

  MAX_HOLIDAY_MESSAGES_PER_DAY: number;
  HOLIDAY_ACTIVE_DAYS: number;
  HOLIDAY_SEND_START: string; // e.g. "09:00"
  HOLIDAY_SEND_END: string;   // e.g. "22:00"

  DEFAULT_LANGUAGE: 'zh' | 'en' | 'ja';
  TIMEZONE: string;

  MIN_REPLY_DELAY_SECONDS: number;
  MAX_REPLY_DELAY_SECONDS: number;

  AI_REQUEST_DELAY_MS: number;

  // Health and memory thresholds
  MEMORY_WARNING_MB: number;
  MEMORY_CRITICAL_MB: number;

  // Kill Switch / Emergency Controls
  BOT_ENABLED: boolean;
  EMERGENCY_STOP: boolean;
  BOT_MODE?: BotMode;

  // Browser paths / channels / mode
  BROWSER_EXECUTABLE_PATH?: string;
  BROWSER_PATH?: string; // Alias for BROWSER_EXECUTABLE_PATH
  BROWSER_MODE?: 'AUTO' | 'CHROME' | 'EDGE';
  BROWSER_CHANNEL?: string;
  HEADLESS?: boolean;
}

export type BotMode = 'LOCAL_ONLY' | 'AI_ENHANCED' | 'DISABLED';
export type BotLifecycleState = 'STARTING' | 'RUNNING' | 'WAITING' | 'STOPPING' | 'STOPPED' | 'ERROR';

export const DEFAULT_CONFIG: BotConfig = {
  STEAM_PROFILE_URL: '',
  DEEPSEEK_API_KEY: '',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',

  CHECK_INTERVAL_MIN_SECONDS: 90,
  CHECK_INTERVAL_MAX_SECONDS: 180,

  DRY_RUN: true,

  MAX_REPLIES_PER_HOUR: 10,
  MAX_REPLIES_PER_DAY: 50,

  MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
  HOLIDAY_ACTIVE_DAYS: 30,
  HOLIDAY_SEND_START: '09:00',
  HOLIDAY_SEND_END: '22:00',

  DEFAULT_LANGUAGE: 'zh',
  TIMEZONE: 'Asia/Tokyo',

  MIN_REPLY_DELAY_SECONDS: 60,
  MAX_REPLY_DELAY_SECONDS: 240,

  AI_REQUEST_DELAY_MS: 2000,

  MEMORY_WARNING_MB: 450,
  MEMORY_CRITICAL_MB: 700,

  BOT_ENABLED: false,
  EMERGENCY_STOP: false,
  BOT_MODE: 'AI_ENHANCED',

  BROWSER_MODE: 'AUTO',
  HEADLESS: true
};
