import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ApiRouter, ApiContext } from './apiRouter';
import { getRuntimeRoot } from '../utils/paths';

export class WebServer {
  private server: http.Server | null = null;
  private apiRouter: ApiRouter;
  private port: number = 3000;
  private host: string = '127.0.0.1';
  private staticDir: string;

  constructor(private ctx: ApiContext) {
    this.apiRouter = new ApiRouter(ctx);
    this.staticDir = this.resolveStaticDir();
  }

  private resolveStaticDir(): string {
    const root = getRuntimeRoot();
    const candidates = [
      path.resolve(root, 'dist', 'ui'),
      path.resolve(root, 'src', 'ui'),
      path.resolve(__dirname, '..', 'ui'),
      path.resolve(__dirname, 'ui')
    ];

    for (const dir of candidates) {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) {
        return dir;
      }
    }
    // Default fallback to src/ui
    return path.resolve(root, 'src', 'ui');
  }

  public getPort(): number {
    return this.port;
  }

  public getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  public async start(preferredPort: number = 3000): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let currentPort = preferredPort;
      const maxPortAttempts = 20;

      const tryListen = (portToTry: number) => {
        const srv = http.createServer(async (req, res) => {
          this.handleHttpRequest(req, res);
        });

        srv.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            srv.close();
            if (portToTry - preferredPort < maxPortAttempts) {
              tryListen(portToTry + 1);
            } else {
              reject(new Error(`Could not find an open port between ${preferredPort} and ${portToTry}`));
            }
          } else {
            reject(err);
          }
        });

        srv.once('listening', () => {
          this.server = srv;
          this.port = portToTry;
          this.ctx.logger.info('WEB_SERVER_STARTED', { host: this.host, port: this.port, url: this.getUrl() });
          resolve(this.port);
        });

        srv.listen(portToTry, this.host);
      };

      tryListen(preferredPort);
    });
  }

  public async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Enable CORS for local convenience
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const hostHeader = req.headers.host || `${this.host}:${this.port}`;
    const parsedUrl = new URL(req.url || '/', `http://${hostHeader}`);

    // 1. Route API requests
    if (parsedUrl.pathname.startsWith('/api/')) {
      let body: any = undefined;
      if (req.method === 'POST') {
        try {
          body = await this.readRequestBody(req);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON request body' }));
          return;
        }
      }

      const { status, data } = await this.apiRouter.handleRequest(parsedUrl, req.method || 'GET', body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }

    // 2. Route Static UI Assets
    this.serveStaticFile(parsedUrl.pathname, res);
  }

  private serveStaticFile(reqPath: string, res: http.ServerResponse): void {
    let relativePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
    let safePath = path.normalize(path.join(this.staticDir, relativePath));

    if (!safePath.startsWith(this.staticDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
      // Fallback to index.html for SPA
      safePath = path.join(this.staticDir, 'index.html');
    }

    if (!fs.existsSync(safePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('UI file not found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    try {
      const content = fs.readFileSync(safePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading static file: ' + e.message);
    }
  }

  private readRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }
}
