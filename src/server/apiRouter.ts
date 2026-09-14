import * as fs from 'fs';
import * as path from 'path';
import { TaskScheduler } from '../scheduler/taskScheduler';
import { AppDatabase } from '../db/database';
import { ReplyTasksRepository } from '../db/repositories/replyTasks';
import { CommentsRepository } from '../db/repositories/comments';
import { RuntimeControl } from '../config/runtimeControl';
import { BotConfig } from '../config/schema';
import { getConfigPath } from '../utils/paths';
import { VisualReplyLibrary, VisualReplyItem, VisualItemType } from '../reply/visualLibrary';
import { KnowledgeStore } from '../profile/knowledgeStore';
import { WindowsServiceHelper } from '../utils/service';

import { HolidayRepository } from '../db/repositories/holiday';

export interface ApiContext {
  scheduler?: TaskScheduler;
  db: AppDatabase;
  config: BotConfig;
  logger: any;
}

export class ApiRouter {
  private replyTasksRepo: ReplyTasksRepository;
  private commentsRepo: CommentsRepository;
  private holidayRepo: HolidayRepository;
  private isLoginInProgress: boolean = false;
  private fallbackVisualLibrary: VisualReplyLibrary | null = null;

  constructor(private ctx: ApiContext) {
    this.replyTasksRepo = new ReplyTasksRepository(this.ctx.db);
    this.commentsRepo = new CommentsRepository(this.ctx.db);
    this.holidayRepo = new HolidayRepository(this.ctx.db);
  }

  public async handleRequest(reqUrl: URL, method: string, body?: any): Promise<{ status: number; data: any }> {
    const pathname = reqUrl.pathname;

    try {
      // 1. GET /api/status
      if (pathname === '/api/status' && method === 'GET') {
        const rc = RuntimeControl.load();
        const todayStr = new Date().toISOString().substring(0, 10);
        const holidayReplies = this.holidayRepo.getCountSentToday(todayStr);
        const todayStats = this.commentsRepo.getStatsToday(holidayReplies);
        const summary = this.ctx.scheduler
          ? this.ctx.scheduler.getStatusSummary()
          : {
              isRunning: false,
              botMode: rc.mode,
              lifecycleState: rc.lifecycleState,
              browserState: 'RELEASED',
              lastError: rc.lastError || null,
              botEnabled: rc.botEnabled,
              emergencyStop: rc.emergencyStop,
              sessionState: 'unknown',
              accountName: null,
              lastPolledAt: null,
              nextPolledAt: null,
              lastSendResult: null,
              uptimeSeconds: 0,
              memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
              stats: {
                ...todayStats,
                holidayReplies: holidayReplies
              }
            };
        return { status: 200, data: { success: true, loginInProgress: this.isLoginInProgress, ...summary } };
      }

      // 2. GET /api/session
      if (pathname === '/api/session' && method === 'GET') {
        if (!this.ctx.scheduler?.sessionManager) {
          return {
            status: 200,
            data: {
              success: true,
              loginInProgress: this.isLoginInProgress,
              health: {
                valid: false,
                status: 'SESSION_INVALID',
                reason: 'SESSION_MANAGER_UNAVAILABLE'
              }
            }
          };
        }
        const health = await this.ctx.scheduler.sessionManager.checkSessionHealth();
        return { status: 200, data: { success: true, loginInProgress: this.isLoginInProgress, health } };
      }

      // 3. GET /api/stats
      if (pathname === '/api/stats' && method === 'GET') {
        const todayStr = new Date().toISOString().substring(0, 10);
        const holidayReplies = this.holidayRepo.getCountSentToday(todayStr);
        const todayStats = this.commentsRepo.getStatsToday(holidayReplies);
        const farFutureIso = new Date(Date.now() + 86400000 * 365).toISOString();
        const pendingCount = this.replyTasksRepo.getPendingScheduledTasks(farFutureIso).length;
        const uncertainCount = this.replyTasksRepo.getUncertainTasks().length;
        const waitingForLoginCount = this.replyTasksRepo.getWaitingForLoginTasksCount();

        return {
          status: 200,
          data: {
            success: true,
            todayStats: {
              ...todayStats,
              holidayReplies
            },
            pendingCount,
            uncertainCount,
            waitingForLoginCount
          }
        };
      }

      // 4. GET /api/tasks
      if (pathname === '/api/tasks' && method === 'GET') {
        const statusFilter = reqUrl.searchParams.get('status') || 'all';
        const limitParam = parseInt(reqUrl.searchParams.get('limit') || '50', 10);
        const limit = isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 200);

        const tasks = this.replyTasksRepo.getRecentTasksDetailed(limit, statusFilter);
        return { status: 200, data: { success: true, count: tasks.length, tasks } };
      }

      // 5. GET /api/logs
      if (pathname === '/api/logs' && method === 'GET') {
        const limitParam = parseInt(reqUrl.searchParams.get('limit') || '100', 10);
        const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(limitParam, 1), 500);

        const logs = this.ctx.logger.getRecentLogs
          ? this.ctx.logger.getRecentLogs(limit)
          : [];

        return { status: 200, data: { success: true, count: logs.length, logs } };
      }

      // 6. GET /api/config (DeepSeek API Key strictly masked)
      if (pathname === '/api/config' && method === 'GET') {
        const safeConfig = { ...this.ctx.config };
        if (safeConfig.DEEPSEEK_API_KEY) {
          const raw = safeConfig.DEEPSEEK_API_KEY.trim();
          if (raw.length > 8) {
            safeConfig.DEEPSEEK_API_KEY = `${raw.substring(0, 3)}****${raw.substring(raw.length - 4)}`;
          } else if (raw.length > 0) {
            safeConfig.DEEPSEEK_API_KEY = '****';
          }
        }
        return { status: 200, data: { success: true, config: safeConfig } };
      }

      // 7. POST /api/config
      if (pathname === '/api/config' && method === 'POST') {
        if (!body || typeof body !== 'object') {
          return { status: 400, data: { success: false, error: 'Invalid configuration payload' } };
        }

        // Mask Protection: never overwrite real secret with masked placeholder
        if (body.DEEPSEEK_API_KEY !== undefined) {
          const keyStr = String(body.DEEPSEEK_API_KEY).trim();
          if (!keyStr || keyStr.includes('****') || keyStr.includes('***')) {
            delete body.DEEPSEEK_API_KEY;
          }
        }

        const allowedKeys = [
          'STEAM_PROFILE_URL',
          'DEEPSEEK_API_KEY',
          'DEEPSEEK_MODEL',
          'DEEPSEEK_BASE_URL',
          'CHECK_INTERVAL_MIN_SECONDS',
          'CHECK_INTERVAL_MAX_SECONDS',
          'MIN_REPLY_DELAY_SECONDS',
          'MAX_REPLY_DELAY_SECONDS',
          'MAX_REPLIES_PER_HOUR',
          'MAX_REPLIES_PER_DAY',
          'MAX_HOLIDAY_MESSAGES_PER_DAY',
          'HOLIDAY_ACTIVE_DAYS',
          'HOLIDAY_SEND_START',
          'HOLIDAY_SEND_END',
          'DEFAULT_LANGUAGE',
          'HEADLESS',
          'DRY_RUN'
        ];

        const updated: any = {};
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            updated[key] = body[key];
            (this.ctx.config as any)[key] = body[key];
          }
        }

        // Save to config.json
        const configJsonPath = getConfigPath();
        try {
          let existing: any = {};
          if (fs.existsSync(configJsonPath)) {
            existing = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
          }
          const merged = { ...existing, ...updated };
          const configDir = path.dirname(configJsonPath);
          if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (e: any) {
          return { status: 500, data: { success: false, error: `Failed to save config.json: ${e.message}` } };
        }

        this.ctx.logger.info('CONFIG_UPDATED_VIA_API', { keys: Object.keys(updated) });
        return { status: 200, data: { success: true, updatedConfig: this.ctx.config } };
      }

      // 8. Control Actions: /api/bot/*
      if (pathname === '/api/bot/start' && method === 'POST') {
        RuntimeControl.update({ botEnabled: true, emergencyStop: false });
        this.ctx.logger.info('BOT_STARTED_VIA_API');
        if (this.ctx.scheduler && typeof this.ctx.scheduler.requestImmediatePoll === 'function') {
          this.ctx.scheduler.requestImmediatePoll();
        }
        return { status: 200, data: { success: true, botEnabled: true, emergencyStop: false } };
      }

      if (pathname === '/api/bot/pause' && method === 'POST') {
        RuntimeControl.update({ botEnabled: false });
        this.ctx.logger.info('BOT_PAUSED_VIA_API');
        return { status: 200, data: { success: true, botEnabled: false, emergencyStop: false } };
      }

      if (pathname === '/api/bot/emergency-stop' && method === 'POST') {
        RuntimeControl.update({ emergencyStop: true });
        this.ctx.logger.warn('EMERGENCY_STOP_TRIGGERED_VIA_API');
        return { status: 200, data: { success: true, emergencyStop: true } };
      }

      if (pathname === '/api/bot/mode' && method === 'POST') {
        const targetMode = body?.mode;
        if (!targetMode || !['LOCAL_ONLY', 'AI_ENHANCED', 'DISABLED'].includes(targetMode)) {
          return { status: 400, data: { success: false, error: `Invalid mode: ${targetMode}. Must be LOCAL_ONLY, AI_ENHANCED, or DISABLED.` } };
        }
        if (this.ctx.scheduler) {
          this.ctx.scheduler.setBotMode(targetMode);
        } else {
          RuntimeControl.update({ mode: targetMode });
        }
        this.ctx.logger.info('BOT_MODE_UPDATED_VIA_API', { mode: targetMode });
        return { status: 200, data: { success: true, mode: targetMode, botEnabled: targetMode !== 'DISABLED' } };
      }

      if (pathname === '/api/bot/stop' && method === 'POST') {
        if (!this.ctx.scheduler) {
          return { status: 503, data: { success: false, error: 'TaskScheduler not available' } };
        }
        const result = await this.ctx.scheduler.stopBot();
        this.ctx.logger.info('BOT_STOPPED_VIA_API', { result });
        return {
          status: 200,
          data: {
            success: result.success,
            message: result.message,
            lifecycleState: this.ctx.scheduler.lifecycleState,
            browserState: this.ctx.scheduler.getBrowserState()
          }
        };
      }

      if (pathname === '/api/bot/resume' && method === 'POST') {
        RuntimeControl.update({ botEnabled: true, emergencyStop: false });
        this.ctx.logger.info('BOT_RESUMED_VIA_API');

        if (!this.ctx.scheduler) {
          return {
            status: 200,
            data: {
              success: true,
              botEnabled: true,
              emergencyStop: false,
              message: 'Bot resumed.'
            }
          };
        }

        let result: { success: boolean; message?: string } = { success: true, message: 'Bot successfully resumed.' };
        if (this.ctx.scheduler.lifecycleState === 'STOPPED' || !this.ctx.scheduler.isRunning) {
          result = await this.ctx.scheduler.resumeBot();
        } else {
          if (typeof this.ctx.scheduler.requestImmediatePoll === 'function') {
            this.ctx.scheduler.requestImmediatePoll();
          }
        }

        return {
          status: result.success ? 200 : 500,
          data: {
            success: result.success,
            message: result.message,
            botEnabled: true,
            emergencyStop: false,
            botMode: this.ctx.scheduler.botMode,
            lifecycleState: this.ctx.scheduler.lifecycleState,
            browserState: typeof this.ctx.scheduler.getBrowserState === 'function' ? this.ctx.scheduler.getBrowserState() : 'RELEASED',
            lastError: this.ctx.scheduler.lastError
          }
        };
      }

      // 8.5 Autostart Endpoints
      if (pathname === '/api/autostart/status' && method === 'GET') {
        const status = WindowsServiceHelper.getAutostartStatus();
        return { status: 200, data: { success: true, ...status } };
      }

      if (pathname === '/api/autostart/enable' && method === 'POST') {
        const trigger = body?.trigger === 'ONLOGON' ? 'ONLOGON' : 'ONSTART';
        const result = WindowsServiceHelper.enableAutostart({ trigger });
        return { status: result.success ? 200 : 500, data: result };
      }

      if (pathname === '/api/autostart/disable' && method === 'POST') {
        const result = WindowsServiceHelper.disableAutostart();
        return { status: result.success ? 200 : 500, data: result };
      }

      // 9. Session Actions: /api/session/*
      if (pathname === '/api/session/check' && method === 'POST') {
        if (!this.ctx.scheduler?.sessionManager) {
          return { status: 503, data: { success: false, error: 'SessionManager not available' } };
        }
        this.ctx.logger.info('SESSION_CHECK_TRIGGERED_VIA_API');
        const health = await this.ctx.scheduler.sessionManager.checkSessionHealth();
        return { status: 200, data: { success: true, health } };
      }

      if (pathname === '/api/session/login' && method === 'POST') {
        if (!this.ctx.scheduler) {
          return { status: 503, data: { success: false, error: 'TaskScheduler not available' } };
        }
        if (this.isLoginInProgress || this.ctx.scheduler.isInteractiveLoginActive) {
          return {
            status: 409,
            data: {
              success: false,
              alreadyInProgress: true,
              message: 'Steam 登录窗口已打开，请完成登录。'
            }
          };
        }

        this.isLoginInProgress = true;
        this.ctx.logger.info('INTERACTIVE_LOGIN_TRIGGERED_VIA_API');
        
        // Launch interactive login workflow asynchronously without blocking HTTP response
        const scheduler = this.ctx.scheduler;

        setImmediate(async () => {
          try {
            await scheduler.runInteractiveLoginWorkflow();
          } catch (err: any) {
            console.error('[API Login Error]:', err.message);
          } finally {
            this.isLoginInProgress = false;
          }
        });

        return {
          status: 200,
          data: {
            success: true,
            alreadyInProgress: false,
            message: '正在准备 Steam 登录窗口…'
          }
        };
      }

      // 10. Visual Reply Library: /api/visual-replies/*
      if (pathname === '/api/visual-replies' && method === 'GET') {
        const lib = this.getVisualLibrary();
        const typeParam = reqUrl.searchParams.get('type') as VisualItemType | null;
        const enabledParam = reqUrl.searchParams.get('enabledOnly');
        const items = lib.getAllItems({
          type: typeParam || undefined,
          enabledOnly: enabledParam === 'true'
        });
        return { status: 200, data: { success: true, count: items.length, items } };
      }

      if (pathname === '/api/visual-replies' && method === 'POST') {
        if (!body || !body.id || !body.content) {
          return { status: 400, data: { success: false, error: 'Both id and content are required' } };
        }
        const lib = this.getVisualLibrary();
        const item: VisualReplyItem = {
          id: String(body.id).trim(),
          type: (body.type || 'custom') as VisualItemType,
          content: String(body.content),
          enabled: body.enabled !== false,
          tags: Array.isArray(body.tags) ? body.tags : (typeof body.tags === 'string' ? body.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []),
          mood: Array.isArray(body.mood) ? body.mood : (typeof body.mood === 'string' ? body.mood.split(',').map((m: string) => m.trim()).filter(Boolean) : []),
          style: body.style || 'default',
          weight: typeof body.weight === 'number' && body.weight > 0 ? body.weight : 10,
          description: body.description || undefined
        };
        lib.saveItem(item, body.fileCategory);
        this.ctx.logger.info('VISUAL_REPLY_SAVED_VIA_API', { id: item.id, type: item.type });
        return { status: 200, data: { success: true, item } };
      }

      if (pathname === '/api/visual-replies/toggle' && method === 'POST') {
        if (!body || !body.id) {
          return { status: 400, data: { success: false, error: 'id is required' } };
        }
        const lib = this.getVisualLibrary();
        const updated = lib.toggleEnabled(body.id, body.enabled);
        if (!updated) {
          return { status: 404, data: { success: false, error: `Item not found: ${body.id}` } };
        }
        this.ctx.logger.info('VISUAL_REPLY_TOGGLED_VIA_API', { id: updated.id, enabled: updated.enabled });
        return { status: 200, data: { success: true, item: updated } };
      }

      if ((pathname === '/api/visual-replies' && method === 'DELETE') ||
          (pathname === '/api/visual-replies/delete' && method === 'POST') ||
          (pathname.startsWith('/api/visual-replies/') && method === 'DELETE')) {
        let targetId = body?.id || reqUrl.searchParams.get('id');
        if (!targetId && pathname.startsWith('/api/visual-replies/')) {
          const sub = pathname.replace('/api/visual-replies/', '').trim();
          if (sub && sub !== 'delete' && sub !== 'toggle') targetId = sub;
        }
        if (!targetId) {
          return { status: 400, data: { success: false, error: 'Item id is required for deletion' } };
        }
        const lib = this.getVisualLibrary();
        const deleted = lib.deleteItem(targetId);
        this.ctx.logger.info('VISUAL_REPLY_DELETED_VIA_API', { id: targetId, deleted });
        return { status: 200, data: { success: true, deleted } };
      }

      // -------------------------------------------------------------
      // Profile Analysis & Knowledge Base Endpoints
      // -------------------------------------------------------------
      if (pathname === '/api/profile-analysis/status' && method === 'GET') {
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        return { status: 200, data: { success: true, meta: store.loadMeta() } };
      }

      if (pathname === '/api/profile-analysis/snapshot' && method === 'GET') {
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        const snapshot = store.loadSnapshot();
        return { status: 200, data: { success: true, snapshot } };
      }

      if (pathname === '/api/profile-analysis/knowledge' && method === 'GET') {
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        return { status: 200, data: { success: true, knowledge: store.loadKnowledge() } };
      }

      if (pathname === '/api/profile-analysis/persona-suggestions' && method === 'GET') {
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        return { status: 200, data: { success: true, suggestions: store.loadPersonaSuggestions() } };
      }

      if (pathname === '/api/profile-analysis/persona' && method === 'GET') {
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        return { status: 200, data: { success: true, persona: store.loadFormalPersona() } };
      }

      if (pathname === '/api/profile-analysis/persona' && method === 'POST') {
        if (!body || typeof body !== 'object') {
          return { status: 400, data: { success: false, error: 'Invalid persona payload' } };
        }
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        store.saveFormalPersona(body);
        return { status: 200, data: { success: true, persona: store.loadFormalPersona() } };
      }

      if (pathname === '/api/profile-analysis/sync' && method === 'POST') {
        if (!this.ctx.scheduler) {
          return { status: 500, data: { success: false, error: 'TaskScheduler not available' } };
        }
        const manager = this.ctx.scheduler.profileAnalysisManager;
        if (!manager) {
          return { status: 500, data: { success: false, error: 'ProfileAnalysisManager not configured' } };
        }

        if (manager.isBusy()) {
          return {
            status: 409,
            data: {
              success: false,
              error: 'A sync or analysis job is already in progress',
              meta: manager.getStatus()
            }
          };
        }

        const browserManager = this.ctx.scheduler.browserManager;
        if (!browserManager) {
          return { status: 500, data: { success: false, error: 'SteamBrowserManager not available' } };
        }

        const knownSteamId = body?.steamId;
        // Trigger sync in background without blocking HTTP response
        manager.syncProfile(browserManager, knownSteamId).catch(err => {
          this.ctx.logger.error('PROFILE_ANALYSIS_UNCAUGHT_SYNC_ERROR', { error: err?.message || String(err) });
        });

        return {
          status: 200,
          data: {
            success: true,
            status: 'syncing',
            message: 'Profile sync job started',
            meta: manager.getStatus()
          }
        };
      }

      if (pathname === '/api/profile-analysis/analyze' && method === 'POST') {
        if (!this.ctx.scheduler) {
          return { status: 500, data: { success: false, error: 'TaskScheduler not available' } };
        }
        const manager = this.ctx.scheduler.profileAnalysisManager;
        if (!manager) {
          return { status: 500, data: { success: false, error: 'ProfileAnalysisManager not configured' } };
        }

        // Run analyze asynchronously
        const force = Boolean(body?.force);
        manager.analyzeProfile({ force });

        return {
          status: 200,
          data: {
            success: true,
            message: 'Profile analysis job started in background',
            meta: manager.getStatus()
          }
        };
      }

      if (pathname === '/api/profile-analysis/suggestions/apply' && method === 'POST') {
        if (!body || !body.id) {
          return { status: 400, data: { success: false, error: 'Suggestion id is required' } };
        }
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        const res = store.applySuggestion(body.id);
        return { status: 200, data: { ...res, persona: store.loadFormalPersona() } };
      }

      if (pathname === '/api/profile-analysis/suggestions/reject' && method === 'POST') {
        if (!body || !body.id) {
          return { status: 400, data: { success: false, error: 'Suggestion id is required' } };
        }
        const store = this.ctx.scheduler?.knowledgeStore || new KnowledgeStore();
        const res = store.rejectSuggestion(body.id);
        return { status: 200, data: res };
      }

      return { status: 404, data: { success: false, error: `Route not found: ${method} ${pathname}` } };
    } catch (err: any) {
      return { status: 500, data: { success: false, error: err.message || 'Internal API error' } };
    }
  }

  private getVisualLibrary(): VisualReplyLibrary {
    if (this.ctx.scheduler && this.ctx.scheduler.visualReplyLibrary) {
      return this.ctx.scheduler.visualReplyLibrary;
    }
    if (!this.fallbackVisualLibrary) {
      this.fallbackVisualLibrary = new VisualReplyLibrary();
    }
    return this.fallbackVisualLibrary;
  }
}
