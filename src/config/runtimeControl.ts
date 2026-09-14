import * as fs from 'fs';
import * as path from 'path';
import { getRuntimeControlPath } from '../utils/paths';
import { BotMode, BotLifecycleState } from './schema';

export interface RuntimeControlState {
  // First-class orthogonal runtime models
  mode: BotMode;
  lifecycleState: BotLifecycleState;
  lastError?: string | null;

  // Backward-compatible flags
  botEnabled: boolean;
  emergencyStop: boolean;
  dryRunOverride?: boolean | null;
  updatedAt?: string;
  notes?: string;
}

export class RuntimeControl {
  private static filePath: string = getRuntimeControlPath();

  public static setCustomPath(customPath: string): void {
    this.filePath = path.resolve(customPath);
  }

  public static getFilePath(): string {
    return this.filePath;
  }

  public static load(
    defaultBotEnabled: boolean = false,
    defaultEmergencyStop: boolean = false,
    defaultMode?: BotMode
  ): RuntimeControlState {
    const fallbackMode: BotMode = defaultMode || (defaultBotEnabled ? 'AI_ENHANCED' : 'DISABLED');
    const fallbackState: BotLifecycleState = defaultBotEnabled ? 'WAITING' : 'STOPPED';

    if (!fs.existsSync(this.filePath)) {
      // Create initial runtime-control.json if it doesn't exist
      const initial: RuntimeControlState = {
        mode: fallbackMode,
        lifecycleState: fallbackState,
        lastError: null,
        botEnabled: defaultBotEnabled,
        emergencyStop: defaultEmergencyStop,
        dryRunOverride: null,
        updatedAt: new Date().toISOString(),
        notes: "Edit this file at runtime to dynamically adjust mode, lifecycle state, or emergency-stop without restarting the bot."
      };
      try {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      } catch {
        // Ignore write error
      }
      return initial;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content);

      // Determine legacy boolean compatibility
      const botEnabled = parsed.botEnabled !== undefined ? Boolean(parsed.botEnabled) : defaultBotEnabled;
      const emergencyStop = parsed.emergencyStop !== undefined ? Boolean(parsed.emergencyStop) : defaultEmergencyStop;

      // Determine Mode with smooth fallback from legacy botEnabled
      let mode: BotMode = fallbackMode;
      if (parsed.mode && ['LOCAL_ONLY', 'AI_ENHANCED', 'DISABLED'].includes(parsed.mode)) {
        mode = parsed.mode as BotMode;
      } else if (parsed.botEnabled !== undefined) {
        mode = parsed.botEnabled ? 'AI_ENHANCED' : 'DISABLED';
      }

      // Determine Lifecycle State
      let lifecycleState: BotLifecycleState = fallbackState;
      if (parsed.lifecycleState && ['STARTING', 'RUNNING', 'WAITING', 'STOPPING', 'STOPPED', 'ERROR'].includes(parsed.lifecycleState)) {
        lifecycleState = parsed.lifecycleState as BotLifecycleState;
      }

      return {
        mode,
        lifecycleState,
        lastError: parsed.lastError !== undefined ? parsed.lastError : null,
        botEnabled,
        emergencyStop,
        dryRunOverride: parsed.dryRunOverride !== undefined ? parsed.dryRunOverride : null,
        updatedAt: parsed.updatedAt
      };
    } catch (e: any) {
      console.warn(`[RuntimeControl] Failed to parse ${this.filePath}:`, e.message);
      return {
        mode: fallbackMode,
        lifecycleState: fallbackState,
        lastError: null,
        botEnabled: defaultBotEnabled,
        emergencyStop: defaultEmergencyStop
      };
    }
  }

  public static update(state: Partial<RuntimeControlState>): void {
    const current = this.load();

    // Reconcile mode <-> botEnabled bidirectional synchronization
    let nextMode = state.mode !== undefined ? state.mode : current.mode;
    let nextBotEnabled = state.botEnabled !== undefined ? state.botEnabled : current.botEnabled;

    if (state.mode !== undefined && state.botEnabled === undefined) {
      // mode explicitly changed -> align botEnabled
      nextBotEnabled = state.mode !== 'DISABLED';
    } else if (state.botEnabled !== undefined && state.mode === undefined) {
      // botEnabled explicitly changed -> align mode if it creates conflict
      if (state.botEnabled && nextMode === 'DISABLED') {
        nextMode = 'AI_ENHANCED';
      } else if (!state.botEnabled) {
        nextMode = 'DISABLED';
      }
    }

    const merged: RuntimeControlState = {
      ...current,
      ...state,
      mode: nextMode,
      botEnabled: nextBotEnabled,
      updatedAt: new Date().toISOString()
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf8');
  }
}
