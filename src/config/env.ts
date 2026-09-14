import * as fs from 'fs';
import * as path from 'path';
import { BotConfig, DEFAULT_CONFIG } from './schema';
import { getAppRoot, getDataDir } from '../utils/paths';

export function loadConfig(configPath?: string): BotConfig {
  const result: BotConfig = { ...DEFAULT_CONFIG };
  const root = getAppRoot();
  const dataDir = getDataDir();

  // 1. Try reading .env from data/config, data, app root or cwd
  const envCandidates = [
    path.resolve(dataDir, 'config', '.env'),
    path.resolve(dataDir, '.env'),
    path.resolve(root, '.env'),
    path.resolve(process.cwd(), '.env')
  ];

  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        // Ignore env read errors
      }
      break;
    }
  }

  // 2. Try reading config.json (explicit path or default candidates)
  const configCandidates = configPath
    ? [path.resolve(configPath), path.resolve(root, configPath)]
    : [
        path.resolve(dataDir, 'config', 'config.json'),
        path.resolve(dataDir, 'config.json'),
        path.resolve(root, 'config.json'),
        path.resolve(root, 'config', 'config.json')
      ];

  for (const targetJsonPath of configCandidates) {
    if (fs.existsSync(targetJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(targetJsonPath, 'utf8'));
        Object.assign(result, parsed);
        break;
      } catch (e) {
        console.warn(`[Config] Failed to parse config file at ${targetJsonPath}:`, (e as Error).message);
      }
    }
  }

  // 3. Apply process.env with highest priority
  if (process.env.STEAM_PROFILE_URL) result.STEAM_PROFILE_URL = process.env.STEAM_PROFILE_URL;
  if (process.env.DEEPSEEK_API_KEY) result.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_MODEL) result.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL;
  if (process.env.DEEPSEEK_BASE_URL) result.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL;

  if (process.env.CHECK_INTERVAL_MIN_SECONDS) result.CHECK_INTERVAL_MIN_SECONDS = parseInt(process.env.CHECK_INTERVAL_MIN_SECONDS, 10);
  if (process.env.CHECK_INTERVAL_MAX_SECONDS) result.CHECK_INTERVAL_MAX_SECONDS = parseInt(process.env.CHECK_INTERVAL_MAX_SECONDS, 10);

  if (process.env.DRY_RUN !== undefined) {
    result.DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';
  }

  if (process.env.MAX_REPLIES_PER_HOUR) result.MAX_REPLIES_PER_HOUR = parseInt(process.env.MAX_REPLIES_PER_HOUR, 10);
  if (process.env.MAX_REPLIES_PER_DAY) result.MAX_REPLIES_PER_DAY = parseInt(process.env.MAX_REPLIES_PER_DAY, 10);

  if (process.env.MAX_HOLIDAY_MESSAGES_PER_DAY) result.MAX_HOLIDAY_MESSAGES_PER_DAY = parseInt(process.env.MAX_HOLIDAY_MESSAGES_PER_DAY, 10);
  if (process.env.HOLIDAY_ACTIVE_DAYS) result.HOLIDAY_ACTIVE_DAYS = parseInt(process.env.HOLIDAY_ACTIVE_DAYS, 10);
  if (process.env.HOLIDAY_SEND_START) result.HOLIDAY_SEND_START = process.env.HOLIDAY_SEND_START;
  if (process.env.HOLIDAY_SEND_END) result.HOLIDAY_SEND_END = process.env.HOLIDAY_SEND_END;

  if (process.env.DEFAULT_LANGUAGE && ['zh', 'en', 'ja'].includes(process.env.DEFAULT_LANGUAGE)) {
    result.DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE as 'zh' | 'en' | 'ja';
  }
  if (process.env.TIMEZONE) result.TIMEZONE = process.env.TIMEZONE;

  if (process.env.MIN_REPLY_DELAY_SECONDS) result.MIN_REPLY_DELAY_SECONDS = parseInt(process.env.MIN_REPLY_DELAY_SECONDS, 10);
  if (process.env.MAX_REPLY_DELAY_SECONDS) result.MAX_REPLY_DELAY_SECONDS = parseInt(process.env.MAX_REPLY_DELAY_SECONDS, 10);

  if (process.env.AI_REQUEST_DELAY_MS) result.AI_REQUEST_DELAY_MS = parseInt(process.env.AI_REQUEST_DELAY_MS, 10);

  if (process.env.MEMORY_WARNING_MB) result.MEMORY_WARNING_MB = parseInt(process.env.MEMORY_WARNING_MB, 10);
  if (process.env.MEMORY_CRITICAL_MB) result.MEMORY_CRITICAL_MB = parseInt(process.env.MEMORY_CRITICAL_MB, 10);

  if (process.env.BOT_ENABLED !== undefined) {
    result.BOT_ENABLED = process.env.BOT_ENABLED === 'true' || process.env.BOT_ENABLED === '1';
  }
  if (process.env.EMERGENCY_STOP !== undefined) {
    result.EMERGENCY_STOP = process.env.EMERGENCY_STOP === 'true' || process.env.EMERGENCY_STOP === '1';
  }
  if (process.env.BOT_MODE) {
    const upperMode = process.env.BOT_MODE.trim().toUpperCase();
    if (['LOCAL_ONLY', 'AI_ENHANCED', 'DISABLED'].includes(upperMode)) {
      result.BOT_MODE = upperMode as any;
    }
  }

  if (process.env.BROWSER_PATH) {
    result.BROWSER_PATH = process.env.BROWSER_PATH;
    result.BROWSER_EXECUTABLE_PATH = process.env.BROWSER_PATH;
  }
  if (process.env.BROWSER_EXECUTABLE_PATH) {
    result.BROWSER_EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH;
    result.BROWSER_PATH = process.env.BROWSER_EXECUTABLE_PATH;
  }
  if (process.env.BROWSER_MODE) {
    const upperMode = process.env.BROWSER_MODE.trim().toUpperCase();
    if (['AUTO', 'CHROME', 'EDGE'].includes(upperMode)) {
      result.BROWSER_MODE = upperMode as 'AUTO' | 'CHROME' | 'EDGE';
    }
  }
  if (process.env.BROWSER_CHANNEL) result.BROWSER_CHANNEL = process.env.BROWSER_CHANNEL;
  if (process.env.HEADLESS !== undefined) {
    result.HEADLESS = process.env.HEADLESS === 'true' || process.env.HEADLESS === '1';
  }

  return result;
}
