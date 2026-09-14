import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../utils/paths';

export interface DatabaseStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface DatabaseConnection {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

export class AppDatabase {
  private db: DatabaseConnection;
  private dbPath: string;

  constructor(customPath?: string) {
    this.dbPath = customPath || getDatabasePath();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = this.initConnection();
    this.configurePragmas();
  }

  private initConnection(): DatabaseConnection {
    // 1. Try loading better-sqlite3
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BetterSqlite3 = require('better-sqlite3');
      const conn = new BetterSqlite3(this.dbPath);
      return conn;
    } catch (err: any) {
      // 2. Resilient fallback to node:sqlite if better-sqlite3 native addon is not built
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DatabaseSync } = require('node:sqlite');
        const syncDb = new DatabaseSync(this.dbPath);
        return {
          exec: (sql: string) => syncDb.exec(sql),
          prepare: (sql: string) => syncDb.prepare(sql),
          transaction: <T extends (...args: any[]) => any>(fn: T): T => {
            return ((...args: any[]) => {
              syncDb.exec('BEGIN');
              try {
                const res = fn(...args);
                syncDb.exec('COMMIT');
                return res;
              } catch (e) {
                syncDb.exec('ROLLBACK');
                throw e;
              }
            }) as T;
          },
          close: () => syncDb.close()
        };
      } catch (e2: any) {
        throw new Error(
          `Failed to initialize SQLite database. better-sqlite3 error: ${err.message}. node:sqlite error: ${e2.message}`
        );
      }
    }
  }

  private configurePragmas(): void {
    try {
      this.db.exec('PRAGMA busy_timeout = 10000;');
      this.db.exec('PRAGMA temp_store = MEMORY;');
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      // Cache size in KiB (-2000 = ~2MB cache for low memory consumption)
      this.db.exec('PRAGMA cache_size = -2000;');
    } catch (e: any) {
      console.warn('[DB] Pragma configuration warning:', e.message);
    }
  }

  public getConnection(): DatabaseConnection {
    return this.db;
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public prepare(sql: string): DatabaseStatement {
    return this.db.prepare(sql);
  }

  public transaction<T extends (...args: any[]) => any>(fn: T): T {
    return this.db.transaction(fn);
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore on shutdown
    }
  }
}
