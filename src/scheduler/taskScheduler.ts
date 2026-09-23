import { BotConfig, BotMode, BotLifecycleState } from '../config/schema';
import { RuntimeControl } from '../config/runtimeControl';
import { AppDatabase } from '../db/database';
import { CommentsRepository } from '../db/repositories/comments';
import { ReplyTasksRepository } from '../db/repositories/replyTasks';
import { InteractionUsersRepository } from '../db/repositories/interactionUsers';
import { HolidayRepository } from '../db/repositories/holiday';
import { LocalClassifier } from '../rules/classifier';
import { TemplateEngine } from '../rules/templateEngine';
import { NicknameMemoryRepository } from '../db/repositories/nicknameMemory';
import { NicknameResolver } from '../reply/nicknameResolver';
import { DeepSeekClient } from '../ai/deepseek';
import { AiLearner } from '../ai/learner';
import { DelayQueue } from './delayQueue';
import { RateLimiter } from './rateLimiter';
import { HolidayEngine } from './holidayEngine';
import { SteamBrowserManager } from '../steam/browser';
import { CommentMonitor } from '../steam/commentMonitor';
import { CommentSender } from '../steam/commentSender';
import { CommentCircuitBreaker } from './commentCircuitBreaker';
import { SteamSessionManager, LoginResult } from '../steam/session';
import { HealthMonitor } from '../utils/health';
import { Logger } from '../utils/logger';
import { Banner } from '../utils/banner';
import { VisualExpressionDetector } from '../rules/visualExpressionDetector';
import { SteamModerationDetector } from '../rules/moderationDetector';
import { ReplyDecision } from '../reply/replyDecision';
import { VisualReplyGenerator } from '../reply/visualReply';
import { VisualReplyLibrary, VisualReplyItem } from '../reply/visualLibrary';
import { ReplyStrategyEngine, ReplyContext, ReplyPlan } from '../reply/replyStrategy';
import { KnowledgeStore } from '../profile/knowledgeStore';
import { ProfileAnalysisManager } from '../profile/profileAnalysisManager';
import { DeepSeekProfileCurator } from '../profile/deepseekCurator';
import {
  CommentDiagnosticLogger,
  CommentDiagnosticInfo,
  CommentScanSummaryInfo,
  AiDecisionType,
  ReplySourceType,
  ActionType,
  SkipReasonType
} from '../utils/commentDiagnostics';
import { MonitorStateRepository } from '../db/repositories/monitorState';
import { computeReplyFingerprint } from '../steam/commentSender';
import { TransportCircuitBreaker } from '../steam/transport/transportCircuitBreaker';

export type SessionState = 'waiting_for_login' | 'authenticated' | 'resumed';

export class TaskScheduler {
  private isRunning: boolean = false;
  private timerHandle: NodeJS.Timeout | null = null;
  public isInteractiveLoginActive: boolean = false;
  public commentsRepo: CommentsRepository;
  public replyTasksRepo: ReplyTasksRepository;
  public interactionRepo: InteractionUsersRepository;
  public holidayRepo: HolidayRepository;
  public templateEngine: TemplateEngine;
  public nicknameMemoryRepo: NicknameMemoryRepository;
  public nicknameResolver: NicknameResolver;
  public classifier: LocalClassifier;
  public deepseek: DeepSeekClient;
  public learner: AiLearner;
  public delayQueue: DelayQueue;
  public rateLimiter: RateLimiter;
  public holidayEngine: HolidayEngine;
  public browserManager: SteamBrowserManager;
  public sessionManager: SteamSessionManager;
  public commentMonitor: CommentMonitor;
  public commentSender: CommentSender;
  public circuitBreaker: CommentCircuitBreaker;
  public transportCircuitBreaker: TransportCircuitBreaker;
  public healthMonitor: HealthMonitor;
  public visualReplyLibrary: VisualReplyLibrary;
  public knowledgeStore: KnowledgeStore;
  public profileAnalysisManager: ProfileAnalysisManager;
  public monitorStateRepo: MonitorStateRepository;
  public logger: Logger;
  public sessionState: SessionState = 'waiting_for_login';
  public lastPolledAt: string | null = null;
  public nextPollExpectedAt: string | null = null;
  public lastPollDurationMs: number = 0;
  public lastCatchupCommentsCount: number = 0;
  public lastPollLagDetected: boolean = false;
  public lastPollLagSeconds: number = 0;
  private pendingImmediatePoll: boolean = false;
  public lastSendResult: { target: string; status: string; timestamp: string; commentId?: string; message?: string } | null = null;
  public botMode: BotMode = 'AI_ENHANCED';
  public lifecycleState: BotLifecycleState = 'STOPPED';
  public lastError: string | null = null;
  private startTime: number;
  private isCycleRunning: boolean = false;
  private activeTransitionPromise: Promise<{ success: boolean; message?: string }> | null = null;

  constructor(
    private config: BotConfig,
    private db: AppDatabase,
    logger?: Logger
  ) {
    this.logger = logger || new Logger();
    this.startTime = Date.now();
    this.botMode = config.BOT_MODE || (config.BOT_ENABLED ? 'AI_ENHANCED' : 'DISABLED');
    this.lifecycleState = 'STOPPED';

    this.commentsRepo = new CommentsRepository(this.db);
    this.replyTasksRepo = new ReplyTasksRepository(this.db);
    this.interactionRepo = new InteractionUsersRepository(this.db);
    this.holidayRepo = new HolidayRepository(this.db);
    this.nicknameMemoryRepo = new NicknameMemoryRepository(this.db);
    this.nicknameResolver = new NicknameResolver(this.nicknameMemoryRepo);
    this.monitorStateRepo = new MonitorStateRepository(this.db);

    this.templateEngine = new TemplateEngine();
    this.classifier = new LocalClassifier(this.templateEngine);
    this.deepseek = new DeepSeekClient(config.DEEPSEEK_API_KEY, config.DEEPSEEK_MODEL, config.DEEPSEEK_BASE_URL);
    this.learner = new AiLearner();
    this.visualReplyLibrary = new VisualReplyLibrary();
    this.knowledgeStore = new KnowledgeStore();

    this.delayQueue = new DelayQueue(
      this.replyTasksRepo,
      config.MIN_REPLY_DELAY_SECONDS,
      config.MAX_REPLY_DELAY_SECONDS
    );
    this.rateLimiter = new RateLimiter(this.replyTasksRepo, config.MAX_REPLIES_PER_HOUR, config.MAX_REPLIES_PER_DAY);
    this.holidayEngine = new HolidayEngine(this.interactionRepo, this.holidayRepo, this.config);

    this.browserManager = new SteamBrowserManager(this.logger, {
      headless: config.HEADLESS !== false,
      executablePath: config.BROWSER_PATH || config.BROWSER_EXECUTABLE_PATH,
      browserMode: config.BROWSER_MODE,
      channel: config.BROWSER_CHANNEL
    });

    this.sessionManager = new SteamSessionManager(this.browserManager, this.logger);
    this.commentMonitor = new CommentMonitor(this.browserManager, config.STEAM_PROFILE_URL, this.logger);
    this.commentSender = new CommentSender(this.browserManager, config.STEAM_PROFILE_URL, this.logger);
    this.circuitBreaker = new CommentCircuitBreaker(this.logger);
    this.transportCircuitBreaker = new TransportCircuitBreaker(this.logger);
    this.healthMonitor = new HealthMonitor(this.logger, config.MEMORY_WARNING_MB, config.MEMORY_CRITICAL_MB);

    const curator = new DeepSeekProfileCurator(this.deepseek, this.logger);
    this.profileAnalysisManager = new ProfileAnalysisManager({
      curator,
      store: this.knowledgeStore,
      logger: this.logger,
      browserManager: this.browserManager
    });
  }

  public getSessionState(): SessionState {
    return this.sessionState;
  }

  public transitionSessionState(target: SessionState): void {
    const from = this.sessionState;
    if (from === target) return;

    this.sessionState = target;
    this.logger.info('SESSION_STATE_TRANSITION', { from, to: target });

    if (target === 'resumed') {
      const resumedCount = this.replyTasksRepo.resumeWaitingForLoginTasks();
      this.logger.info('SESSION_RESUMED_TASKS', { resumedCount });
    }
  }

  public setLifecycleState(state: BotLifecycleState, error?: string | null): void {
    const prevState = this.lifecycleState;
    this.lifecycleState = state;
    if (error !== undefined) {
      this.lastError = error;
    }
    if (prevState !== state) {
      this.logger.info('LIFECYCLE_STATE_TRANSITION', { from: prevState, to: state, error: this.lastError });
      RuntimeControl.update({ lifecycleState: state, lastError: this.lastError });
    }
  }

  public setBotMode(mode: BotMode): void {
    const prevMode = this.botMode;
    this.botMode = mode;
    this.config.BOT_MODE = mode;
    this.config.BOT_ENABLED = mode !== 'DISABLED';
    this.logger.info('BOT_MODE_TRANSITION', { from: prevMode, to: mode });
    RuntimeControl.update({ mode, botEnabled: this.config.BOT_ENABLED });
  }

  public get effectiveBotMode(): BotMode {
    if (!this.config.BOT_ENABLED) {
      return 'DISABLED';
    }
    if (this.botMode === 'DISABLED') {
      return this.config.BOT_MODE && this.config.BOT_MODE !== 'DISABLED'
        ? this.config.BOT_MODE
        : 'AI_ENHANCED';
    }
    return this.botMode;
  }

  public getBrowserState(): 'ACTIVE' | 'RELEASED' {
    return this.browserManager && this.browserManager.isContextActive() ? 'ACTIVE' : 'RELEASED';
  }

  /**
   * Browser Mode Transition Orchestration for Interactive Login:
   * HEADLESS_RUNNING -> Pause Scheduler -> Close headless context ->
   * Release profile lock -> Launch visible browser (headless: false) ->
   * User logs in -> Verify session -> Close visible browser ->
   * Restart headless browser -> Verify health -> Resume Scheduler
   */
  public async runInteractiveLoginWorkflow(expectedSteamId?: string): Promise<LoginResult> {
    if (this.isInteractiveLoginActive) {
      this.logger.warn('INTERACTIVE_LOGIN_ALREADY_ACTIVE', 'Interactive login already in progress');
      return {
        type: 'LOGIN_INVALID',
        success: false,
        message: 'ALREADY_IN_PROGRESS'
      };
    }

    this.isInteractiveLoginActive = true;

    // 1. INTERACTIVE_LOGIN_PREPARE: Pause scheduling and log intent
    this.logger.info('INTERACTIVE_LOGIN_PREPARE', {
      profileDir: this.browserManager.getProfileDir(),
      currentSessionState: this.sessionState
    });

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }

    let loginResult: LoginResult;

    try {
      // 2. HEADLESS_BROWSER_CLOSING: Close current persistent headless context
      this.logger.info('HEADLESS_BROWSER_CLOSING', {
        chromiumPid: this.browserManager.getChromiumPid(),
        profileDir: this.browserManager.getProfileDir()
      });
      await this.browserManager.close();

      // 3. HEADLESS_BROWSER_CLOSED: Confirm profileDir lock released
      this.logger.info('HEADLESS_BROWSER_CLOSED', {
        profileDir: this.browserManager.getProfileDir()
      });

      // 4. INTERACTIVE_BROWSER_LAUNCHING: Switch to visible mode (headless: false)
      const resolvedExe = this.browserManager.resolveExecutablePath();
      this.logger.info('INTERACTIVE_BROWSER_LAUNCHING', {
        headless: false,
        profileDir: this.browserManager.getProfileDir(),
        executablePath: resolvedExe || 'bundled/default'
      });

      this.browserManager.setHeadless(false);

      try {
        await this.browserManager.getContext();
      } catch (launchErr: any) {
        this.logger.error('INTERACTIVE_LOGIN_FAILED', {
          error: launchErr.message || String(launchErr),
          profileDir: this.browserManager.getProfileDir(),
          executablePath: resolvedExe || 'bundled/default',
          headless: false,
          browserContextState: 'failed_to_launch'
        });
        throw launchErr;
      }

      // 5. INTERACTIVE_BROWSER_LAUNCHED: Visible browser verified opened
      this.logger.info('INTERACTIVE_BROWSER_LAUNCHED', {
        chromiumPid: this.browserManager.getChromiumPid(),
        profileDir: this.browserManager.getProfileDir(),
        headless: false
      });

      // 6. Run interactive login flow
      loginResult = await this.sessionManager.runInteractiveLogin(expectedSteamId);

    } catch (err: any) {
      this.logger.error('INTERACTIVE_LOGIN_FAILED', {
        error: err.message || String(err),
        profileDir: this.browserManager.getProfileDir(),
        executablePath: this.browserManager.resolveExecutablePath() || 'bundled/default',
        headless: false,
        browserContextState: 'error'
      });
      loginResult = {
        type: 'LOGIN_INVALID',
        success: false,
        message: err.message || 'INTERACTIVE_LOGIN_FAILED'
      };
    } finally {
      // 7. INTERACTIVE_BROWSER_CLOSING: Close visible browser
      this.logger.info('INTERACTIVE_BROWSER_CLOSING', {
        profileDir: this.browserManager.getProfileDir()
      });
      await this.browserManager.close();

      // 8. HEADLESS_BROWSER_RESTARTING: Restore headless persistent browser
      this.logger.info('HEADLESS_BROWSER_RESTARTING', {
        headless: this.config.HEADLESS !== false,
        profileDir: this.browserManager.getProfileDir()
      });
      this.browserManager.setHeadless(this.config.HEADLESS !== false);

      try {
        await this.browserManager.getContext();
      } catch (restartErr: any) {
        this.logger.error('HEADLESS_BROWSER_RESTART_ERROR', { error: restartErr.message });
      }

      this.isInteractiveLoginActive = false;
    }

    // 9. Post-login evaluation & scheduler resumption
    if (loginResult.success && loginResult.type === 'LOGIN_SUCCESS') {
      const health = await this.sessionManager.checkSessionHealth();
      if (health.valid) {
        this.logger.info('SESSION_HEALTH_OK', {
          steamId: health.steamId64,
          accountName: health.accountName
        });
        this.transitionSessionState('authenticated');
        this.transitionSessionState('resumed');
      } else {
        this.transitionSessionState('waiting_for_login');
      }
    } else {
      this.transitionSessionState('waiting_for_login');
    }

    this.logger.info('LOGIN_FLOW_COMPLETED', {
      success: loginResult.success,
      type: loginResult.type,
      sessionState: this.sessionState
    });

    if (this.isRunning) {
      this.scheduleNextPoll(1000);
    }

    return loginResult;
  }

  public async start(options?: { isBackground?: boolean }): Promise<void> {
    this.setLifecycleState('STARTING');
    this.isRunning = true;
    this.logger.info('SCHEDULER_STARTED', { dryRun: this.config.DRY_RUN, headless: this.config.HEADLESS, mode: this.botMode });

    // Windows Autostart / Background boot settling delay
    // Allows Windows Desktop DWM, network, DPAPI, Defender scan, and Edge startup boost to settle
    const isBackgroundBoot = Boolean(options?.isBackground || process.argv.includes('--background') || process.env.STEAM_BOT_AUTOSTART === '1');
    if (isBackgroundBoot) {
      this.logger.info('BOOT_SETTLING_DELAY_START', {
        reason: 'Waiting for Windows desktop, network, and background browser processes to stabilize',
        delaySeconds: 30
      });
      console.log('[SteamAIReplyBot] ⏳ 开机/后台自启环境沉降等待中 (30秒)... 等待 Windows 桌面与网络初始化就绪');
      await new Promise(resolve => setTimeout(resolve, 30000));
      this.logger.info('BOOT_SETTLING_DELAY_COMPLETED', { delaySeconds: 30 });
    }

    // Step 0: Authenticated Session Health Check on startup
    let authCheck: any = { valid: false, reason: 'INITIALIZING' };
    try {
      authCheck = await this.sessionManager.checkSessionHealth();
    } catch (healthErr: any) {
      this.logger.warn('STARTUP_SESSION_CHECK_ERROR', { error: healthErr.message });
      authCheck = { valid: false, reason: healthErr.message };
    }

    if (authCheck.valid) {
      this.transitionSessionState('authenticated');
      this.logger.info('SESSION_HEALTH_OK', {
        steamId: authCheck.steamId64,
        accountName: authCheck.accountName
      });

      // Execute crash recovery only when session is valid and interactive login is not active
      if (!this.isInteractiveLoginActive) {
        await this.runCrashRecovery();
        await this.runUncertainStateRecoveryStep();
        await this.runModerationPendingRecoveryStep();
      }
    } else {
      this.transitionSessionState('waiting_for_login');
      this.logger.warn('LOGIN_REQUIRED', {
        reason: 'STARTUP_SESSION_HEALTH_FAILED',
        detail: authCheck.reason
      });
      this.logger.info('STARTUP_RECOVERY_DEFERRED', {
        reason: 'Session requires login or interactive login active. Recovery steps deferred to post-login polling cycles.'
      });
    }

    // Start randomized polling loop
    this.setLifecycleState('WAITING');
    this.scheduleNextPoll(1000); // First check after 1 second
  }

  /**
   * Software-level graceful stop of the bot:
   * 1. Stops polling and reply dispatching
   * 2. Safely releases Browser / Context via browserManager.close()
   * 3. Retains all database records, tasks, and cookies completely intact
   * 4. Does NOT close the database (UI/API remains 100% online)
   * 5. Transitions lifecycleState: STOPPING -> STOPPED
   * 6. Idempotent & non-reentrant
   */
  public async stopBot(): Promise<{ success: boolean; message?: string }> {
    if (this.lifecycleState === 'STOPPED') {
      return { success: true, message: 'Bot is already stopped.' };
    }
    if (this.activeTransitionPromise && this.lifecycleState === 'STOPPING') {
      return this.activeTransitionPromise;
    }

    const transition = (async () => {
      this.logger.info('STOP_BOT_REQUESTED', { currentState: this.lifecycleState });
      this.setLifecycleState('STOPPING');

      if (this.timerHandle) {
        clearTimeout(this.timerHandle);
        this.timerHandle = null;
      }
      this.isRunning = false;
      this.nextPollExpectedAt = null;

      try {
        await this.browserManager.close();
      } catch (err: any) {
        this.logger.warn('BROWSER_CLOSE_WARNING', { error: err.message });
      }

      this.setLifecycleState('STOPPED');
      this.logger.info('BOT_STOPPED_SAFELY', {
        lifecycleState: this.lifecycleState,
        browserState: this.getBrowserState()
      });
      return { success: true, message: 'Bot successfully stopped.' };
    })();

    this.activeTransitionPromise = transition;
    try {
      return await transition;
    } finally {
      this.activeTransitionPromise = null;
    }
  }

  /**
   * Software-level graceful resumption of the bot:
   * 1. Re-initializes Browser / Context using the existing BrowserManager
   * 2. Re-verifies session health
   * 3. Restores scheduling & polling loop
   * 4. Transitions lifecycleState: STARTING -> WAITING
   * 5. Error recovery: if browser init fails, transitions to ERROR and records lastError
   * 6. Idempotent & non-reentrant
   */
  public async resumeBot(): Promise<{ success: boolean; message?: string }> {
    if (this.lifecycleState === 'WAITING' || this.lifecycleState === 'RUNNING') {
      return { success: true, message: 'Bot is already running.' };
    }
    if (this.activeTransitionPromise && this.lifecycleState === 'STARTING') {
      return this.activeTransitionPromise;
    }

    const transition = (async () => {
      this.logger.info('RESUME_BOT_REQUESTED', { currentState: this.lifecycleState });
      this.setLifecycleState('STARTING');

      if (this.timerHandle) {
        clearTimeout(this.timerHandle);
        this.timerHandle = null;
      }

      // Re-initialize browser through the SAME browserManager
      try {
        await this.browserManager.getContext();
      } catch (launchErr: any) {
        const errMsg = launchErr.message || String(launchErr);
        this.logger.error('RESUME_BROWSER_LAUNCH_FAILED', { error: errMsg });
        try { await this.browserManager.close(); } catch {}
        this.setLifecycleState('ERROR', errMsg);
        return { success: false, message: `Failed to initialize browser: ${errMsg}` };
      }

      // Re-verify session health
      try {
        const authCheck = await this.sessionManager.checkSessionHealth();
        if (authCheck.valid) {
          this.transitionSessionState('authenticated');
          this.logger.info('SESSION_HEALTH_OK', {
            steamId: authCheck.steamId64,
            accountName: authCheck.accountName
          });
        } else {
          this.transitionSessionState('waiting_for_login');
          this.logger.warn('LOGIN_REQUIRED', {
            reason: 'RESUME_SESSION_HEALTH_FAILED',
            detail: authCheck.reason
          });
        }
      } catch (authErr: any) {
        this.logger.warn('RESUME_SESSION_CHECK_ERROR', { error: authErr.message });
      }

      this.isRunning = true;
      this.lastError = null;
      this.setLifecycleState('WAITING', null);

      this.scheduleNextPoll(1000);

      this.logger.info('BOT_RESUMED_SAFELY', {
        lifecycleState: this.lifecycleState,
        browserState: this.getBrowserState()
      });
      return { success: true, message: 'Bot successfully resumed.' };
    })();

    this.activeTransitionPromise = transition;
    try {
      return await transition;
    } finally {
      this.activeTransitionPromise = null;
    }
  }

  /**
   * Process-level full shutdown (called on SIGINT / SIGTERM / process exit):
   * Closes browser, then closes database.
   */
  public async stop(): Promise<void> {
    this.logger.info('SCHEDULER_PROCESS_SHUTDOWN', 'Gracefully stopping bot and closing database');
    await this.stopBot();
    this.db.close();
    this.logger.info('SCHEDULER_PROCESS_SHUTDOWN_COMPLETED', 'Shutdown completed');
  }

  private scheduleNextPoll(overrideDelayMs?: number): void {
    if (!this.isRunning) return;

    // Detect poll lag if previous expected poll time was significantly exceeded (> 60s)
    if (this.nextPollExpectedAt) {
      const expectedTime = new Date(this.nextPollExpectedAt).getTime();
      const now = Date.now();
      if (now > expectedTime + 60000) {
        const lagSec = Math.round((now - expectedTime) / 1000);
        this.lastPollLagDetected = true;
        this.lastPollLagSeconds = lagSec;
        this.logger.warn('POLL_LAG_DETECTED', {
          expectedAt: this.nextPollExpectedAt,
          actualAt: new Date(now).toISOString(),
          lagSeconds: lagSec
        });
      } else {
        this.lastPollLagDetected = false;
        this.lastPollLagSeconds = 0;
      }
    }

    let delayMs = overrideDelayMs;
    if (this.pendingImmediatePoll) {
      this.pendingImmediatePoll = false;
      delayMs = 50;
      this.logger.info('EXECUTING_QUEUED_IMMEDIATE_POLL');
    } else if (delayMs === undefined) {
      const minSec = this.config.CHECK_INTERVAL_MIN_SECONDS;
      const maxSec = this.config.CHECK_INTERVAL_MAX_SECONDS;
      const randomSec = Math.floor(Math.random() * (maxSec - minSec + 1) + minSec);
      delayMs = randomSec * 1000;
      this.logger.info('NEXT_POLL_SCHEDULED', { delaySeconds: randomSec });
    }

    this.nextPollExpectedAt = new Date(Date.now() + delayMs).toISOString();

    this.timerHandle = setTimeout(async () => {
      this.nextPollExpectedAt = null;
      const cycleStart = Date.now();
      try {
        await this.runCycle();
      } catch (err: any) {
        this.logger.error('CYCLE_UNHANDLED_ERROR', err.message);
      } finally {
        this.lastPollDurationMs = Date.now() - cycleStart;
        this.scheduleNextPoll();
      }
    }, delayMs);
  }

  public requestImmediatePoll(): void {
    if (!this.isRunning) return;
    this.logger.info('IMMEDIATE_POLL_REQUESTED');

    if (this.isCycleRunning) {
      this.pendingImmediatePoll = true;
      this.logger.info('IMMEDIATE_POLL_QUEUED', 'Cycle already in progress, marked pending immediate poll for when current cycle finishes');
      return;
    }

    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }

    this.scheduleNextPoll(50);
  }

  public async runCycle(): Promise<void> {
    if (this.isCycleRunning) {
      this.logger.warn('CYCLE_ALREADY_RUNNING', 'Previous cycle still running; skipping concurrent run');
      return;
    }
    this.isCycleRunning = true;
    this.setLifecycleState('RUNNING');

    try {
      if (this.isInteractiveLoginActive) {
        this.logger.info('CYCLE_SKIPPED_LOGIN_ACTIVE', 'Interactive login active; skipping background poll cycle.');
        return;
      }

      // Dynamic Runtime Control from data/runtime-control.json (re-evaluated on each cycle without restart)
      const runtimeState = RuntimeControl.load(this.config.BOT_ENABLED, this.config.EMERGENCY_STOP, this.botMode);
      this.botMode = runtimeState.mode;
      this.config.BOT_MODE = runtimeState.mode;
      this.config.BOT_ENABLED = runtimeState.botEnabled;
      this.config.EMERGENCY_STOP = runtimeState.emergencyStop;
      if (runtimeState.dryRunOverride !== null && runtimeState.dryRunOverride !== undefined) {
        this.config.DRY_RUN = runtimeState.dryRunOverride;
      }

      const pagesCount = this.browserManager.getOpenPagesCount();
      const health = this.healthMonitor.checkHealth(pagesCount);

      if (health.status === 'CRITICAL') {
        this.logger.warn('CYCLE_SUSPENDED_CRITICAL_HEALTH', health);
        await this.browserManager.resetContext();
        return;
      } else if (health.status === 'WARNING') {
        await this.browserManager.cleanupStrayPages();
      }

      // Revision 6: Kill Switch Checks
      if (this.config.EMERGENCY_STOP) {
        this.logger.warn('EMERGENCY_STOP_ACTIVE', 'All pending send tasks canceled. Monitoring only.');
        this.replyTasksRepo.cancelAllPendingTasks();
        return;
      }

      // Self-Healing Session Recovery: if waiting_for_login, attempt re-verification
      if (this.sessionState === 'waiting_for_login') {
        try {
          const recheck = await this.sessionManager.checkSessionHealth();
          if (recheck.valid) {
            this.transitionSessionState('authenticated');
            this.transitionSessionState('resumed');
            this.logger.info('SESSION_AUTO_HEALED', {
              steamId: recheck.steamId64,
              accountName: recheck.accountName
            });
          }
        } catch (e: any) {
          this.logger.warn('SESSION_RECHECK_FAILED', { error: e.message });
        }
      }

      // 1. Scan and process new comments from my profile
      await this.scanCommentsStep();

      // 2. Process delayed reply tasks
      if (this.effectiveBotMode === 'DISABLED') {
        this.logger.info('BOT_DISABLED', 'Bot is in DISABLED mode (or BOT_ENABLED is false); skipping outgoing replies.');
      } else {
        await this.runUncertainStateRecoveryStep();
        await this.runModerationPendingRecoveryStep();
        await this.dispatchPendingRepliesStep();
      }

      // 3. Process holiday greetings
      if (this.effectiveBotMode !== 'DISABLED' && !this.config.EMERGENCY_STOP) {
        await this.dispatchHolidayStep();
      }

      // 4. Print or log dashboard stats
      this.printPeriodicStats();
    } catch (cycleErr: any) {
      this.lastError = cycleErr.message || String(cycleErr);
      this.logger.error('CYCLE_EXECUTION_ERROR', { error: this.lastError });
      this.setLifecycleState('ERROR', this.lastError);
      throw cycleErr;
    } finally {
      this.isCycleRunning = false;
      if (this.isRunning && this.lifecycleState !== 'ERROR' && this.lifecycleState !== 'STOPPING' && this.lifecycleState !== 'STOPPED') {
        this.setLifecycleState('WAITING');
      }
    }
  }

  public async processComment(
    c: DiscoveredComment,
    index: number = 1,
    options: { persistAndDispatch?: boolean } = { persistAndDispatch: true }
  ): Promise<CommentDiagnosticInfo> {
    const myProfileUrl = (this.config.STEAM_PROFILE_URL || '').trim();
    const targetProfileUrl = (c.commenterProfileUrl || '').trim();

    const normalize = (u: string) => u.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const isSelfProfile = Boolean(
      myProfileUrl &&
      targetProfileUrl &&
      normalize(myProfileUrl) === normalize(targetProfileUrl)
    );

    const direction = isSelfProfile ? 'OUTGOING_TO_SELF_OR_IDENTICAL' : 'INCOMING_FROM_B_TO_A';
    const targetDirectionCheck: 'PASS' | 'FAIL' = isSelfProfile ? 'FAIL' : 'PASS';

    // 1. Missing basic field checks
    if (!c.commentId) {
      return {
        index,
        commentId: '',
        commenterName: c.commenterName || '',
        commenterSteamId: c.commenterSteamId || '',
        commenterProfileUrl: targetProfileUrl,
        originalComment: c.content || '',
        commentTime: c.timestampStr || new Date().toISOString(),
        databaseRecordExists: false,
        databaseStatus: 'NONE',
        classification: 'unknown',
        classificationConfidence: 0,
        classificationSource: 'NONE',
        visualExpression: false,
        visualExpressionSubtype: null,
        visualExpressionConfidence: 0,
        aiDecision: 'SKIPPED',
        replySource: 'NONE',
        action: 'SKIP',
        skipReason: 'MISSING_COMMENT_ID',
        myProfileUrl,
        targetProfileUrl,
        direction,
        targetDirectionCheck
      };
    }

    if (!c.commenterName) {
      return {
        index,
        commentId: c.commentId,
        commenterName: '',
        commenterSteamId: c.commenterSteamId || '',
        commenterProfileUrl: targetProfileUrl,
        originalComment: c.content || '',
        commentTime: c.timestampStr || new Date().toISOString(),
        databaseRecordExists: false,
        databaseStatus: 'NONE',
        classification: 'unknown',
        classificationConfidence: 0,
        classificationSource: 'NONE',
        visualExpression: false,
        visualExpressionSubtype: null,
        visualExpressionConfidence: 0,
        aiDecision: 'SKIPPED',
        replySource: 'NONE',
        action: 'SKIP',
        skipReason: 'MISSING_AUTHOR',
        myProfileUrl,
        targetProfileUrl,
        direction,
        targetDirectionCheck
      };
    }

    if (!c.commenterSteamId) {
      return {
        index,
        commentId: c.commentId,
        commenterName: c.commenterName,
        commenterSteamId: '',
        commenterProfileUrl: targetProfileUrl,
        originalComment: c.content || '',
        commentTime: c.timestampStr || new Date().toISOString(),
        databaseRecordExists: false,
        databaseStatus: 'NONE',
        classification: 'unknown',
        classificationConfidence: 0,
        classificationSource: 'NONE',
        visualExpression: false,
        visualExpressionSubtype: null,
        visualExpressionConfidence: 0,
        aiDecision: 'SKIPPED',
        replySource: 'NONE',
        action: 'SKIP',
        skipReason: 'MISSING_STEAM_ID',
        myProfileUrl,
        targetProfileUrl,
        direction,
        targetDirectionCheck
      };
    }

    if (!targetProfileUrl) {
      return {
        index,
        commentId: c.commentId,
        commenterName: c.commenterName,
        commenterSteamId: c.commenterSteamId,
        commenterProfileUrl: '',
        originalComment: c.content || '',
        commentTime: c.timestampStr || new Date().toISOString(),
        databaseRecordExists: false,
        databaseStatus: 'NONE',
        classification: 'unknown',
        classificationConfidence: 0,
        classificationSource: 'NONE',
        visualExpression: false,
        visualExpressionSubtype: null,
        visualExpressionConfidence: 0,
        aiDecision: 'SKIPPED',
        replySource: 'NONE',
        action: 'SKIP',
        skipReason: 'MISSING_PROFILE_URL',
        myProfileUrl,
        targetProfileUrl,
        direction,
        targetDirectionCheck
      };
    }

    // 2. Target Direction Check
    if (targetDirectionCheck === 'FAIL') {
      return {
        index,
        commentId: c.commentId,
        commenterName: c.commenterName,
        commenterSteamId: c.commenterSteamId,
        commenterProfileUrl: targetProfileUrl,
        originalComment: c.content || '',
        commentTime: c.timestampStr || new Date().toISOString(),
        databaseRecordExists: false,
        databaseStatus: 'BLOCKED',
        classification: 'unknown',
        classificationConfidence: 0,
        classificationSource: 'NONE',
        visualExpression: false,
        visualExpressionSubtype: null,
        visualExpressionConfidence: 0,
        aiDecision: 'SKIPPED',
        replySource: 'NONE',
        action: 'BLOCKED',
        skipReason: 'INVALID_TARGET',
        myProfileUrl,
        targetProfileUrl,
        direction,
        targetDirectionCheck
      };
    }

    // 3. Steam Moderation Detection
    const moderationCheck = SteamModerationDetector.detect(c.content || '');

    // 4. Database existence check
    const existing = this.commentsRepo.findByCommentId(c.commentId);
    let isReleasedFromModeration = false;
    let isResumedFromBotDisabled = false;

    if (existing) {
      if (existing.status === 'STEAM_MODERATION_PENDING') {
        if (moderationCheck.isModerationPending) {
          // Still in moderation: do not call AI, do not generate reply, check next poll
          this.logger.info('STEAM_MODERATION_PENDING', {
            commentId: c.commentId,
            commenter: c.commenterName,
            status: 'STILL_PENDING',
            confidence: moderationCheck.confidence
          });
          return {
            index,
            commentId: c.commentId,
            commenterName: c.commenterName,
            commenterSteamId: c.commenterSteamId,
            commenterProfileUrl: targetProfileUrl,
            originalComment: c.content || '',
            commentTime: c.timestampStr || existing.created_at || new Date().toISOString(),
            databaseRecordExists: true,
            databaseStatus: 'STEAM_MODERATION_PENDING',
            classification: 'steam_moderation_pending',
            classificationConfidence: moderationCheck.confidence,
            classificationSource: 'NONE',
            visualExpression: false,
            visualExpressionSubtype: null,
            visualExpressionConfidence: 0,
            aiDecision: 'SKIPPED',
            replySource: 'NONE',
            action: 'STEAM_MODERATION_PENDING',
            skipReason: 'STEAM_MODERATION_PENDING',
            myProfileUrl,
            targetProfileUrl,
            direction,
            targetDirectionCheck
          };
        } else {
          // Released from moderation into real comment!
          this.logger.info('STEAM_MODERATION_RELEASED', {
            commentId: c.commentId,
            commenter: c.commenterName,
            newContentPreview: (c.content || '').substring(0, 50)
          });
          isReleasedFromModeration = true;
        }
      } else if (existing.status === 'skipped' && existing.error_message === 'BOT_DISABLED' && this.config.BOT_ENABLED) {
        // Recoverable skip: Bot was disabled when this comment was initially discovered,
        // but BOT_ENABLED is now true. Re-enter regular processing pipeline.
        this.logger.info('COMMENT_RECOVERED_FROM_BOT_DISABLED', {
          commentId: c.commentId,
          commenter: c.commenterName,
          previousStatus: existing.status
        });
        isResumedFromBotDisabled = true;
      } else {
        const isReplied = existing.status === 'replied';
        const visualResult = VisualExpressionDetector.detect(c.content || '');
        const classification = this.classifier.classify(c.content || '', c.commenterSteamId);
        return {
          index,
          commentId: c.commentId,
          commenterName: c.commenterName,
          commenterSteamId: c.commenterSteamId,
          commenterProfileUrl: targetProfileUrl,
          originalComment: c.content || '',
          commentTime: c.timestampStr || existing.created_at || new Date().toISOString(),
          databaseRecordExists: true,
          databaseStatus: existing.status,
          classification: existing.classification || classification.category,
          classificationConfidence: existing.classification_confidence ?? classification.confidence,
          classificationSource: existing.reply_source || classification.replySource,
          visualExpression: visualResult.isVisualExpression,
          visualExpressionSubtype: visualResult.isVisualExpression ? visualResult.subtype : null,
          visualExpressionConfidence: visualResult.confidence,
          aiDecision: 'NOT_NEEDED',
          replySource: (existing.reply_source as ReplySourceType) || 'NONE',
          action: 'SKIP',
          skipReason: isReplied ? 'ALREADY_REPLIED' : 'ALREADY_PROCESSED',
          myProfileUrl,
          targetProfileUrl,
          direction,
          targetDirectionCheck
        };
      }
    } else {
      // First time seeing this comment, but it's a moderation placeholder
      if (moderationCheck.isModerationPending) {
        const now = new Date().toISOString();
        if (options.persistAndDispatch) {
          this.commentsRepo.insert({
            steam_comment_id: c.commentId,
            commenter_steam_id: c.commenterSteamId,
            commenter_name: c.commenterName,
            commenter_profile_url: c.commenterProfileUrl,
            content: c.content,
            language: LocalClassifier.detectLanguage(c.content),
            classification: 'steam_moderation_pending',
            classification_confidence: moderationCheck.confidence,
            reply_source: 'NONE',
            reply: '',
            status: 'STEAM_MODERATION_PENDING',
            created_at: now,
            updated_at: now
          });
        }
        this.logger.info('STEAM_MODERATION_PENDING', {
          commentId: c.commentId,
          commenter: c.commenterName,
          confidence: moderationCheck.confidence,
          matchedPattern: moderationCheck.matchedPattern
        });
        return {
          index,
          commentId: c.commentId,
          commenterName: c.commenterName,
          commenterSteamId: c.commenterSteamId,
          commenterProfileUrl: targetProfileUrl,
          originalComment: c.content || '',
          commentTime: c.timestampStr || now,
          databaseRecordExists: false,
          databaseStatus: 'STEAM_MODERATION_PENDING',
          classification: 'steam_moderation_pending',
          classificationConfidence: moderationCheck.confidence,
          classificationSource: 'NONE',
          visualExpression: false,
          visualExpressionSubtype: null,
          visualExpressionConfidence: 0,
          aiDecision: 'SKIPPED',
          replySource: 'NONE',
          action: 'STEAM_MODERATION_PENDING',
          skipReason: 'STEAM_MODERATION_PENDING',
          myProfileUrl,
          targetProfileUrl,
          direction,
          targetDirectionCheck
        };
      }
    }

    // Evaluate visual expression & local classification on real comment content
    const visualResult = VisualExpressionDetector.detect(c.content || '');
    const classification = this.classifier.classify(c.content || '', c.commenterSteamId);

    // Strategy decision layer evaluation and logging
    const replyDecision = ReplyDecision.evaluate(c.content || '');
    this.logger.info('REPLY_DECISION', {
      commentId: c.commentId,
      commenter: c.commenterName,
      type: replyDecision.type,
      action: replyDecision.action,
      confidence: replyDecision.confidence,
      reason: replyDecision.reason
    });

    // 5. New or Released comment processing
    if (options.persistAndDispatch) {
      this.interactionRepo.recordInteraction({
        steamId: c.commenterSteamId,
        profileUrl: c.commenterProfileUrl,
        displayName: c.commenterName,
        language: LocalClassifier.detectLanguage(c.content)
      });
    }

    let replyText = classification.reply;
    let replySource: ReplySourceType = classification.replySource as ReplySourceType;
    let action: ActionType = 'REPLY_LOCAL';
    let skipReason: SkipReasonType = 'NONE';
    let aiDecision: AiDecisionType = 'NOT_NEEDED';
    let aiReason: string | undefined = undefined;
    let blockReason: string | undefined = undefined;
    let aiModel: string | undefined = undefined;
    let aiLatencyMs: number | undefined = undefined;

    const replyContext: ReplyContext = {
      commentId: c.commentId,
      commenterName: c.commenterName,
      commenterSteamId: c.commenterSteamId,
      commenterProfileUrl: targetProfileUrl,
      content: c.content || '',
      timestampStr: c.timestampStr,
      classification: {
        category: classification.category,
        confidence: classification.confidence,
        language: classification.language,
        isVisualExpression: classification.isVisualExpression,
        isSpam: classification.isSpam,
        replySource: classification.replySource,
        reply: classification.reply
      },
      visualResult,
      decision: replyDecision
    };

    const replyPlan = ReplyStrategyEngine.plan(replyContext);

    // Visual Expression Interception (Priority: Curated Library -> Fallback Generator -> Template)
    if (classification.isVisualExpression) {
      aiDecision = 'BLOCKED';
      blockReason = 'AI_BLOCKED_VISUAL_EXPRESSION';
      aiReason = 'AI_BLOCKED_VISUAL_EXPRESSION';
      action = 'REPLY_LOCAL';

      let selectedCurated: VisualReplyItem | null = null;
      if (replyPlan.source === 'VISUAL_LIBRARY' && this.visualReplyLibrary) {
        selectedCurated = this.visualReplyLibrary.select(
          {
            type: replyPlan.libraryType,
            tags: replyPlan.tags,
            mood: replyPlan.mood,
            complement: replyPlan.strategy === 'COMPLEMENT'
          },
          { commenterSteamId: c.commenterSteamId }
        );
      }

      if (selectedCurated) {
        replyText = selectedCurated.content;
        replySource = 'VISUAL_LIBRARY';
        this.logger.info('VISUAL_REPLY_CURATED_SELECTED', {
          commentId: c.commentId,
          itemId: selectedCurated.id,
          itemType: selectedCurated.type,
          strategy: replyPlan.strategy
        });
      } else if (replyPlan.allowFallbackGenerator) {
        replyText = VisualReplyGenerator.generate(c.content || '', visualResult, classification.reply);
        replySource = 'VISUAL_GENERATOR';
        this.logger.info('VISUAL_REPLY_GENERATOR_FALLBACK', {
          commentId: c.commentId,
          subtype: classification.category
        });
      } else {
        replyText = classification.reply || '✨ 感谢来踩！祝游戏愉快～';
        replySource = 'LOCAL_TEMPLATE';
      }

      this.logger.info('AI_BLOCKED_VISUAL_EXPRESSION', {
        commentId: c.commentId,
        commenter: c.commenterName,
        subtype: classification.category,
        confidence: classification.confidence,
        strategy: replyPlan.strategy,
        source: replySource
      });
    } else if (classification.isSpam) {
      action = 'SKIP';
      skipReason = 'SPAM';
      replySource = 'NONE';
      aiDecision = 'NOT_NEEDED';
    } else {
      // ===== TEXT REPLY STAGE (LOCAL_TEXT / AI_TEXT) =====
      // Resolve optional natural nickname (pure local, fallback null, never throws)
      let resolvedNickname: string | null = null;
      try {
        if (this.nicknameResolver) {
          resolvedNickname = this.nicknameResolver.resolveSafe(c.commenterSteamId, c.commenterName);
        }
      } catch {
        resolvedNickname = null;
      }

      if (classification.category !== 'unknown') {
        action = 'REPLY_LOCAL';
        replySource = (classification.replySource as ReplySourceType) || 'LOCAL_TEMPLATE';
        aiDecision = 'NOT_NEEDED';

        // Enhanced local text reply with natural nickname & time greeting
        if (classification.category === 'greeting' || classification.category === 'time_greeting') {
          replyText = this.templateEngine.getTimeGreetingReply(resolvedNickname, new Date(), c.commenterSteamId);
        }
      } else {
        // Unknown category -> Fallback to AI or LOCAL_ONLY safe fallback
        if (this.config.EMERGENCY_STOP) {
          action = 'SKIP';
          skipReason = 'EMERGENCY_STOPPED';
          aiDecision = 'SKIPPED';
        } else if (this.effectiveBotMode === 'DISABLED') {
          action = 'SKIP';
          skipReason = 'BOT_DISABLED';
          aiDecision = 'SKIPPED';
        } else if (this.effectiveBotMode === 'LOCAL_ONLY') {
          // LOCAL_ONLY Interception: 0 DeepSeek requests
          action = 'REPLY_LOCAL';
          replySource = 'LOCAL_TEMPLATE';
          aiDecision = 'NOT_NEEDED';
          aiReason = 'MODE_LOCAL_ONLY';
          // Safe ordinary local text fallback (does not convert unknown into timeGreeting)
          replyText = this.templateEngine.getReply('warm_social', c.language || 'zh', c.commenterSteamId);
        } else {
        const rateCheck = this.rateLimiter.canSendReply();
        if (!rateCheck.allowed) {
          action = 'SKIP';
          skipReason = 'RATE_LIMITED';
          aiDecision = 'SKIPPED';
        } else {
          aiDecision = 'CALLED';
          aiReason = 'UNKNOWN_LOCAL_CLASSIFICATION';
          aiModel = this.config.DEEPSEEK_MODEL || 'deepseek-chat';

          // Local Knowledge & Persona Injection (Zero-overhead local lookup, no DeepSeek profile re-analysis)
          let extraSystemContext = '';
          try {
            const relevantKnowledge = this.knowledgeStore.findRelevantKnowledge(c.content || '', 3);
            const formalPersona = this.knowledgeStore.loadFormalPersona();
            const contextParts: string[] = [];

            if (formalPersona) {
              contextParts.push(`【人设设定】称呼: ${formalPersona.name || '玩家'}, 语气倾向: ${formalPersona.tone || 'friendly'}, 性格特征: ${(formalPersona.traits || []).join('、')}`);
              if (formalPersona.favoriteGames?.length) {
                contextParts.push(`熟悉/喜爱的游戏: ${formalPersona.favoriteGames.join('、')}`);
              }
              if (formalPersona.communicationStyle?.length) {
                contextParts.push(`交流风格建议: ${formalPersona.communicationStyle.join('、')}`);
              }
            }

            if (relevantKnowledge.length > 0) {
              contextParts.push(`【相关主页事实与推断】\n` + relevantKnowledge.join('\n'));
            }

            if (contextParts.length > 0) {
              extraSystemContext = contextParts.join('\n');
            }
          } catch (e: any) {
            this.logger.warn('KNOWLEDGE_LOOKUP_WARNING', { error: e.message });
          }

          const t0 = Date.now();
          const aiResp = await this.deepseek.generateReply(c.content, resolvedNickname || c.commenterName, extraSystemContext);
          aiLatencyMs = Date.now() - t0;

          if (aiResp && aiResp.reply) {
            replyText = aiResp.reply;
            replySource = 'DEEPSEEK';
            action = 'REPLY_AI';

            if (options.persistAndDispatch) {
              this.learner.processAiObservation({
                phrases: aiResp.learnablePhrases,
                category: aiResp.category,
                language: aiResp.language,
                confidence: aiResp.confidence,
                sampleReply: aiResp.reply
              });
              this.classifier.loadPhrases();
            }
          } else {
            action = 'SKIP';
            skipReason = 'CLASSIFICATION_FAILED';
          }
        }
      }
    }
  }

    // Global Safety Enforcement: If EMERGENCY_STOP or BOT_ENABLED is false,
    // suppress any outgoing reply (local template, visual expression, or AI)
    if (action !== 'SKIP') {
      if (this.config.EMERGENCY_STOP) {
        action = 'SKIP';
        skipReason = 'EMERGENCY_STOPPED';
        replyText = undefined;
        replySource = 'NONE';
        aiDecision = 'SKIPPED';
      } else if (!this.config.BOT_ENABLED) {
        action = 'SKIP';
        skipReason = 'BOT_DISABLED';
        replyText = undefined;
        replySource = 'NONE';
        aiDecision = 'SKIPPED';
      }
    }

    const now = new Date().toISOString();

    if (replyText && (action === 'REPLY_LOCAL' || action === 'REPLY_AI')) {
      this.logger.info('REPLY_FINAL_TEXT', {
        commentId: c.commentId,
        replySource,
        replyDecision: replyDecision.type,
        textPreview: replyText.length > 50 ? replyText.substring(0, 50) + '...' : replyText
      });
    }

    const isExistingRecord = isReleasedFromModeration || isResumedFromBotDisabled;

    if (options.persistAndDispatch) {
      if (isExistingRecord) {
        // Update the existing record (either released from moderation or resumed from BOT_DISABLED)
        if (classification.isSpam) {
          this.commentsRepo.updateContentAndStatus(c.commentId, c.content, 'skipped', {
            classification: 'spam',
            classification_confidence: classification.confidence,
            reply_source: 'NONE',
            reply: '',
            language: classification.language,
            error_message: 'Flagged as spam by local filter'
          });
        } else if (!replyText) {
          this.commentsRepo.updateContentAndStatus(c.commentId, c.content, 'skipped', {
            classification: classification.category,
            classification_confidence: classification.confidence,
            reply_source: replySource,
            reply: '',
            language: classification.language,
            error_message: skipReason !== 'NONE' ? skipReason : undefined
          });
        } else {
          this.commentsRepo.updateContentAndStatus(c.commentId, c.content, 'waiting', {
            classification: classification.category,
            classification_confidence: classification.confidence,
            reply_source: replySource,
            reply: replyText,
            language: classification.language,
            error_message: null as any
          });

          this.delayQueue.enqueueReplyTask({
            steamCommentId: c.commentId,
            targetSteamId: c.commenterSteamId,
            targetProfileUrl: c.commenterProfileUrl,
            replyText
          });
        }
      } else {
        // Brand new comment
        if (classification.isSpam) {
          this.commentsRepo.insert({
            steam_comment_id: c.commentId,
            commenter_steam_id: c.commenterSteamId,
            commenter_name: c.commenterName,
            commenter_profile_url: c.commenterProfileUrl,
            content: c.content,
            language: classification.language,
            classification: 'spam',
            classification_confidence: classification.confidence,
            reply_source: 'NONE',
            reply: '',
            status: 'skipped',
            created_at: now,
            updated_at: now,
            error_message: 'Flagged as spam by local filter'
          });
        } else if (!replyText) {
          this.commentsRepo.insert({
            steam_comment_id: c.commentId,
            commenter_steam_id: c.commenterSteamId,
            commenter_name: c.commenterName,
            commenter_profile_url: c.commenterProfileUrl,
            content: c.content,
            language: classification.language,
            classification: classification.category,
            classification_confidence: classification.confidence,
            reply_source: replySource,
            reply: '',
            status: 'skipped',
            created_at: now,
            updated_at: now,
            error_message: skipReason !== 'NONE' ? skipReason : undefined
          });
        } else {
          this.commentsRepo.insert({
            steam_comment_id: c.commentId,
            commenter_steam_id: c.commenterSteamId,
            commenter_name: c.commenterName,
            commenter_profile_url: c.commenterProfileUrl,
            content: c.content,
            language: classification.language,
            classification: classification.category,
            classification_confidence: classification.confidence,
            reply_source: replySource,
            reply: replyText,
            status: 'waiting',
            created_at: now,
            updated_at: now
          });

          this.delayQueue.enqueueReplyTask({
            steamCommentId: c.commentId,
            targetSteamId: c.commenterSteamId,
            targetProfileUrl: c.commenterProfileUrl,
            replyText
          });
        }
      }
    }

    return {
      index,
      commentId: c.commentId,
      commenterName: c.commenterName,
      commenterSteamId: c.commenterSteamId,
      commenterProfileUrl: targetProfileUrl,
      originalComment: c.content || '',
      commentTime: c.timestampStr || now,
      databaseRecordExists: isExistingRecord ? true : false,
      databaseStatus: isReleasedFromModeration ? 'STEAM_MODERATION_RELEASED' : (isResumedFromBotDisabled ? 'BOT_DISABLED_RESUMED' : 'NEW'),
      classification: classification.category,
      classificationConfidence: classification.confidence,
      classificationSource: classification.replySource,
      visualExpression: visualResult.isVisualExpression,
      visualExpressionSubtype: visualResult.isVisualExpression ? visualResult.subtype : null,
      visualExpressionConfidence: visualResult.confidence,
      aiDecision,
      aiReason,
      blockReason,
      aiModel,
      aiLatencyMs,
      replySource,
      action,
      skipReason,
      myProfileUrl,
      targetProfileUrl,
      direction,
      targetDirectionCheck
    };
  }

  private async scanCommentsStep(): Promise<void> {
    const lastSeenCommentId = this.monitorStateRepo.getLastSeenCommentId();
    const discovered = await this.commentMonitor.fetchComments(lastSeenCommentId || undefined);
    this.lastPolledAt = new Date().toISOString();
    this.lastCatchupCommentsCount = this.commentMonitor.lastCatchupStats.fetchedCount;

    if (discovered.length > 0 && discovered[0]?.commentId) {
      this.monitorStateRepo.setLastSeenCommentId(discovered[0].commentId);
    }

    // Monitor session state discovery
    const isMonitorSessionValid = this.commentMonitor.isSessionValid();
    if (!isMonitorSessionValid) {
      if (this.sessionState !== 'waiting_for_login') {
        this.transitionSessionState('waiting_for_login');
        this.logger.warn('LOGIN_REQUIRED', {
          reason: 'MONITOR_DISCOVERED_SESSION_INVALID'
        });
      }
    } else if (this.sessionState === 'waiting_for_login') {
      // Session has been restored
      this.transitionSessionState('authenticated');
      this.transitionSessionState('resumed');
    }

    const summary: CommentScanSummaryInfo = {
      totalComments: discovered.length,
      newComments: 0,
      alreadyProcessed: 0,
      spam: 0,
      localReplies: 0,
      visualExpressionLocal: 0,
      deepseekReplies: 0,
      aiRequests: 0,
      aiRequestsBlocked: 0,
      aiRequestsSaved: 0,
      visualExpressionSaved: 0,
      rateLimited: 0,
      moderationPending: 0,
      errors: 0
    };

    // Baseline Empty DB Safety Protection (Section X)
    // If the database has 0 comments (brand new db / newly initialized schema),
    // we MUST NOT treat all existing comments on Steam as NEW and dispatch replies!
    // Instead, import them into the baseline as already processed (status: 'replied', skipReason: 'IMPORT_EXISTING').
    const currentTotalComments = this.commentsRepo.getTotalCount();
    const isBaselineImportRequired = currentTotalComments === 0 && discovered.length > 0;
    if (isBaselineImportRequired) {
      this.logger.warn('STARTUP_BASELINE_PROTECTION_TRIGGERED', {
        reason: 'EMPTY_DATABASE_DETECTED',
        discoveredCount: discovered.length,
        message: 'Empty database detected on comment scan. Importing all existing comments as baseline to strictly prevent duplicate replies.'
      });
      console.log(`\n[TaskScheduler] 🛡️ 启动基线保护触发：本地数据库为空，已自动将 Steam 现有 ${discovered.length} 条评论导入基线（标记为已处理），严格禁止批量重发！\n`);
    }

    let index = 0;
    for (const c of discovered) {
      index++;
      try {
        let diag: CommentDiagnosticInfo;
        if (isBaselineImportRequired) {
          const now = new Date().toISOString();
          this.commentsRepo.insert({
            steam_comment_id: c.commentId,
            commenter_steam_id: c.commenterSteamId,
            commenter_name: c.commenterName,
            commenter_profile_url: c.commenterProfileUrl,
            content: c.content,
            language: LocalClassifier.detectLanguage(c.content),
            classification: 'baseline_import',
            classification_confidence: 1.0,
            reply_source: 'IMPORT_EXISTING',
            reply: '[Baseline Imported on Initial Scan - Duplicate Reply Protection]',
            status: 'replied',
            created_at: now,
            updated_at: now,
            replied_at: now
          });
          diag = {
            index,
            commentId: c.commentId,
            commenterName: c.commenterName,
            commenterSteamId: c.commenterSteamId,
            commenterProfileUrl: c.commenterProfileUrl,
            originalComment: c.content,
            commentTime: c.timestampStr || now,
            databaseRecordExists: false,
            databaseStatus: 'IMPORT_EXISTING',
            classification: 'baseline_import',
            classificationConfidence: 1.0,
            classificationSource: 'IMPORT_EXISTING',
            visualExpression: false,
            visualExpressionSubtype: null,
            visualExpressionConfidence: 0,
            aiDecision: 'SKIPPED',
            replySource: 'IMPORT_EXISTING',
            action: 'SKIP',
            skipReason: 'IMPORT_EXISTING',
            myProfileUrl: this.config.STEAM_PROFILE_URL,
            targetProfileUrl: c.commenterProfileUrl,
            direction: 'INCOMING_FROM_B_TO_A',
            targetDirectionCheck: 'PASS'
          };
        } else {
          diag = await this.processComment(c, index, { persistAndDispatch: true });
        }

        // Structured JSON log and Console human-readable diagnostic
        this.logger.info('COMMENT_DIAGNOSTIC', diag);
        console.log(CommentDiagnosticLogger.formatConsoleDiagnostic(diag));

        // Aggregate summary
        if (diag.action === 'STEAM_MODERATION_PENDING' || diag.skipReason === 'STEAM_MODERATION_PENDING') {
          summary.moderationPending++;
        } else if (
          diag.skipReason === 'ALREADY_REPLIED' ||
          diag.skipReason === 'ALREADY_PROCESSED' ||
          diag.skipReason === 'IMPORT_EXISTING' ||
          diag.skipReason === 'RECOVERY_REQUIRED'
        ) {
          summary.alreadyProcessed++;
        } else if (
          diag.action === 'BLOCKED' ||
          diag.skipReason === 'INVALID_TARGET' ||
          diag.skipReason.startsWith('MISSING_')
        ) {
          summary.errors++;
        } else {
          summary.newComments++;
          if (diag.action === 'SKIP' && diag.skipReason === 'SPAM') {
            summary.spam++;
          } else if (diag.action === 'SKIP' && diag.skipReason === 'RATE_LIMITED') {
            summary.rateLimited++;
          } else if (diag.visualExpression && diag.aiDecision === 'BLOCKED') {
            summary.visualExpressionLocal++;
            summary.visualExpressionSaved++;
            summary.aiRequestsSaved++;
            summary.aiRequestsBlocked++;
          } else if (diag.action === 'REPLY_LOCAL') {
            summary.localReplies++;
            summary.aiRequestsSaved++;
          } else if (diag.action === 'REPLY_AI') {
            summary.deepseekReplies++;
            summary.aiRequests++;
          }
        }
      } catch (err: any) {
        summary.errors++;
        this.logger.error('COMMENT_PROCESSING_ERROR', { commentId: c.commentId, error: err.message });
      }
    }

    // Output scan summary
    this.logger.info('COMMENT_SCAN_SUMMARY', summary);
    console.log(CommentDiagnosticLogger.formatSummary(summary));
  }

  private async dispatchPendingRepliesStep(): Promise<void> {
    // If session state is waiting_for_login, strictly pause send queue without sending POST
    if (this.sessionState === 'waiting_for_login') {
      this.logger.warn('DISPATCH_PAUSED_LOGIN_REQUIRED', 'Send queue is paused awaiting authenticated Steam session');
      return;
    }

    // Global Circuit Breaker Check
    if (this.circuitBreaker.isOpen()) {
      this.logger.info('COMMENT_CIRCUIT_COOLDOWN', {
        state: 'OPEN',
        cooldownUntil: new Date(this.circuitBreaker.getCooldownUntil()).toISOString(),
        remainingSeconds: Math.max(0, Math.round((this.circuitBreaker.getCooldownUntil() - Date.now()) / 1000)),
        reason: 'CIRCUIT_BREAKER_OPEN_HALTING_QUEUE'
      });
      return;
    }

    // Transport Circuit Breaker Check
    if (this.transportCircuitBreaker.isOpen()) {
      this.logger.info('TRANSPORT_CIRCUIT_COOLDOWN', {
        state: 'OPEN',
        cooldownUntil: new Date(this.transportCircuitBreaker.getCooldownUntil()).toISOString(),
        remainingSeconds: Math.max(0, Math.round((this.transportCircuitBreaker.getCooldownUntil() - Date.now()) / 1000)),
        reason: 'TRANSPORT_CIRCUIT_BREAKER_OPEN_HALTING_QUEUE'
      });
      return;
    }

    let isHalfOpenProbe = this.circuitBreaker.isHalfOpen();
    if (isHalfOpenProbe) {
      // Step VI: In HALF_OPEN, first check session health
      this.logger.info('COMMENT_CIRCUIT_HALF_OPEN', {
        reason: 'Cooldown expired. Conducting session health check before probe send.'
      });
      const health = await this.sessionManager.checkSessionHealth();
      if (!health.valid) {
        this.logger.warn('CIRCUIT_HALF_OPEN_SESSION_UNHEALTHY', { reason: health.reason });
        this.transitionSessionState('waiting_for_login');
        return;
      }
    }

    const readyTasks = this.delayQueue.getReadyTasks();

    // In HALF_OPEN probe mode, explicitly prioritize attempt_count === 0 fresh tasks for probing
    if (isHalfOpenProbe && readyTasks.length > 0) {
      const freshIndex = readyTasks.findIndex(t => (t.attempt_count ?? 0) === 0);
      if (freshIndex > 0) {
        const [freshTask] = readyTasks.splice(freshIndex, 1);
        readyTasks.unshift(freshTask);
      }
    }

    for (const task of readyTasks) {
      if (!this.isRunning || this.config.EMERGENCY_STOP) break;

      // Rate limit check
      const rateCheck = this.rateLimiter.canSendReply();
      if (!rateCheck.allowed) {
        this.logger.warn('RATE_LIMIT_DEFER', rateCheck.reason);
        break;
      }

      // Pre-send check: Is comment already replied?
      const comment = this.commentsRepo.findByCommentId(task.steam_comment_id);
      if (!comment || comment.status === 'replied') {
        this.replyTasksRepo.updateStatus(task.task_id, 'skipped');
        continue;
      }

      // DRY RUN Mode: Log and do not send
      if (this.config.DRY_RUN) {
        this.logger.info('DRY_RUN_REPLY_SIMULATED', {
          targetProfileUrl: task.target_profile_url,
          replyText: task.reply_text
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: new Date().toISOString() });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', {
          replied_at: new Date().toISOString()
        });
        continue;
      }

      // Pre-send safety gate for retried tasks: inspect target profile to prevent duplicate POST
      if (task.attempt_count > 0) {
        this.logger.info('RETRY_PRECHECK_STARTED', {
          taskId: task.task_id,
          targetSteamId: task.target_steam_id,
          attemptCount: task.attempt_count,
          targetProfileUrl: task.target_profile_url
        });

        const preCheck = await this.commentSender.checkTargetProfileForExistingComment(
          task.target_profile_url,
          task.reply_text
        );

        if (preCheck === 'FOUND') {
          this.logger.warn('RETRY_PRECHECK_BLOCKED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: task.attempt_count,
            reason: 'COMMENT_ALREADY_FOUND_ON_PROFILE'
          });
          const completedAt = new Date().toISOString();
          this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: completedAt });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', { replied_at: completedAt });
          this.interactionRepo.recordInteraction({
            steamId: task.target_steam_id,
            profileUrl: task.target_profile_url,
            isReplied: true
          });
          continue;
        }

        if (preCheck === 'MODERATION_PENDING') {
          this.logger.warn('RETRY_PRECHECK_BLOCKED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: task.attempt_count,
            reason: 'MODERATION_PENDING_ON_PROFILE'
          });
          this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending');
          this.commentsRepo.updateStatus(task.steam_comment_id, 'submitted_moderation_pending', {
            error_message: 'Reply confirmed in Steam automated content check moderation'
          });
          continue;
        }

        if (preCheck === 'RESTRICTED') {
          this.logger.warn('RETRY_PRECHECK_BLOCKED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: task.attempt_count,
            reason: 'TARGET_RESTRICTION_CONFIRMED_PRECHECK'
          });
          this.replyTasksRepo.updateStatus(task.task_id, 'failed', { attempt_count: task.attempt_count });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
            error_message: 'TARGET_REJECTION_CONFIRMED: Target profile comments restricted'
          });
          continue;
        }

        if (preCheck === 'UNCERTAIN') {
          this.logger.warn('RETRY_PRECHECK_BLOCKED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: task.attempt_count,
            reason: 'PAGE_CHECK_FAILED_OR_TIMEOUT'
          });
          this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state');
          this.commentsRepo.updateStatus(task.steam_comment_id, 'uncertain_send_state', {
            error_message: 'Pre-retry check uncertain; auto-resend blocked for safety'
          });
          continue;
        }

        this.logger.info('RETRY_EXECUTED', {
          taskId: task.task_id,
          targetSteamId: task.target_steam_id,
          attemptCount: task.attempt_count,
          reason: 'PRECHECK_PASSED_CLEAN'
        });
      }

      // LIVE SEND
      const fingerprint = task.reply_fingerprint || computeReplyFingerprint(task.target_steam_id || '', task.reply_text);
      this.replyTasksRepo.updateStatus(task.task_id, 'sending', { started_at: new Date().toISOString(), reply_fingerprint: fingerprint });
      this.commentsRepo.updateStatus(task.steam_comment_id, 'sending');

      const sendResult = await this.commentSender.sendReply(
        task.target_profile_url,
        task.reply_text,
        task.target_steam_id
      );

      this.lastSendResult = {
        target: task.target_profile_url,
        status: sendResult.status,
        timestamp: new Date().toISOString(),
        commentId: sendResult.commentId,
        message: sendResult.message
      };

      // Classification: Transport Pre-Send Failure (safe jittered retry, separate from business attempts)
      if (sendResult.failureClass === 'TRANSPORT_PRE_SEND_FAILURE') {
        this.transportCircuitBreaker.recordFailure();
        const currentRetry = task.transport_retry_count || 0;
        if (currentRetry < 3) {
          const delayMs = (30 + Math.random() * 60) * 1000; // 30~90s + jitter
          const nextScheduledAt = new Date(Date.now() + delayMs).toISOString();
          this.replyTasksRepo.updateStatus(task.task_id, 'waiting', {
            transport_retry_count: currentRetry + 1,
            reply_fingerprint: fingerprint,
            scheduled_at: nextScheduledAt
          });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'waiting', {
            error_message: `Pre-send transport error: ${sendResult.message}`
          });
          this.logger.warn('TRANSPORT_PRE_SEND_RETRY_SCHEDULED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            transportRetryCount: currentRetry + 1,
            scheduledAt: nextScheduledAt,
            delaySeconds: Math.round(delayMs / 1000),
            reason: sendResult.message
          });
        } else {
          this.replyTasksRepo.updateStatus(task.task_id, 'failed', {
            transport_retry_count: currentRetry + 1
          });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
            error_message: `TRANSPORT_PRE_SEND_FAILURE: Exceeded 3 transport retries (${sendResult.message})`
          });
        }
        continue;
      }

      if (sendResult.status === 'SUCCESS' || sendResult.status === 'ALREADY_SENT') {
        this.transportCircuitBreaker.recordSuccess();
        const completedAt = new Date().toISOString();
        this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: completedAt, reply_fingerprint: fingerprint });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', { replied_at: completedAt });
        this.interactionRepo.recordInteraction({
          steamId: task.target_steam_id,
          profileUrl: task.target_profile_url,
          isReplied: true
        });
        this.circuitBreaker.recordSuccess(task.target_steam_id, task.task_id, task.attempt_count);
      } else if (
        sendResult.status === 'MODERATION_PENDING' ||
        sendResult.confirmationStatus === 'SENT_MODERATION_PENDING'
      ) {
        this.logger.warn('SEND_VERIFY_MODERATION_PENDING', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          targetSteamId: task.target_steam_id,
          attemptCount: task.attempt_count,
          message: sendResult.message,
          reason: 'MODERATION_PENDING_NEVER_RETRY'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending', { reply_fingerprint: fingerprint });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'submitted_moderation_pending', {
          error_message: 'Reply submitted but awaiting Steam automated content check'
        });
      } else if (
        sendResult.confirmationStatus === 'TARGET_REJECTION_CONFIRMED' ||
        sendResult.status === 'TARGET_REJECTED' ||
        sendResult.status === 'PERMISSION_DENIED'
      ) {
        this.logger.warn('SEND_TARGET_REJECTED', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          targetSteamId: task.target_steam_id,
          attemptCount: task.attempt_count + 1,
          message: sendResult.message,
          reason: 'TARGET_REJECTION_CONFIRMED_NEVER_RETRY'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'failed', { attempt_count: task.attempt_count + 1 });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
          error_message: sendResult.message || 'TARGET_REJECTION_CONFIRMED: Target profile comments restricted'
        });
      } else if (
        sendResult.failureClass === 'TRANSPORT_POST_ATTEMPTED_UNKNOWN' ||
        sendResult.confirmationStatus === 'SEND_RESULT_UNCERTAIN' ||
        sendResult.status === 'UNCERTAIN'
      ) {
        this.transportCircuitBreaker.recordFailure();
        this.logger.warn('REPLY_STATE_UNCERTAIN', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          targetSteamId: task.target_steam_id,
          attemptCount: task.attempt_count,
          message: sendResult.message,
          reason: 'SEND_RESULT_UNCERTAIN_NEVER_RETRY'
        });
        const now = new Date().toISOString();
        this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state', {
          reply_fingerprint: fingerprint,
          uncertain_verify_count: 0,
          uncertain_last_checked_at: now
        });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'uncertain_send_state', {
          error_message: 'Send state uncertain; auto-resend blocked for safety'
        });
      } else if (sendResult.confirmationStatus === 'CONFIRMED_NOT_SENT') {
        // Safe Retry Type A: postAttempted === false, max 3 total attempts
        const newAttempts = task.attempt_count + 1;
        if (newAttempts < 3) {
          // 1st fail: 2~4 min; 2nd fail: 5~10 min
          const delayMs = newAttempts === 1
            ? (120 + Math.random() * 120) * 1000
            : (300 + Math.random() * 300) * 1000;
          const nextScheduledAt = new Date(Date.now() + delayMs).toISOString();

          this.replyTasksRepo.updateStatus(task.task_id, 'waiting', {
            attempt_count: newAttempts,
            scheduled_at: nextScheduledAt
          });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'waiting', {
            error_message: sendResult.message
          });
          this.logger.info('RETRY_SCHEDULED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: newAttempts,
            retryType: 'CONFIRMED_NOT_SENT',
            scheduledAt: nextScheduledAt,
            delaySeconds: Math.round(delayMs / 1000),
            reason: sendResult.message
          });
        } else {
          this.replyTasksRepo.updateStatus(task.task_id, 'failed', { attempt_count: newAttempts });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
            error_message: sendResult.message || 'CONFIRMED_NOT_SENT: Exceeded max 3 attempts'
          });
        }
      } else if (sendResult.confirmationStatus === 'TRANSIENT_COMMENT_REJECTION') {
        // Safe Retry Type B: postAttempted === true, verified open profile, max 1 retry only!
        this.circuitBreaker.recordTransientRejection(task.target_steam_id, task.task_id, task.attempt_count);

        if (task.attempt_count === 0) {
          // Exactly 1 retry allowed
          const delayMs = (300 + Math.random() * 300) * 1000; // 5~10 min + jitter
          const nextScheduledAt = new Date(Date.now() + delayMs).toISOString();

          this.replyTasksRepo.updateStatus(task.task_id, 'waiting', {
            attempt_count: 1,
            scheduled_at: nextScheduledAt
          });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'waiting', {
            error_message: sendResult.message
          });
          this.logger.info('RETRY_SCHEDULED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: 1,
            retryType: 'TRANSIENT_COMMENT_REJECTION',
            scheduledAt: nextScheduledAt,
            delaySeconds: Math.round(delayMs / 1000),
            reason: 'TRANSIENT_REJECTION_INITIAL_POST'
          });
        } else {
          // Already retried once, strictly terminate!
          this.logger.warn('RETRY_STOPPED_TRANSIENT_MAX_REACHED', {
            taskId: task.task_id,
            targetSteamId: task.target_steam_id,
            attemptCount: task.attempt_count + 1,
            reason: 'TRANSIENT_MAX_1_RETRY_REACHED'
          });
          this.replyTasksRepo.updateStatus(task.task_id, 'failed', { attempt_count: task.attempt_count + 1 });
          this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
            error_message: 'TRANSIENT_COMMENT_REJECTION: Exceeded max 1 retry limit to prevent duplicates'
          });
        }
      } else if (sendResult.status === 'SESSION_INVALID') {
        // Pause task into waiting_for_login without failing or incrementing retry count
        this.replyTasksRepo.updateStatus(task.task_id, 'waiting_for_login');
        this.commentsRepo.updateStatus(task.steam_comment_id, 'waiting_for_login', {
          error_message: sendResult.message || 'Paused: Steam login required'
        });
        this.transitionSessionState('waiting_for_login');
        break;
      } else {
        // Fallback for RATE_LIMITED or other unexpected errors
        this.replyTasksRepo.updateStatus(task.task_id, 'failed', { attempt_count: task.attempt_count + 1 });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
          error_message: sendResult.message || 'Comment send failed'
        });
      }

      if (isHalfOpenProbe) {
        if (this.circuitBreaker.isClosed()) {
          // Probe succeeded! Circuit is now CLOSED and Steam send path is verified healthy.
          // Reset probe flag so remaining ready tasks can proceed in this cycle (subject to rate limit).
          isHalfOpenProbe = false;
        } else {
          // Probe did not close circuit (failed or deferred). Stop dispatch loop for this cycle.
          break;
        }
      }
    }
  }

  private async dispatchHolidayStep(): Promise<void> {
    if (!this.holidayEngine.isWithinSendWindow()) {
      return;
    }

    // Plan any unscheduled holiday greetings for today
    this.holidayEngine.planHolidayGreetingsForToday();

    // Query pending scheduled greetings
    const nowIso = new Date().toISOString();
    const pending = this.holidayRepo.getPendingScheduled(nowIso);

    for (const h of pending) {
      if (!this.isRunning || this.config.EMERGENCY_STOP) break;

      if (this.config.DRY_RUN) {
        this.logger.info('DRY_RUN_HOLIDAY_SIMULATED', { profileUrl: h.profile_url, message: h.message });
        this.holidayRepo.markSent(h.id!);
        continue;
      }

      // Live send holiday greeting
      const sendResult = await this.commentSender.sendReply(h.profile_url, h.message);
      if (sendResult.status === 'SUCCESS' || sendResult.status === 'ALREADY_SENT') {
        this.holidayRepo.markSent(h.id!);
      }
    }
  }

  private isBrowserBusyForRecovery(): boolean {
    if (this.isInteractiveLoginActive) return true;
    if (this.config.EMERGENCY_STOP) return true;
    if (this.browserManager && typeof this.browserManager.isBrowserClosing === 'function' && this.browserManager.isBrowserClosing()) {
      return true;
    }
    return false;
  }

  public async runCrashRecovery(): Promise<void> {
    if (this.isBrowserBusyForRecovery()) {
      this.logger.info('CRASH_RECOVERY_DEFERRED_BUSY', {
        isInteractiveLoginActive: this.isInteractiveLoginActive,
        sessionState: this.sessionState
      });
      return;
    }

    const unfinishedSendingTasks = this.replyTasksRepo.getUnfinishedSendingTasks();
    if (unfinishedSendingTasks.length === 0) return;

    this.logger.info('CRASH_RECOVERY_STARTED', { count: unfinishedSendingTasks.length });

    for (const task of unfinishedSendingTasks) {
      if (this.isBrowserBusyForRecovery()) {
        this.logger.info('CRASH_RECOVERY_LOOP_PAUSED_BUSY', {
          taskId: task.task_id,
          isInteractiveLoginActive: this.isInteractiveLoginActive
        });
        break;
      }

      this.logger.info('RECOVERY_VERIFYING_TARGET', { target: task.target_profile_url });

      // Query target profile to see if the comment was already posted
      let check: string;
      try {
        check = await this.commentSender.checkTargetProfileForExistingComment(
          task.target_profile_url,
          task.reply_text
        );
      } catch (checkErr: any) {
        const isLifecycle = checkErr?.isLifecycleError ||
          checkErr.message?.includes('closed') ||
          checkErr.message?.includes('Protocol error') ||
          checkErr.message?.includes('unavailable') ||
          checkErr.name === 'BrowserLifecycleError';

        this.logger.warn('CRASH_RECOVERY_DEFERRED_BROWSER_LIFECYCLE', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          error: checkErr.message
        });

        if (isLifecycle || this.isBrowserBusyForRecovery()) {
          break; // Defer remaining crash recovery tasks until browser/session is ready
        }
        continue;
      }

      if (check === 'FOUND') {
        this.logger.info('RECOVERY_CONFIRMED_ALREADY_SENT', { taskId: task.task_id });
        this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: new Date().toISOString() });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', { replied_at: new Date().toISOString() });
      } else if (check === 'MODERATION_PENDING') {
        this.logger.info('RECOVERY_CONFIRMED_MODERATION_PENDING', { taskId: task.task_id });
        this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending');
        this.commentsRepo.updateStatus(task.steam_comment_id, 'submitted_moderation_pending', {
          error_message: 'Reply confirmed in Steam moderation queue before crash'
        });
      } else {
        // NOT_FOUND or UNCERTAIN on crash recovery:
        // A crash occurred while sending. We cannot guarantee whether Steam received the POST before crashing.
        // Therefore, strictly transition to uncertain_send_state and block automatic resend for safety!
        this.logger.warn('RECOVERY_STATE_UNCERTAIN', {
          taskId: task.task_id,
          checkResult: check,
          reason: 'Crash occurred during active send. Auto-resend blocked to eliminate duplicate comment risk.'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state');
        this.commentsRepo.updateStatus(task.steam_comment_id, 'uncertain_send_state', {
          error_message: 'Crash occurred during send; auto-resend blocked for idempotency safety'
        });
      }
    }
  }

  public async runUncertainStateRecoveryStep(): Promise<void> {
    if (this.isBrowserBusyForRecovery()) {
      this.logger.info('UNCERTAIN_RECOVERY_DEFERRED_BUSY', {
        isInteractiveLoginActive: this.isInteractiveLoginActive,
        sessionState: this.sessionState
      });
      return;
    }

    const totalUncertain = this.replyTasksRepo.getUncertainTasksCount();
    // Bounded budget: batch limit 3 per cycle directly in SQL to prevent poll starvation
    const uncertainTasks = this.replyTasksRepo.getUncertainTasks(3);
    if (uncertainTasks.length === 0) return;

    this.logger.info('UNCERTAIN_RECOVERY_STARTED', { count: uncertainTasks.length, totalPending: totalUncertain });

    for (const task of uncertainTasks) {
      if (this.isBrowserBusyForRecovery()) {
        this.logger.info('UNCERTAIN_RECOVERY_PAUSED_BUSY', {
          taskId: task.task_id,
          isInteractiveLoginActive: this.isInteractiveLoginActive
        });
        break;
      }

      // Task-level cooldown: at least 3 minutes (180s) between verification checks
      if (task.uncertain_last_checked_at) {
        const lastChecked = new Date(task.uncertain_last_checked_at).getTime();
        const elapsed = Date.now() - lastChecked;
        if (elapsed < 180 * 1000) {
          this.logger.info('UNCERTAIN_TASK_IN_COOLDOWN', {
            taskId: task.task_id,
            remainingSeconds: Math.round((180 * 1000 - elapsed) / 1000)
          });
          continue;
        }
      }

      const now = new Date().toISOString();
      const cachedSession = (this.sessionManager && typeof this.sessionManager.getCachedSessionInfo === 'function')
        ? this.sessionManager.getCachedSessionInfo()
        : null;
      const ourSteamId = cachedSession?.steamId64;

      this.logger.info('UNCERTAIN_RECOVERY_CHECKING', {
        taskId: task.task_id,
        targetProfileUrl: task.target_profile_url,
        verifyCount: task.uncertain_verify_count || 0
      });

      // 1. Multi-factor deep check target profile (up to 2 additional pages)
      let check: string;
      try {
        check = await this.commentSender.checkTargetProfileForExistingComment(
          task.target_profile_url,
          task.reply_text,
          {
            maxExtraPages: 2,
            ourSteamId,
            targetSteamId: task.target_steam_id,
            expectedFingerprint: task.reply_fingerprint
          }
        );
      } catch (checkErr: any) {
        const isLifecycle = checkErr?.isLifecycleError ||
          checkErr.message?.includes('closed') ||
          checkErr.message?.includes('Protocol error') ||
          checkErr.message?.includes('unavailable') ||
          checkErr.name === 'BrowserLifecycleError';

        this.logger.warn('UNCERTAIN_RECOVERY_DEFERRED_BROWSER_LIFECYCLE', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          error: checkErr.message
        });

        // On verification network failure / timeout: strictly update last_checked_at and stay in DELAYED_RECHECK
        // But if browser lifecycle error (browser closed/busy), do not update last_checked_at so it resumes immediately once browser is active
        if (!isLifecycle) {
          this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state', {
            uncertain_last_checked_at: now
          });
        }

        if (isLifecycle || this.isBrowserBusyForRecovery()) {
          break; // Defer remaining uncertain tasks until browser/session is ready
        }
        continue;
      }

      if (check === 'FOUND') {
        // Confirmed existing: update to replied and DO NOT resend
        this.logger.info('UNCERTAIN_RECOVERY_RESOLVED_ALREADY_REPLIED', { taskId: task.task_id });
        const completedAt = new Date().toISOString();
        this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: completedAt, uncertain_last_checked_at: now });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', { replied_at: completedAt });
        this.interactionRepo.recordInteraction({
          steamId: task.target_steam_id,
          profileUrl: task.target_profile_url,
          isReplied: true
        });
      } else if (check === 'MODERATION_PENDING') {
        // Confirmed under moderation: update to submitted_moderation_pending and ABSOLUTELY DO NOT resend
        this.logger.info('UNCERTAIN_RECOVERY_RESOLVED_MODERATION_PENDING', { taskId: task.task_id });
        this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending', { uncertain_last_checked_at: now });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'submitted_moderation_pending', {
          error_message: 'Reply confirmed in Steam automated content check moderation'
        });
      } else if (check === 'UNCERTAIN') {
        // Verification result uncertain: NEVER treat as CONFIRMED_NOT_SENT, NEVER trigger resend!
        this.logger.warn('UNCERTAIN_VERIFICATION_UNCERTAIN_MAINTAINED', {
          taskId: task.task_id,
          reason: 'Verification network check uncertain. Delayed recheck maintained; resend strictly blocked.'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state', {
          uncertain_last_checked_at: now
        });
      } else {
        // check === 'NOT_FOUND': Clean spaced inspection
        const currentVerifyCount = task.uncertain_verify_count || 0;
        const newVerifyCount = currentVerifyCount + 1;

        if (newVerifyCount < 2) {
          // Phase 1 complete: 1st clean inspection passed. Defer to 2nd spaced inspection in >= 3 min before SAFE_TO_RESEND.
          this.logger.info('UNCERTAIN_FIRST_VERIFICATION_PASSED', {
            taskId: task.task_id,
            verifyCount: newVerifyCount,
            reason: '1st clean inspection passed (NOT_FOUND). Deferring to 2nd spaced inspection in >= 3 min before considering SAFE_TO_RESEND.'
          });
          this.replyTasksRepo.updateStatus(task.task_id, 'uncertain_send_state', {
            uncertain_verify_count: newVerifyCount,
            uncertain_last_checked_at: now
          });
        } else {
          // Phase 2 complete: Two clean spaced inspections confirmed NOT_FOUND!
          const currentResendCount = task.uncertain_resend_count || 0;

          if (currentResendCount === 0) {
            // High confidence dual-verification consistent: SAFE_TO_RESEND (Max 1 safe resend allowed)
            this.logger.warn('SAFE_TO_RESEND_VERIFIED', {
              taskId: task.task_id,
              targetSteamId: task.target_steam_id,
              verifyCount: newVerifyCount,
              reason: 'High confidence dual-verification consistent: reply absent on profile. Enqueuing for exactly 1 safe resend.'
            });

            this.replyTasksRepo.updateStatus(task.task_id, 'waiting', {
              uncertain_verify_count: newVerifyCount,
              uncertain_resend_count: 1,
              uncertain_last_checked_at: now,
              attempt_count: task.attempt_count + 1,
              scheduled_at: now
            });
            this.commentsRepo.updateStatus(task.steam_comment_id, 'waiting', {
              error_message: 'High confidence dual-verification passed; re-enqueued for 1 safe resend'
            });
          } else {
            // Already resent once! Strictly forbid 3rd POST! Permanent terminal state.
            this.logger.error('UNCERTAIN_FINAL_FAILURE', {
              taskId: task.task_id,
              targetSteamId: task.target_steam_id,
              resendCount: currentResendCount,
              reason: 'Maximum 1 resend limit reached for UNCERTAIN task. Permanent stop to prevent duplicate comments.'
            });

            this.replyTasksRepo.updateStatus(task.task_id, 'failed', {
              uncertain_verify_count: newVerifyCount,
              uncertain_last_checked_at: now
            });
            this.commentsRepo.updateStatus(task.steam_comment_id, 'failed', {
              error_message: 'UNCERTAIN_MAX_RESEND_REACHED: Strictly terminated after 1 resend attempt'
            });
          }
        }
      }
    }
  }

  public async runModerationPendingRecoveryStep(): Promise<void> {
    if (this.isBrowserBusyForRecovery()) {
      this.logger.info('MODERATION_RECOVERY_DEFERRED_BUSY', {
        isInteractiveLoginActive: this.isInteractiveLoginActive,
        sessionState: this.sessionState
      });
      return;
    }

    const totalMod = this.replyTasksRepo.getModerationPendingTasksCount();
    // Bounded budget: batch limit 3 per cycle directly in SQL to prevent poll starvation
    const modTasks = this.replyTasksRepo.getModerationPendingTasks(3);
    if (modTasks.length === 0) return;

    this.logger.info('MODERATION_RECOVERY_STARTED', { count: modTasks.length, totalPending: totalMod });

    for (const task of modTasks) {
      if (this.isBrowserBusyForRecovery()) {
        this.logger.info('MODERATION_RECOVERY_PAUSED_BUSY', {
          taskId: task.task_id,
          isInteractiveLoginActive: this.isInteractiveLoginActive
        });
        break;
      }

      // Task-level cooldown: 10 minutes between checks
      if (task.uncertain_last_checked_at) {
        const lastChecked = new Date(task.uncertain_last_checked_at).getTime();
        const elapsed = Date.now() - lastChecked;
        if (elapsed < 10 * 60 * 1000) {
          this.logger.info('MODERATION_TASK_IN_COOLDOWN', {
            taskId: task.task_id,
            remainingSeconds: Math.round((10 * 60 * 1000 - elapsed) / 1000)
          });
          continue;
        }
      }

      const now = new Date().toISOString();
      const cachedSession = (this.sessionManager && typeof this.sessionManager.getCachedSessionInfo === 'function')
        ? this.sessionManager.getCachedSessionInfo()
        : null;
      const ourSteamId = cachedSession?.steamId64;

      this.logger.info('MODERATION_RECOVERY_CHECKING', {
        taskId: task.task_id,
        targetProfileUrl: task.target_profile_url
      });

      let check: string;
      try {
        check = await this.commentSender.checkTargetProfileForExistingComment(
          task.target_profile_url,
          task.reply_text,
          {
            maxExtraPages: 2,
            ourSteamId,
            targetSteamId: task.target_steam_id,
            expectedFingerprint: task.reply_fingerprint
          }
        );
      } catch (checkErr: any) {
        const isLifecycle = checkErr?.isLifecycleError ||
          checkErr.message?.includes('closed') ||
          checkErr.message?.includes('Protocol error') ||
          checkErr.message?.includes('unavailable') ||
          checkErr.name === 'BrowserLifecycleError';

        this.logger.warn('MODERATION_RECOVERY_DEFERRED_BROWSER_LIFECYCLE', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          error: checkErr.message
        });

        if (!isLifecycle) {
          this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending', {
            uncertain_last_checked_at: now
          });
        }

        if (isLifecycle || this.isBrowserBusyForRecovery()) {
          break; // Defer remaining moderation recovery tasks until browser/session is ready
        }
        continue;
      }

      if (check === 'FOUND') {
        this.logger.info('SEND_VERIFIED', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          reason: 'Moderation pending resolved and reply verified on target profile'
        });
        const completedAt = new Date().toISOString();
        this.replyTasksRepo.updateStatus(task.task_id, 'replied', { completed_at: completedAt, uncertain_last_checked_at: now });
        this.commentsRepo.updateStatus(task.steam_comment_id, 'replied', { replied_at: completedAt });
        this.interactionRepo.recordInteraction({
          steamId: task.target_steam_id,
          profileUrl: task.target_profile_url,
          isReplied: true
        });
      } else if (check === 'MODERATION_PENDING') {
        this.logger.info('STEAM_MODERATION_PENDING', {
          taskId: task.task_id,
          targetProfileUrl: task.target_profile_url,
          status: 'STILL_PENDING'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending', {
          uncertain_last_checked_at: now
        });
      } else {
        // Still pending or under review: maintain submitted_moderation_pending!
        // ABSOLUTELY DO NOT RESEND! Steam comment was already accepted and is in review.
        this.logger.info('MODERATION_RECOVERY_MAINTAINED', {
          taskId: task.task_id,
          status: 'STILL_IN_MODERATION'
        });
        this.replyTasksRepo.updateStatus(task.task_id, 'submitted_moderation_pending', {
          uncertain_last_checked_at: now
        });
      }
    }
  }

  public printPeriodicStats(): void {
    const todayStr = new Date().toISOString().substring(0, 10);
    const holidayReplies = this.holidayRepo ? this.holidayRepo.getCountSentToday(todayStr) : 0;
    const todayStats = this.commentsRepo.getStatsToday(holidayReplies);
    const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);

    Banner.print({
      mode: this.config.HEADLESS ? 'HEADLESS' : 'VISIBLE',
      steamProfile: this.config.STEAM_PROFILE_URL,
      aiModel: this.config.DEEPSEEK_MODEL,
      checkRange: `${this.config.CHECK_INTERVAL_MIN_SECONDS}~${this.config.CHECK_INTERVAL_MAX_SECONDS} sec`,
      dryRun: this.config.DRY_RUN,
      repliesToday: todayStats.totalReplies,
      localReplies: todayStats.localReplies,
      aiReplies: todayStats.aiReplies,
      aiSavedRequests: todayStats.localReplies,
      spamCount: todayStats.spamCount,
      holidayReplies: holidayReplies,
      visualExpressionReplies: todayStats.visualExpressionReplies,
      visualExpressionSaved: todayStats.visualExpressionSaved,
      memoryMb: memMb,
      uptimeStr: Banner.formatUptime(uptimeSec),
      status: this.config.EMERGENCY_STOP ? 'EMERGENCY_STOPPED' : this.config.BOT_ENABLED ? 'RUNNING' : 'PAUSED'
    });

    // Structured Queue Diagnostics logging for runtime observability
    const oldestPending = this.replyTasksRepo.getOldestPendingTask();
    const circuitState = this.circuitBreaker.getState();
    const farFutureIso = new Date(Date.now() + 86400000 * 365).toISOString();
    const pendingCount = this.replyTasksRepo.getPendingScheduledTasks(farFutureIso).length;

    this.logger.info('QUEUE_RUN_DIAGNOSTICS', {
      circuitBreakerState: circuitState,
      pendingTasksCount: pendingCount,
      oldestPendingTaskAt: oldestPending ? oldestPending.scheduled_at : null,
      lastSendAttemptAt: this.lastSendResult ? this.lastSendResult.timestamp : null,
      lastSendStatus: this.lastSendResult ? this.lastSendResult.status : null
    });
  }

  public getStatusSummary() {
    const runtimeState = RuntimeControl.load(this.config.BOT_ENABLED, this.config.EMERGENCY_STOP, this.botMode);
    const todayStr = new Date().toISOString().substring(0, 10);
    const holidayReplies = this.holidayRepo ? this.holidayRepo.getCountSentToday(todayStr) : 0;
    const todayStats = this.commentsRepo.getStatsToday(holidayReplies);
    const farFutureIso = new Date(Date.now() + 86400000 * 365).toISOString();
    const pendingCount = this.replyTasksRepo.getPendingScheduledTasks(farFutureIso).length;
    const uncertainCount = this.replyTasksRepo.getUncertainTasksCount();
    const moderationPendingCount = this.replyTasksRepo.getModerationPendingTasksCount();
    const waitingForLoginCount = this.replyTasksRepo.getWaitingForLoginTasksCount();
    const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const accountName = this.sessionManager ? this.sessionManager.getCachedSessionInfo().accountName : null;
    const oldestPending = this.replyTasksRepo.getOldestPendingTask();
    const circuitState = this.circuitBreaker.getState();
    const cooldownUntil = this.circuitBreaker.getCooldownUntil();

    return {
      isRunning: this.isRunning,
      botMode: this.botMode,
      lifecycleState: this.lifecycleState,
      browserState: this.getBrowserState(),
      lastError: this.lastError,
      botEnabled: runtimeState.botEnabled,
      emergencyStop: runtimeState.emergencyStop,
      sessionState: this.sessionState,
      accountName: accountName,
      isInteractiveLoginActive: this.isInteractiveLoginActive,
      lastPolledAt: this.lastPolledAt,
      nextPolledAt: this.isRunning && this.nextPollExpectedAt ? this.nextPollExpectedAt : null,
      pollTiming: {
        lastPollDurationMs: this.lastPollDurationMs
      },
      pollLag: {
        detected: this.lastPollLagDetected,
        lagSeconds: this.lastPollLagSeconds
      },
      catchup: {
        lastCatchupCommentsCount: this.lastCatchupCommentsCount,
        limitExceeded: this.commentMonitor.catchupLimitExceeded
      },
      lastSendResult: this.lastSendResult,
      uptimeSeconds: uptimeSec,
      memoryMb: memMb,
      circuitBreaker: {
        state: circuitState,
        cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
        remainingSeconds: cooldownUntil ? Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000)) : 0
      },
      transportCircuitBreaker: this.transportCircuitBreaker.getState(),
      queueDiagnostics: {
        pendingTasksCount: pendingCount,
        uncertainTasksCount: uncertainCount,
        moderationPendingCount,
        oldestPendingTaskAt: oldestPending ? oldestPending.scheduled_at : null,
        lastSendAttemptAt: this.lastSendResult ? this.lastSendResult.timestamp : null,
        lastSendStatus: this.lastSendResult ? this.lastSendResult.status : null
      },
      config: {
        profileUrl: this.config.STEAM_PROFILE_URL,
        aiModel: this.config.DEEPSEEK_MODEL,
        dryRun: this.config.DRY_RUN,
        headless: this.config.HEADLESS
      },
      stats: {
        totalReplies: todayStats.totalReplies,
        localReplies: todayStats.localReplies,
        aiReplies: todayStats.aiReplies,
        spamCount: todayStats.spamCount,
        visualExpressionReplies: todayStats.visualExpressionReplies,
        holidayReplies: holidayReplies,
        pendingTasks: pendingCount,
        uncertainTasks: uncertainCount,
        moderationPendingTasks: moderationPendingCount,
        waitingForLoginTasks: waitingForLoginCount,
        circuitBreakerState: circuitState,
        oldestPendingTaskAt: oldestPending ? oldestPending.scheduled_at : null,
        lastSendAttemptAt: this.lastSendResult ? this.lastSendResult.timestamp : null
      }
    };
  }
}
