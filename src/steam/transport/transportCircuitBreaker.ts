import { Logger } from '../../utils/logger';

export type TransportCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class TransportCircuitBreaker {
  private state: TransportCircuitState = 'CLOSED';
  private consecutiveFailures: number = 0;
  private cooldownUntil: number = 0;
  private failureThreshold: number = 3;
  private cooldownDurationMs: number = 60000; // 1 minute

  constructor(
    private logger: Logger,
    options?: { failureThreshold?: number; cooldownSeconds?: number }
  ) {
    if (options?.failureThreshold) this.failureThreshold = options.failureThreshold;
    if (options?.cooldownSeconds) this.cooldownDurationMs = options.cooldownSeconds * 1000;
  }

  public getState(): TransportCircuitState {
    if (this.state === 'OPEN' && Date.now() >= this.cooldownUntil) {
      this.state = 'HALF_OPEN';
      this.logger.info('TRANSPORT_CIRCUIT_HALF_OPEN', {
        reason: 'Transport cooldown expired. Ready for probe request.'
      });
    }
    return this.state;
  }

  public isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  public isHalfOpen(): boolean {
    return this.getState() === 'HALF_OPEN';
  }

  public isBlocked(): boolean {
    return this.isOpen();
  }

  public recordSuccess(): void {
    if (this.state !== 'CLOSED') {
      this.logger.info('TRANSPORT_CIRCUIT_CLOSED', {
        reason: 'Transport probe succeeded. Network path to Steam restored.'
      });
    }
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this.cooldownUntil = 0;
  }

  public recordFailure(errorReason?: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.cooldownUntil = Date.now() + this.cooldownDurationMs;
      this.logger.warn('TRANSPORT_CIRCUIT_OPEN', {
        consecutiveFailures: this.consecutiveFailures,
        cooldownSeconds: Math.round(this.cooldownDurationMs / 1000),
        reason: errorReason || 'Repeated transport network failure'
      });
    }
  }

  public getCooldownUntil(): number {
    return this.cooldownUntil;
  }
}
