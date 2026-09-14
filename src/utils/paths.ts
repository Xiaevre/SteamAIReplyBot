import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let cachedAppRoot: string | null = null;
let cachedDataDir: string | null = null;

/**
 * Resolves the application binary/code root (where code, release, dist, prompts live).
 */
export function getAppRoot(): string {
  if (cachedAppRoot) return cachedAppRoot;

  if (process.env.STEAM_BOT_APP_ROOT && fs.existsSync(process.env.STEAM_BOT_APP_ROOT)) {
    cachedAppRoot = path.resolve(process.env.STEAM_BOT_APP_ROOT);
    return cachedAppRoot;
  }

  // Look relative to __dirname
  const cand1 = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(cand1, 'dist')) || fs.existsSync(path.join(cand1, 'SteamAIReplyBot.exe')) || fs.existsSync(path.join(cand1, 'package.json'))) {
    cachedAppRoot = cand1;
    return cachedAppRoot;
  }

  const cand2 = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(cand2, 'dist')) || fs.existsSync(path.join(cand2, 'SteamAIReplyBot.exe'))) {
    cachedAppRoot = cand2;
    return cachedAppRoot;
  }

  cachedAppRoot = process.cwd();
  return cachedAppRoot;
}

/**
 * Resolves the unified runtime data directory.
 *
 * Path Resolution Strategy:
 * 1. Highest Priority: Environment variable STEAM_AI_REPLYBOT_DATA_DIR
 * 2. Secondary Override: Legacy environment variable STEAM_BOT_DATA_DIR
 * 3. Default (Portable Program Directory Priority): <appRoot>/data
 */
export function getDataDir(): string {
  if (cachedDataDir) return cachedDataDir;

  if (process.env.STEAM_AI_REPLYBOT_DATA_DIR && process.env.STEAM_AI_REPLYBOT_DATA_DIR.trim()) {
    cachedDataDir = path.resolve(process.env.STEAM_AI_REPLYBOT_DATA_DIR.trim());
    return cachedDataDir;
  }

  if (process.env.STEAM_BOT_DATA_DIR && process.env.STEAM_BOT_DATA_DIR.trim()) {
    cachedDataDir = path.resolve(process.env.STEAM_BOT_DATA_DIR.trim());
    return cachedDataDir;
  }

  // Portable default: <program_root>/data
  cachedDataDir = path.join(getAppRoot(), 'data');
  return cachedDataDir;
}

/**
 * Returns the application root directory.
 */
export function getRuntimeRoot(): string {
  return getAppRoot();
}

/**
 * Legacy alias for getDataDir() for backward compatibility.
 */
export function getAppDataRoot(): string {
  return getDataDir();
}

export function getPlaywrightTempDir(): string {
  return path.join(getDataDir(), 'playwright-temp');
}

export function getCookiesDir(): string {
  return path.join(getDataDir(), 'cookies');
}

export function getBrowserProfileDir(): string {
  const dataDir = getDataDir();
  const cookiesDir = path.join(dataDir, 'cookies');
  const legacyProfileDir = path.join(dataDir, 'browser-profile');

  // If cookies directory exists and has files, or if legacy profile does not exist, use cookies/
  if (fs.existsSync(cookiesDir) && fs.readdirSync(cookiesDir).length > 0) {
    return cookiesDir;
  }
  if (fs.existsSync(legacyProfileDir) && !fs.existsSync(cookiesDir)) {
    return legacyProfileDir;
  }

  return cookiesDir;
}

export function getDatabasePath(): string {
  const dataDir = getDataDir();
  const dbSqlite = path.join(dataDir, 'database.sqlite');
  const dbLegacy = path.join(dataDir, 'steam-ai-reply.db');

  if (fs.existsSync(dbSqlite)) return dbSqlite;
  if (fs.existsSync(dbLegacy)) return dbLegacy;
  return dbSqlite;
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

export function getConfigDir(): string {
  return path.join(getDataDir(), 'config');
}

export function getConfigPath(): string {
  const dataDir = getDataDir();
  const p1 = path.join(dataDir, 'config', 'config.json');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(dataDir, 'config.json');
  if (fs.existsSync(p2)) return p2;
  const p3 = path.join(getAppRoot(), 'config.json');
  if (fs.existsSync(p3)) return p3;
  return p1;
}

export function getPhrasesPath(): string {
  const dataDir = getDataDir();
  const p1 = path.join(dataDir, 'config', 'phrases.json');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(dataDir, 'phrases.json');
  if (fs.existsSync(p2)) return p2;
  const p3 = path.join(getAppRoot(), 'templates', 'phrases.json');
  if (fs.existsSync(p3)) return p3;
  return p1;
}

export function getRuntimeControlPath(): string {
  return path.join(getDataDir(), 'runtime-control.json');
}

export function getLockFilePath(): string {
  return path.join(getDataDir(), 'bot-instance.lock');
}

export function getStartupLogPath(): string {
  return path.join(getLogsDir(), 'startup.log');
}

export function writeStartupLog(event: string, meta?: any): void {
  try {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logPath = getStartupLogPath();
    const ts = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    fs.appendFileSync(logPath, `[${ts}] [${event}]${metaStr}\n`, 'utf8');
  } catch {
    // Ignore logging errors
  }
}

export function getBrowsersDir(): string {
  return path.resolve(getAppRoot(), 'browsers');
}

export function getPromptsDir(): string {
  return path.resolve(getAppRoot(), 'prompts');
}

function copyFolderRecursiveSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyFolderRecursiveSync(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

/**
 * Migrates legacy data into the unified data directory if the target database or cookies are empty.
 */
export function migrateLegacyDataIfNeeded(): void {
  const targetDataDir = getDataDir();
  const targetDbPath = getDatabasePath();
  const targetProfileDir = getBrowserProfileDir();

  // 1. Database Migration
  let targetCommentsCount = 0;
  const targetDbExists = fs.existsSync(targetDbPath);

  if (targetDbExists) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(targetDbPath, { readOnly: true });
      const row = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='comments'").get() as any;
      if (row && row.c > 0) {
        const cRow = db.prepare('SELECT count(*) as c FROM comments').get() as any;
        targetCommentsCount = cRow ? cRow.c : 0;
      }
      db.close();
    } catch {
      targetCommentsCount = 0;
    }
  }

  // If target database doesn't exist or is empty (0 comments), inspect candidate legacy DBs
  if (!targetDbExists || targetCommentsCount === 0) {
    const appRoot = getAppRoot();
    const candidateDbPaths = [
      path.join(targetDataDir, 'steam-ai-reply.db'),
      path.join(appRoot, 'release', 'data', 'database.sqlite'),
      path.join(appRoot, 'release', 'data', 'steam-ai-reply.db'),
      path.join(appRoot, 'data', 'database.sqlite'),
      path.join(appRoot, 'data', 'steam-ai-reply.db'),
      path.join(process.cwd(), 'release', 'data', 'database.sqlite'),
      path.join(process.cwd(), 'release', 'data', 'steam-ai-reply.db'),
      path.join(process.cwd(), 'data', 'database.sqlite'),
      path.join(process.cwd(), 'data', 'steam-ai-reply.db')
    ];

    // Check optional legacy Windows AppData path if available
    if (process.env.LOCALAPPDATA) {
      candidateDbPaths.push(path.join(process.env.LOCALAPPDATA, 'SteamAIReplyBot', 'data', 'steam-ai-reply.db'));
      candidateDbPaths.push(path.join(process.env.LOCALAPPDATA, 'SteamAIReplyBot', 'data', 'database.sqlite'));
    }

    let bestCandidate: { path: string; count: number } | null = null;

    for (const cand of candidateDbPaths) {
      if (!fs.existsSync(cand)) continue;
      try {
        if (path.resolve(cand).toLowerCase() === path.resolve(targetDbPath).toLowerCase()) continue;
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(cand);
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch {}
        const row = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='comments'").get() as any;
        if (row && row.c > 0) {
          const cRow = db.prepare('SELECT count(*) as c FROM comments').get() as any;
          const count = cRow ? cRow.c : 0;
          if (!bestCandidate || count > bestCandidate.count) {
            bestCandidate = { path: cand, count };
          }
        }
        db.close();
      } catch {
        // Ignore candidate read error
      }
    }

    if (bestCandidate && bestCandidate.count > targetCommentsCount) {
      writeStartupLog('DATABASE_MIGRATING', {
        from: bestCandidate.path,
        to: targetDbPath,
        commentsCount: bestCandidate.count
      });
      if (!fs.existsSync(targetDataDir)) {
        fs.mkdirSync(targetDataDir, { recursive: true });
      }
      fs.copyFileSync(bestCandidate.path, targetDbPath);
      writeStartupLog('DATABASE_MIGRATED', {
        from: bestCandidate.path,
        to: targetDbPath,
        commentsCount: bestCandidate.count
      });
    }
  }

  // 2. Browser Profile / Cookies Migration
  let hasValidSession = false;
  const targetCookiesFile = path.join(targetProfileDir, 'Default', 'Network', 'Cookies');
  if (fs.existsSync(targetCookiesFile)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(targetCookiesFile, { readOnly: true });
      const row = db.prepare("SELECT count(*) as c FROM cookies WHERE name='steamLoginSecure'").get() as any;
      hasValidSession = row && row.c > 0;
      db.close();
    } catch {
      hasValidSession = false;
    }
  }

  if (!hasValidSession) {
    const appRoot = getAppRoot();
    const candidateProfileDirs = [
      path.join(targetDataDir, 'browser-profile'),
      path.join(appRoot, 'release', 'data', 'cookies'),
      path.join(appRoot, 'release', 'data', 'browser-profile'),
      path.join(appRoot, 'data', 'cookies'),
      path.join(appRoot, 'data', 'browser-profile'),
      path.join(process.cwd(), 'release', 'data', 'cookies'),
      path.join(process.cwd(), 'release', 'data', 'browser-profile'),
      path.join(process.cwd(), 'data', 'cookies'),
      path.join(process.cwd(), 'data', 'browser-profile')
    ];

    if (process.env.LOCALAPPDATA) {
      candidateProfileDirs.push(path.join(process.env.LOCALAPPDATA, 'SteamAIReplyBot', 'data', 'cookies'));
      candidateProfileDirs.push(path.join(process.env.LOCALAPPDATA, 'SteamAIReplyBot', 'data', 'browser-profile'));
    }

    let bestProfile: string | null = null;
    for (const candProfile of candidateProfileDirs) {
      if (!fs.existsSync(candProfile)) continue;
      if (path.resolve(candProfile).toLowerCase() === path.resolve(targetProfileDir).toLowerCase()) continue;
      const cFile = path.join(candProfile, 'Default', 'Network', 'Cookies');
      if (fs.existsSync(cFile)) {
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(cFile, { readOnly: true });
          const row = db.prepare("SELECT count(*) as c FROM cookies WHERE name='steamLoginSecure'").get() as any;
          const valid = row && row.c > 0;
          db.close();
          if (valid) {
            bestProfile = candProfile;
            break;
          }
        } catch {}
      }
    }

    if (bestProfile) {
      writeStartupLog('BROWSER_PROFILE_MIGRATING', {
        from: bestProfile,
        to: targetProfileDir
      });
      copyFolderRecursiveSync(bestProfile, targetProfileDir);
      writeStartupLog('BROWSER_PROFILE_MIGRATED', {
        from: bestProfile,
        to: targetProfileDir
      });
    }
  }

  // 3. Runtime Control Migration
  const targetRuntimeControl = getRuntimeControlPath();
  if (!fs.existsSync(targetRuntimeControl)) {
    const appRoot = getAppRoot();
    const candidateRcs = [
      path.join(appRoot, 'release', 'data', 'runtime-control.json'),
      path.join(appRoot, 'data', 'runtime-control.json')
    ];
    if (process.env.LOCALAPPDATA) {
      candidateRcs.push(path.join(process.env.LOCALAPPDATA, 'SteamAIReplyBot', 'data', 'runtime-control.json'));
    }
    for (const candRc of candidateRcs) {
      if (fs.existsSync(candRc) && path.resolve(candRc).toLowerCase() !== path.resolve(targetRuntimeControl).toLowerCase()) {
        try {
          fs.copyFileSync(candRc, targetRuntimeControl);
          break;
        } catch {}
      }
    }
  }

  // 4. Phrases & Config Migration
  const targetPhrases = path.join(getConfigDir(), 'phrases.json');
  if (!fs.existsSync(targetPhrases) && !fs.existsSync(path.join(targetDataDir, 'phrases.json'))) {
    const appRoot = getAppRoot();
    const candPhrases = [
      path.join(appRoot, 'data', 'phrases.json'),
      path.join(appRoot, 'templates', 'phrases.json'),
      path.join(appRoot, 'release', 'templates', 'phrases.json')
    ];
    for (const cp of candPhrases) {
      if (fs.existsSync(cp)) {
        try {
          fs.copyFileSync(cp, targetPhrases);
          break;
        } catch {}
      }
    }
  }
}

/**
 * Initializes runtime directories, verifies strict write permissions,
 * executes legacy migration, and redirects OS temporary paths.
 *
 * If dataDir is not writable: outputs a fatal error and does NOT silently switch.
 */
export function initRuntimeEnvironment(): void {
  const dataDir = getDataDir();
  const pwTempDir = getPlaywrightTempDir();
  const cookiesDir = getBrowserProfileDir();
  const logsDir = getLogsDir();
  const configDir = getConfigDir();

  // 1. Auto-create data/, data/playwright-temp/, data/logs/, data/cookies/, data/config/
  const dirsToCreate = [dataDir, pwTempDir, cookiesDir, logsDir, configDir];
  for (const dir of dirsToCreate) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err: any) {
      const errMsg = `[FATAL] Data directory cannot be created ("${dir}"): ${err.message}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }
  }

  // 2. Strict write permission check on data/ (Requirement 3: Never silently switch)
  const testFile = path.join(dataDir, `.write_test_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
  } catch (err: any) {
    const errMsg = `[FATAL] Data directory "${dataDir}" is not writable! Cannot run SteamAIReplyBot. Error: ${err.message}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  // Check write permissions on playwright-temp
  const pwTestFile = path.join(pwTempDir, `.write_test_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(pwTestFile, 'ok', 'utf8');
    fs.unlinkSync(pwTestFile);
  } catch (err: any) {
    const errMsg = `[FATAL] Playwright temporary directory "${pwTempDir}" is not writable! Error: ${err.message}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  // Check write permissions on logs
  const logsTestFile = path.join(logsDir, `.write_test_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(logsTestFile, 'ok', 'utf8');
    fs.unlinkSync(logsTestFile);
  } catch (err: any) {
    const errMsg = `[FATAL] Logs directory "${logsDir}" is not writable! Error: ${err.message}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  // Check write permissions on cookies
  const cookiesTestFile = path.join(cookiesDir, `.write_test_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(cookiesTestFile, 'ok', 'utf8');
    fs.unlinkSync(cookiesTestFile);
  } catch (err: any) {
    const errMsg = `[FATAL] Cookies directory "${cookiesDir}" is not writable! Error: ${err.message}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  // 3. Perform seamless one-time legacy data migration
  try {
    migrateLegacyDataIfNeeded();
  } catch (err: any) {
    writeStartupLog('MIGRATION_ERROR', { error: err.message });
  }

  // 4. Override process environment variables for all subprocesses & Playwright
  process.env.STEAM_AI_REPLYBOT_DATA_DIR = dataDir;
  process.env.STEAM_BOT_DATA_DIR = dataDir;
  process.env.TEMP = pwTempDir;
  process.env.TMP = pwTempDir;
  process.env.TMPDIR = pwTempDir;
  process.env.PLAYWRIGHT_ARTIFACTS_PATH = pwTempDir;
  process.env.PWTEST_SOCKETS_DIR = pwTempDir;

  // 5. Monkey-patch Node os.tmpdir() so all internal Node & Playwright calls resolve here
  os.tmpdir = () => pwTempDir;

  // 6. Clean up stale temp artifacts in playwright-temp older than 24 hours (non-blocking)
  try {
    const entries = fs.readdirSync(pwTempDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith('playwright-') || entry.startsWith('tmp-')) {
        const fullPath = path.join(pwTempDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {
          // Ignore files currently locked by active browser instances
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

export interface DatabaseDiagnostics {
  DATABASE_PATH: string;
  DATABASE_EXISTS: boolean;
  DATABASE_SIZE: number;
  DATABASE_CREATED_AT: string;
  DATABASE_LAST_WRITE_TIME: string;
  BROWSER_PROFILE_PATH: string;
  BROWSER_PROFILE_EXISTS: boolean;
}

export function getDatabaseDiagnostics(): DatabaseDiagnostics {
  const dbPath = getDatabasePath();
  const dbExists = fs.existsSync(dbPath);
  let size = 0;
  let createdAt = 'N/A';
  let lastWriteTime = 'N/A';

  if (dbExists) {
    try {
      const stat = fs.statSync(dbPath);
      size = stat.size;
      createdAt = (stat.birthtime || stat.ctime).toISOString();
      lastWriteTime = stat.mtime.toISOString();
    } catch {}
  }

  const profilePath = getBrowserProfileDir();
  const profileExists = fs.existsSync(profilePath);

  return {
    DATABASE_PATH: dbPath,
    DATABASE_EXISTS: dbExists,
    DATABASE_SIZE: size,
    DATABASE_CREATED_AT: createdAt,
    DATABASE_LAST_WRITE_TIME: lastWriteTime,
    BROWSER_PROFILE_PATH: profilePath,
    BROWSER_PROFILE_EXISTS: profileExists
  };
}
