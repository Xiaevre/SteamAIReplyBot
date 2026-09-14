import * as net from 'net';
import * as fs from 'fs';
import { getLockFilePath } from './paths';

export const BOT_INSTANCE_MUTEX_PORT = 31989;

export interface InstanceInfo {
  pid: number;
  url: string | null;
  noUi: boolean;
  startedAt: string;
}

export class BotInstanceLock {
  private server: net.Server | null = null;
  private lockFilePath: string;
  private currentInfo: InstanceInfo;

  constructor(noUi: boolean = false) {
    this.lockFilePath = getLockFilePath();
    this.currentInfo = {
      pid: process.pid,
      url: noUi ? null : 'http://127.0.0.1:3000',
      noUi,
      startedAt: new Date().toISOString()
    };
  }

  public updateInfo(partial: Partial<InstanceInfo>): void {
    Object.assign(this.currentInfo, partial);
    this.syncLockFile();
  }

  private syncLockFile(): void {
    try {
      fs.writeFileSync(this.lockFilePath, JSON.stringify(this.currentInfo, null, 2), 'utf8');
    } catch {}
  }

  public async acquire(): Promise<{ acquired: boolean; existing?: InstanceInfo }> {
    return new Promise<{ acquired: boolean; existing?: InstanceInfo }>((resolve) => {
      const s = net.createServer((socket) => {
        try {
          socket.write(JSON.stringify(this.currentInfo) + '\n');
          socket.end();
        } catch {}
      });

      s.once('error', async (err: any) => {
        if (err.code === 'EADDRINUSE') {
          // Query if existing instance is actually alive and responsive
          const existing = await this.queryExistingInstance();
          if (existing && existing.pid > 0 && this.isProcessAlive(existing.pid)) {
            resolve({ acquired: false, existing });
            return;
          }
          // If socket cannot be connected and lockfile pid is not alive, try alternative port
          const altPortAvailable = await this.tryListenAlternativePort(s);
          if (altPortAvailable) {
            this.syncLockFile();
            resolve({ acquired: true });
          } else {
            resolve({ acquired: false, existing });
          }
        } else {
          // In case of non-blocking socket anomaly, proceed as primary
          resolve({ acquired: true });
        }
      });

      s.once('listening', () => {
        this.server = s;
        this.syncLockFile();
        resolve({ acquired: true });
      });

      s.listen(BOT_INSTANCE_MUTEX_PORT, '127.0.0.1');
    });
  }

  private queryExistingInstance(): Promise<InstanceInfo> {
    return new Promise<InstanceInfo>((resolve) => {
      const socket = new net.Socket();
      let data = '';
      socket.setTimeout(800);
      socket.once('data', (chunk) => data += chunk.toString());
      socket.once('end', () => {
        try {
          const parsed = JSON.parse(data.trim());
          resolve(parsed);
        } catch {
          resolve(this.fallbackReadLockFile());
        }
      });
      socket.once('error', () => resolve(this.fallbackReadLockFile()));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(this.fallbackReadLockFile());
      });
      socket.connect(BOT_INSTANCE_MUTEX_PORT, '127.0.0.1');
    });
  }

  private fallbackReadLockFile(): InstanceInfo {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        return JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
      }
    } catch {}
    return {
      pid: 0,
      url: 'http://127.0.0.1:3000',
      noUi: false,
      startedAt: new Date().toISOString()
    };
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // process.kill(pid, 0) checks existence without killing
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async tryListenAlternativePort(oldServer: net.Server): Promise<boolean> {
    try {
      oldServer.close();
    } catch {}

    const altPorts = [31989, 31990, 31900, 32000, 35000, 41988];
    for (const port of altPorts) {
      const ok = await new Promise<boolean>((res) => {
        const s = net.createServer((socket) => {
          try {
            socket.write(JSON.stringify(this.currentInfo) + '\n');
            socket.end();
          } catch {}
        });
        s.once('error', () => {
          try { s.close(); } catch {}
          res(false);
        });
        s.once('listening', () => {
          this.server = s;
          res(true);
        });
        s.listen(port, '127.0.0.1');
      });

      if (ok) return true;
    }
    return false;
  }

  public release(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch {}
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
  }
}
