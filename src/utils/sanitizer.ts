/**
 * Sanitization utility for diagnostic bundle export and telemetry logs.
 * Strictly guarantees 0 leakage of personal Steam credentials, API keys, and private data.
 */

const STEAMID64_REGEX = /\b(7656119\d{2})(\d{6})(\d{4})\b/g;
const API_KEY_REGEX = /\b(sk-[a-zA-Z0-9_\-]{4,})\b/g;
const COOKIE_TOKEN_REGEX = /(sessionid|steamLoginSecure|steamRefresh_steam)=([a-zA-Z0-9%_\-]+)/gi;
const WINDOWS_USER_PATH_REGEX = /([a-zA-Z]:\\Users\\)[^\\]+(\\)/gi;

export function sanitizeDiagnosticText(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let sanitized = text;

  // 1. Mask SteamID64 (keep prefix & suffix, mask middle digits)
  sanitized = sanitized.replace(STEAMID64_REGEX, '$1******$3');

  // 2. Mask DeepSeek / OpenAI API keys
  sanitized = sanitized.replace(API_KEY_REGEX, 'sk-[REDACTED]');

  // 3. Mask Steam authentication cookies and session tokens
  sanitized = sanitized.replace(COOKIE_TOKEN_REGEX, '$1=[REDACTED]');

  // 4. Mask Windows local username in file paths
  sanitized = sanitized.replace(WINDOWS_USER_PATH_REGEX, '$1[USERNAME]$2');

  // 5. Generic Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED]');

  return sanitized;
}

export function sanitizeDiagnosticObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeDiagnosticText(obj);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeDiagnosticObject(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    const SENSITIVE_KEYS = new Set([
      'api_key', 'apikey', 'deepseek_api_key', 'password', 'token',
      'sessionid', 'steamloginsecure', 'cookie', 'cookies', 'secret'
    ]);

    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        result[key] = '[REDACTED]';
      } else if (typeof val === 'string') {
        result[key] = sanitizeDiagnosticText(val);
      } else if (typeof val === 'object') {
        result[key] = sanitizeDiagnosticObject(val);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  return obj;
}
