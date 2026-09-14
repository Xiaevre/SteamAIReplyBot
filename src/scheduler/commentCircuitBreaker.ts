export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface TransientEvent {
  targetSteamId: string;
  taskId?: string;
  timestamp: number;
}

export interface CircuitBreakerOptions {
  minCooldownMs?: number;
  maxCooldownMs?: number;
  windowMs?: number;
}

export class CommentCircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private cooldownUntil: number = 0;
  private recentTransientEvents: TransientEvent[] = [];
  private readonly minCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly windowMs: number;

  constructor(
    private logger: any,
    options?: CircuitBreakerOptions
  ) {
    this.minCooldownMs = options?.minCooldownMs ?? 15 * 60 * 1000;
    this.maxCooldownMs = options?.maxCooldownMs ?? 30 * 60 * 1000;
    this.windowMs = options?.windowMs ?? 15 * 60 * 1000;
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public getCooldownUntil(): number {
    return this.cooldownUntil;
  }

  public isOpen(): boolean {
    this.checkAndUpdateState();
    return this.state === 'OPEN';
  }

  public isHalfOpen(): boolean {
    this.checkAndUpdateState();
    return this.state === 'HALF_OPEN';
  }

  public isClosed(): boolean {
    this.checkAndUpdateState();
    return this.state === 'CLOSED';
  }

  /**
   * Evaluates whether cooldown has expired and transitions OPEN -> HALF_OPEN.
   */
  public checkAndUpdateState(): CircuitBreakerState {
    if (this.state === 'OPEN') {
      if (Date.now() >= this.cooldownUntil) {
        this.state = 'HALF_OPEN';
        this.logger.info('COMMENT_CIRCUIT_HALF_OPEN', {
          reason: 'COOLDOWN_EXPIRED_READY_FOR_PROBE',
          transitionedAt: new Date().toISOString()
        });
      }
    }
    return this.state;
  }

  /**
   * Records a successful comment send. Closes HALF_OPEN probe or clears transient chains in CLOSED.
   */
  public recordSuccess(targetSteamId?: string, taskId?: string, attemptCount = 0): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.recentTransientEvents = [];
      this.cooldownUntil = 0;
      this.logger.info('COMMENT_CIRCUIT_CLOSED', {
        taskId,
        targetSteamId,
        attemptCount,
        reason: 'PROBE_SEND_SUCCESSFUL'
      });
      return;
    }

    if (this.state === 'CLOSED') {
      // Clear recent transient events so non-consecutive transient rejections don't falsely accumulate
      this.recentTransientEvents = [];
    }
  }

  /**
   * Records a TRANSIENT_COMMENT_REJECTION.
   * Only two consecutive TRANSIENT_COMMENT_REJECTIONs on DIFFERENT SteamIDs will trip to OPEN.
   */
  public recordTransientRejection(targetSteamId: string, taskId?: string, attemptCount = 0): void {
    const now = Date.now();

    // 1. If we were in HALF_OPEN (probe send), any transient rejection immediately re-opens the breaker
    if (this.state === 'HALF_OPEN') {
      this.tripToOpen(
        taskId,
        targetSteamId,
        attemptCount,
        'PROBE_FAILED_IN_HALF_OPEN'
      );
      return;
    }

    // 2. Prune old events outside the tracking window
    this.recentTransientEvents = this.recentTransientEvents.filter(
      (e) => now - e.timestamp <= this.windowMs
    );

    // 3. Inspect last transient event
    const lastEvent = this.recentTransientEvents[this.recentTransientEvents.length - 1];

    if (lastEvent && lastEvent.targetSteamId !== targetSteamId) {
      // Found two consecutive transient rejections across DIFFERENT SteamIDs within the window!
      this.recentTransientEvents.push({ targetSteamId, taskId, timestamp: now });
      this.tripToOpen(
        taskId,
        targetSteamId,
        attemptCount,
        'CONSECUTIVE_TRANSIENT_ACROSS_DISTINCT_TARGETS'
      );
    } else {
      // Same targetSteamId or first event: track it without tripping
      this.recentTransientEvents.push({ targetSteamId, taskId, timestamp: now });
    }
  }

  /**
   * Trips breaker to OPEN with randomized jittered cooldown.
   */
  public tripToOpen(
    taskId?: string,
    targetSteamId?: string,
    attemptCount = 0,
    reason = 'GLOBAL_COMMENT_SEND_SUSPECT'
  ): void {
    this.state = 'OPEN';
    const cooldownMs =
      this.minCooldownMs + Math.random() * (this.maxCooldownMs - this.minCooldownMs);
    this.cooldownUntil = Date.now() + cooldownMs;

    this.logger.warn('COMMENT_CIRCUIT_OPEN', {
      taskId,
      targetSteamId,
      attemptCount,
      reason,
      cooldownMinutes: Math.round(cooldownMs / 60000),
      cooldownUntil: new Date(this.cooldownUntil).toISOString()
    });
  }

  /**
   * Manual reset for test harnesses or administrative overrides.
   */
  public reset(): void {
    this.state = 'CLOSED';
    this.cooldownUntil = 0;
    this.recentTransientEvents = [];
    this.logger.info('COMMENT_CIRCUIT_CLOSED', {
      reason: 'MANUAL_OR_HARNESS_RESET'
    });
  }
}
