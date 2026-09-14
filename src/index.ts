import * as fs from 'fs';
import { initRuntimeEnvironment, getLockFilePath, getRuntimeRoot, writeStartupLog, getDatabaseDiagnostics } from './utils/paths';
import { loadConfig } from './config/env';
import { RuntimeControl } from './config/runtimeControl';
import { AppDatabase } from './db/database';
import { runMigrations } from './db/migrations';
import { CommentsRepository } from './db/repositories/comments';
import { ReplyTasksRepository } from './db/repositories/replyTasks';
import { TaskScheduler } from './scheduler/taskScheduler';
import { SteamBrowserManager } from './steam/browser';
import { SteamSessionManager } from './steam/session';
import { executeDiagnoseSend } from './steam/diagnoseSend';
import { WindowsServiceHelper } from './utils/service';
import { Logger } from './utils/logger';
import { WebServer } from './server/webServer';
import { BotInstanceLock } from './utils/instanceLock';

async function main() {
  // Initialize and guarantee runtime directories and environment before any subsystems load
  initRuntimeEnvironment();

  writeStartupLog('BOOT_START');
  writeStartupLog('BOOT_ROOT', { root: getRuntimeRoot() });
  writeStartupLog('BOOT_NODE_PATH', { path: process.execPath });
  writeStartupLog('BOOT_ENTRY_PATH', { file: __filename });
  writeStartupLog('BOOT_CWD', { cwd: process.cwd() });
  writeStartupLog('BOOT_ARGS', { args: process.argv.slice(2) });

  const allArgs = process.argv.slice(1);
  const args = allArgs.filter(a => a !== '[eval]' && !a.endsWith('.js') && !a.endsWith('.ts') && a !== '--');
  const logger = new Logger();

  let configPath: string | undefined;
  const configIdx = allArgs.indexOf('--config');
  if (configIdx >= 0 && allArgs[configIdx + 1]) {
    configPath = allArgs[configIdx + 1];
  }

  const config = loadConfig(configPath);

  // Parse CLI flags overriding config
  if (args.includes('--dry-run')) {
    config.DRY_RUN = true;
  }
  if (args.includes('--live')) {
    config.DRY_RUN = false;
  }
  if (args.includes('--headless') || args.includes('--background')) {
    config.HEADLESS = true;
  }
  if (args.includes('--visible')) {
    config.HEADLESS = false;
  }
  if (args.includes('--pause')) {
    config.BOT_ENABLED = false;
  }
  if (args.includes('--stop')) {
    config.EMERGENCY_STOP = true;
  }

  // Windows Task Scheduler Autostart commands
  if (args.includes('--autostart-status') || args.includes('--service-status')) {
    const status = WindowsServiceHelper.getAutostartStatus();
    console.log('\n======================================================');
    console.log('       Windows 任务计划自启动状态 (Task Scheduler)');
    console.log('======================================================');
    console.log(`- 任务名称:     ${status.taskName}`);
    console.log(`- 自启动已配置: ${status.enabled ? '是 (ENABLED)' : '否 (DISABLED)'}`);
    if (status.trigger) console.log(`- 触发模式:     ${status.trigger}`);
    if (status.targetCommand) console.log(`- 执行命令:     ${status.targetCommand}`);
    console.log(`- 详细信息:     ${status.details}`);
    console.log('======================================================\n');
    process.exit(0);
  }

  if (args.includes('--autostart-enable') || args.includes('--install-service')) {
    const triggerIdx = allArgs.indexOf('--trigger');
    const trigger = triggerIdx >= 0 && allArgs[triggerIdx + 1]?.toUpperCase() === 'ONLOGON' ? 'ONLOGON' : 'ONSTART';
    const res = WindowsServiceHelper.enableAutostart({ trigger });
    if (res.success) {
      console.log(`[Autostart] ✅ 自启动已成功配置 (模式: ${trigger})。`);
      process.exit(0);
    } else {
      console.error(`[Autostart] ❌ 自启动配置失败: ${res.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--autostart-disable') || args.includes('--uninstall-service')) {
    const res = WindowsServiceHelper.disableAutostart();
    if (res.success) {
      console.log(`[Autostart] ✅ 自启动已成功禁用。`);
      process.exit(0);
    } else {
      console.error(`[Autostart] ❌ 禁用自启动失败: ${res.message}`);
      process.exit(1);
    }
  }

  // Initialize DB and Run Migrations
  const db = new AppDatabase();
  runMigrations(db);

  // Self-Diagnostics and Database Identity Fingerprint (Sections VI & VII)
  const dbDiag = getDatabaseDiagnostics();
  const commentsRepo = new CommentsRepository(db);
  const tasksRepo = new ReplyTasksRepository(db);
  const schemaVerRow = db.prepare('SELECT MAX(version) as ver FROM schema_version').get() as any;
  const schemaVersion = schemaVerRow?.ver || 0;
  const totalComments = commentsRepo.getTotalCount();
  const latestComment = commentsRepo.getLatestComment();
  const latestCommentId = latestComment ? latestComment.steam_comment_id : '(none)';
  const totalTasks = tasksRepo.getTotalCount();

  const dbIdentity = {
    databasePath: dbDiag.DATABASE_PATH,
    schemaVersion,
    totalComments,
    latestCommentId,
    totalReplyTasks: totalTasks
  };

  logger.info('DATABASE_DIAGNOSTICS', dbDiag);
  logger.info('DATABASE_IDENTITY', dbIdentity);
  writeStartupLog('DATABASE_DIAGNOSTICS', dbDiag);
  writeStartupLog('DATABASE_IDENTITY', dbIdentity);

  console.log('\n======================================================');
  console.log('       Steam AI Reply Bot - 存储与数据库自诊断');
  console.log('======================================================');
  console.log(`DATABASE_PATH:             ${dbDiag.DATABASE_PATH}`);
  console.log(`DATABASE_EXISTS:           ${dbDiag.DATABASE_EXISTS}`);
  console.log(`DATABASE_SIZE:             ${dbDiag.DATABASE_SIZE} bytes`);
  console.log(`DATABASE_CREATED_AT:       ${dbDiag.DATABASE_CREATED_AT}`);
  console.log(`DATABASE_LAST_WRITE_TIME:  ${dbDiag.DATABASE_LAST_WRITE_TIME}`);
  console.log(`BROWSER_PROFILE_PATH:      ${dbDiag.BROWSER_PROFILE_PATH}`);
  console.log(`BROWSER_PROFILE_EXISTS:    ${dbDiag.BROWSER_PROFILE_EXISTS}`);
  console.log('------------------------------------------------------');
  console.log(`DATABASE_IDENTITY:         [Schema v${schemaVersion}] Comments: ${totalComments} (Latest ID: ${latestCommentId}), Reply Tasks: ${totalTasks}`);
  console.log('======================================================\n');

  // Mode 1: Interactive Steam Login & Session Recovery
  if (args.includes('--login')) {
    const browserManager = new SteamBrowserManager(logger, {
      headless: false,
      executablePath: config.BROWSER_PATH || config.BROWSER_EXECUTABLE_PATH,
      browserMode: config.BROWSER_MODE,
      channel: config.BROWSER_CHANNEL
    });
    const sessionManager = new SteamSessionManager(browserManager, logger);

    try {
      const loginResult = await sessionManager.runInteractiveLogin();

      if (loginResult.type === 'LOGIN_SUCCESS' || loginResult.type === 'LOGIN_HEALTH_CHECK_UNAVAILABLE') {
        const replyTasksRepo = new ReplyTasksRepository(db);
        const resumed = replyTasksRepo.resumeWaitingForLoginTasks();
        if (resumed > 0) {
          console.log(`[Login] 已自动恢复 ${resumed} 个等待登录的回复任务进入队列。`);
        }
        logger.info('LOGIN_RESUMED_TASKS', { resumedCount: resumed, loginType: loginResult.type });
        db.close();
        process.exit(0);
      } else {
        db.close();
        process.exit(1);
      }
    } finally {
      await browserManager.close().catch(() => {});
    }
  }

  // Mode 1.5: Status Inspection Command
  if (args.includes('--status')) {
    console.log('\n======================================================');
    console.log('            Steam AI Reply Bot - 状态自检');
    console.log('======================================================');

    const browserManager = new SteamBrowserManager(logger, {
      headless: true,
      executablePath: config.BROWSER_PATH || config.BROWSER_EXECUTABLE_PATH,
      browserMode: config.BROWSER_MODE,
      channel: config.BROWSER_CHANNEL
    });
    const sessionManager = new SteamSessionManager(browserManager, logger);

    try {
      const health = await sessionManager.checkSessionHealth();
      const replyTasksRepo = new ReplyTasksRepository(db);
      const farFutureIso = new Date(Date.now() + 86400000 * 365).toISOString();
      const pendingTasks = replyTasksRepo.getPendingScheduledTasks(farFutureIso).length;
      const uncertainTasks = replyTasksRepo.getUncertainTasks().length;
      const waitingForLoginTasks = replyTasksRepo.getWaitingForLoginTasksCount();

      const runtimeState = RuntimeControl.load(config.BOT_ENABLED, config.EMERGENCY_STOP);
      const isEmergencyStopped = runtimeState.emergencyStop || config.EMERGENCY_STOP;

      console.log(`- Steam logged in:                   ${health.valid ? 'true' : 'false'}`);
      console.log(`- SteamID64:                         ${health.steamId64 || '(none)'}`);
      console.log(`- profile URL:                       ${health.profileUrl || config.STEAM_PROFILE_URL || '(none)'}`);
      console.log(`- sessionid:                         ${health.hasSessionIdCookie ? 'present' : 'absent'}`);
      console.log(`- steamLoginSecure:                  ${health.hasSteamLoginSecure ? 'present' : 'absent'}`);
      console.log(`- last successful authenticated check: ${sessionManager.getLastSuccessfulAuthCheck() || (health.valid ? health.checkedAt : 'never')}`);
      console.log(`- pending tasks:                     ${pendingTasks}`);
      console.log(`- uncertain tasks:                   ${uncertainTasks}`);
      console.log(`- waiting for login tasks:           ${waitingForLoginTasks}`);
      console.log(`- emergency stop 状态:               ${isEmergencyStopped ? 'ACTIVE (紧急停止中)' : 'INACTIVE (正常)'}`);
      console.log('======================================================\n');
    } catch (err: any) {
      console.error('❌ 获取状态失败:', err.message || err);
      logger.error('STATUS_CHECK_ERROR', { error: err.message || String(err) });
    } finally {
      await browserManager.close();
      db.close();
      process.exit(0);
    }
  }

  // Mode 2: Stats Display
  if (args.includes('--stats')) {
    const scheduler = new TaskScheduler(config, db, logger);
    scheduler.printPeriodicStats();
    db.close();
    process.exit(0);
  }

  // Mode 2.5: Diagnostic Send (Strict: Zero Auto-Retry, Complete Masked Request/Response Logging)
  const diagnoseSendIdx = allArgs.indexOf('--diagnose-send');
  if (diagnoseSendIdx >= 0) {
    const targetSteamId64 = allArgs[diagnoseSendIdx + 1];
    const textToSend = allArgs[diagnoseSendIdx + 2];
    if (!targetSteamId64 || !textToSend) {
      console.error('\n❌ 错误: 缺少参数。用法: --diagnose-send <steamId64> "<text>"');
      db.close();
      process.exit(1);
    }

    console.log('\n======================================================');
    console.log('       Steam Hybrid Comment Send 独立诊断工具');
    console.log('======================================================');
    console.log(`- 目标 SteamID64: ${targetSteamId64}`);
    console.log(`- 留言内容:       ${textToSend}`);
    console.log('- 模式:           单次发送诊断 (严格禁用自动重试)');
    console.log('======================================================\n');

    const browserManager = new SteamBrowserManager(logger, {
      headless: config.HEADLESS !== false,
      executablePath: config.BROWSER_PATH || config.BROWSER_EXECUTABLE_PATH,
      browserMode: config.BROWSER_MODE,
      channel: config.BROWSER_CHANNEL
    });

    try {
      const diagResult = await executeDiagnoseSend(browserManager, targetSteamId64, textToSend, logger);

      console.log('\n======================================================');
      console.log('                 诊断执行结果详情');
      console.log('======================================================');
      console.log(`1. 请求 URL:       ${diagResult.targetProfileUrl}`);
      console.log(`2. 请求 Endpoint:  ${diagResult.endpoint}`);
      console.log(`3. 请求 Method:    ${diagResult.method}`);
      console.log(`4. HTTP Status:    ${diagResult.httpStatus}`);
      console.log(`5. Steam success:  ${diagResult.success}`);
      if (diagResult.error) {
        console.log(`   Steam error:    "${diagResult.error}"`);
      }
      console.log(`6. 响应分类:       ${diagResult.classification}`);
      console.log(`7. 包含 HTML:      ${diagResult.hasCommentsHtml} (长度: ${diagResult.commentsHtmlLength})`);
      if (diagResult.parsedCommentId) {
        console.log(`8. 解析评论 ID:    ${diagResult.parsedCommentId}`);
      }
      console.log('\n--- 会话与凭证状态 ---');
      console.log(`- steamLoginSecure:  ${diagResult.sessionState.hasLoginCookie ? '存在' : '不存在 / 未登录'}`);
      console.log(`- sessionid:         ${diagResult.sessionState.hasSessionIdCookie ? '存在' : '不存在'}`);
      console.log(`- 页面 SteamID:      ${diagResult.sessionState.pageSteamId || '无 (未登录)'}`);
      console.log(`- 登录账号标签:      ${diagResult.sessionState.accountPulldown || '无 (未登录)'}`);

      console.log('\n--- 目标页面 DOM 状态 ---');
      console.log(`- 留言区容器存在:    ${diagResult.targetPageDom.hasCommentArea}`);
      console.log(`- 留言表单存在:      ${diagResult.targetPageDom.hasCommentForm}`);
      console.log(`- 文本输入框存在:    ${diagResult.targetPageDom.hasTextarea}`);
      if (diagResult.targetPageDom.restrictedNotice) {
        console.log(`- 权限限制提示:      "${diagResult.targetPageDom.restrictedNotice}"`);
      }

      console.log('\n--- 原始 Steam 响应内容 (Raw Response Body) ---');
      console.log(diagResult.rawResponseBody || '(空)');
      console.log('======================================================\n');
    } catch (err: any) {
      console.error('\n❌ 诊断执行异常:', err.message || err);
      logger.error('DIAGNOSE_SEND_EXCEPTION', { error: err.message || String(err) });
    } finally {
      await browserManager.close();
      db.close();
      process.exit(0);
    }
  }

  // Mode 3: Normal Long-Running Daemon
  // 0. Single-Instance Protection: check if bot is already running
  writeStartupLog('BOOT_LOCK_CHECK');
  const isNoUi = args.includes('--no-ui');
  const isBackground = args.includes('--background');
  const instanceLock = new BotInstanceLock(isNoUi || isBackground);
  const lockResult = await instanceLock.acquire();

  if (!lockResult.acquired) {
    const existing = lockResult.existing;
    const existingPid = existing?.pid || 'unknown';
    const existingUrl = existing?.url || 'http://127.0.0.1:3000';

    writeStartupLog('BOOT_ALREADY_RUNNING', { pid: existingPid, url: existingUrl, isBackground });
    if (!isBackground) {
      console.log('\n======================================================');
      console.log(`[SteamAIReplyBot] ⚠️ 已有实例在运行中 (PID: ${existingPid})`);
      if (!existing?.noUi) {
        console.log(`[SteamAIReplyBot] 🌐 正在为您打开已有 Web 管理面板: ${existingUrl}`);
      }
      console.log('======================================================\n');

      if (!existing?.noUi) {
        const { exec } = require('child_process');
        const startCmd = process.platform === 'win32'
          ? `start "" "${existingUrl}"`
          : (process.platform === 'darwin' ? `open "${existingUrl}"` : `xdg-open "${existingUrl}"`);
        exec(startCmd, () => {});
      }
    }

    db.close();
    process.exit(0);
  }

  writeStartupLog('BOOT_LOCK_ACQUIRED', { pid: process.pid });
  writeStartupLog('BOOT_NODE_START', { pid: process.pid });
  console.log('[SteamAIReplyBot] Starting long-running daemon...');
  const scheduler = new TaskScheduler(config, db, logger);

  // Initialize and start local Web Management Panel (unless --no-ui is specified)
  let webServer: WebServer | null = null;
  let serverPort: number | null = null;
  let webUrl: string | null = null;

  if (!isNoUi) {
    try {
      webServer = new WebServer({ scheduler, db, config, logger });
      serverPort = await webServer.start(3000);
      webUrl = `http://127.0.0.1:${serverPort}`;
      console.log(`[SteamAIReplyBot] 🌐 Web 管理面板已启动: ${webUrl}`);
      writeStartupLog('BOOT_WEB_SERVER', { port: serverPort, url: webUrl });

      instanceLock.updateInfo({ url: webUrl, noUi: false });

      const shouldOpenBrowser = !args.includes('--headless-only') && !isBackground;
      if (shouldOpenBrowser) {
        const { exec } = require('child_process');
        const startCmd = process.platform === 'win32'
          ? `start "" "${webUrl}"`
          : (process.platform === 'darwin' ? `open "${webUrl}"` : `xdg-open "${webUrl}"`);
        exec(startCmd, () => {});
      }
    } catch (err: any) {
      writeStartupLog('WEB_UI_FAILED', { error: err.message });
      logger.warn('WEB_SERVER_START_FAILED', { error: err.message });
      console.warn('[SteamAIReplyBot] Warning: Web 管理面板启动受阻 (核心机器人继续运行):', err.message);
    }
  } else {
    writeStartupLog('BOOT_WEB_SERVER_SKIPPED', { reason: '--no-ui' });
    console.log('[SteamAIReplyBot] ℹ️ 已开启 --no-ui 模式，完全跳过本地 Web 管理面板');
  }

  writeStartupLog('BOOT_READY', { pid: process.pid, noUi: isNoUi });

  // Graceful shutdown handling
  const shutdownHandler = async (signal: string) => {
    console.log(`\n[SteamAIReplyBot] Received ${signal}. Initiating graceful shutdown...`);
    writeStartupLog('SHUTDOWN_SIGNAL', { signal });
    instanceLock.release();
    if (webServer) {
      await webServer.stop().catch(() => {});
    }
    await scheduler.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdownHandler('SIGINT'));
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  process.on('exit', () => {
    instanceLock.release();
  });

  await scheduler.start();
}

main().catch((err) => {
  writeStartupLog('BOOT_FAILED', { error: err.message || String(err), stack: err.stack });
  console.error('[SteamAIReplyBot] Fatal error during startup:', err);
  process.exit(1);
});
