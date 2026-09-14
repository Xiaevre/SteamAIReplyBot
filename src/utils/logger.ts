import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from './paths';

export interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  event: string;
  details?: any;
}

export class Logger {
  private logDir: string;
  private memoryLogs: LogEntry[] = [];
  private readonly maxMemoryLogs: number = 500;

  constructor(customLogDir?: string) {
    this.logDir = customLogDir || getLogsDir();
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.cleanOldLogs(30);
  }

  private getTodayLogFile(): string {
    const today = new Date().toISOString().substring(0, 10);
    return path.join(this.logDir, `${today}.log`);
  }

  public log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', event: string, details?: any): void {
    const now = new Date().toISOString();
    let sanitizedDetails = '';
    if (details) {
      if (typeof details === 'string') {
        sanitizedDetails = this.sanitize(details);
      } else {
        try {
          sanitizedDetails = this.sanitize(JSON.stringify(details));
        } catch {
          sanitizedDetails = '[Unserializable details]';
        }
      }
    }

    // Push to in-memory ring buffer for Web UI
    let parsedDetails = details;
    if (typeof details === 'string') {
      try { parsedDetails = JSON.parse(sanitizedDetails); } catch { parsedDetails = sanitizedDetails; }
    }
    this.memoryLogs.push({
      timestamp: now,
      level,
      event,
      details: parsedDetails
    });
    if (this.memoryLogs.length > this.maxMemoryLogs) {
      this.memoryLogs.shift();
    }

    const logLine = `[${now}] [${level}] [${event}] ${sanitizedDetails}\n`;

    // Output to console
    if (level === 'ERROR') {
      console.error(`[${level}] ${event}:`, sanitizedDetails);
    } else if (level === 'WARN') {
      console.warn(`[${level}] ${event}:`, sanitizedDetails);
    } else {
      console.log(`[${level}] ${event}:`, sanitizedDetails);
    }

    // Append to daily file
    try {
      fs.appendFileSync(this.getTodayLogFile(), logLine, 'utf8');
    } catch {
      // Ignore write errors
    }
  }

  public info(event: string, details?: any): void {
    this.log('INFO', event, details);
  }

  public warn(event: string, details?: any): void {
    this.log('WARN', event, details);
  }

  public error(event: string, details?: any): void {
    this.log('ERROR', event, details);
  }

  public getRecentLogs(limit: number = 200): LogEntry[] {
    const safeLimit = Math.min(limit, this.maxMemoryLogs);
    return this.memoryLogs.slice(-safeLimit);
  }

  private sanitize(str: string): string {
    return str
      .replace(/api[_-]?key["':\s]*[a-zA-Z0-9_-]{10,}/gi, 'api_key=***MASKED***')
      .replace(/sk-[a-zA-Z0-9_-]{15,}/gi, 'sk-***MASKED***')
      .replace(/steamLoginSecure["':\s]*[a-zA-Z0-9%_-]{10,}/gi, 'steamLoginSecure=***MASKED***')
      .replace(/password["':\s]*["'][^"']+["']/gi, 'password="***MASKED***"');
  }

  public cleanOldLogs(retentionDays: number = 30): void {
    try {
      if (!fs.existsSync(this.logDir)) return;
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.endsWith('.log')) {
          const filePath = path.join(this.logDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > cutoffMs) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch {
      // Ignore cleanup error
    }
  }
}
