import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getRuntimeRoot } from './paths';

export interface AutostartStatusResult {
  enabled: boolean;
  taskName: string;
  trigger?: 'ONSTART' | 'ONLOGON' | 'UNKNOWN';
  targetCommand?: string;
  details?: string;
  rawOutput?: string;
}

export interface AutostartActionResult {
  success: boolean;
  message: string;
  commandExecuted?: string;
  trigger?: 'ONSTART' | 'ONLOGON';
}

export class WindowsServiceHelper {
  public static readonly TASK_NAME = 'SteamAIReplyBotDaemon';

  /**
   * Resolves the target executable dynamically based on the active runtime root.
   * Strictly avoids hardcoding any developer machine paths.
   */
  public static resolveTargetExe(customExePath?: string): string {
    if (customExePath && fs.existsSync(customExePath)) {
      return path.resolve(customExePath);
    }

    const root = getRuntimeRoot();
    const candidate1 = path.resolve(root, 'SteamAIReplyBot.exe');
    if (fs.existsSync(candidate1)) {
      return candidate1;
    }

    const candidate2 = path.resolve(root, 'release', 'SteamAIReplyBot.exe');
    if (fs.existsSync(candidate2)) {
      return candidate2;
    }

    const candidate3 = path.resolve(process.cwd(), 'SteamAIReplyBot.exe');
    if (fs.existsSync(candidate3)) {
      return candidate3;
    }

    // Default fallback to candidate1 (standard deployment layout)
    return candidate1;
  }

  public static readonly SCHTASKS_TIMEOUT_MS = 3000;

  /**
   * Pluggable runner for executing schtasks with strict timeout and pipe management.
   */
  public static executeSchtasks: (cmd: string, timeoutMs?: number) => { stdout: string; error?: any } = (
    cmd: string,
    timeoutMs: number = 3000
  ) => {
    try {
      const output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true
      });
      return { stdout: output };
    } catch (err: any) {
      return { stdout: '', error: err };
    }
  };

  /**
   * Inspects the current registration status of the Windows Task Scheduler task.
   */
  public static getAutostartStatus(taskName: string = this.TASK_NAME): AutostartStatusResult {
    const res = this.executeSchtasks(`schtasks /query /tn "${taskName}"`, this.SCHTASKS_TIMEOUT_MS);
    if (res.error) {
      const err = res.error;
      const isTimeout = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
      if (isTimeout) {
        console.warn(`[TaskScheduler] Query for task '${taskName}' timed out after ${this.SCHTASKS_TIMEOUT_MS}ms.`);
      }
      return {
        enabled: false,
        taskName,
        details: isTimeout
          ? `Querying task '${taskName}' timed out after ${this.SCHTASKS_TIMEOUT_MS}ms.`
          : `Task '${taskName}' is not registered or cannot be queried.`
      };
    }

    const output = res.stdout;
    let trigger: 'ONSTART' | 'ONLOGON' | 'UNKNOWN' = 'UNKNOWN';
    const upper = output.toUpperCase();
    if (upper.includes('ONSTART') || upper.includes('AT SYSTEM STARTUP') || upper.includes('开机时') || upper.includes('启动时')) {
      trigger = 'ONSTART';
    } else if (upper.includes('ONLOGON') || upper.includes('AT LOGON') || upper.includes('登录时')) {
      trigger = 'ONLOGON';
    }

    // Extract task to run if available
    let targetCommand: string | undefined;
    const match = output.match(/(?:Task To Run|要运行的任务):\s*(.+)/i);
    if (match && match[1]) {
      targetCommand = match[1].trim();
    }

    return {
      enabled: true,
      taskName,
      trigger,
      targetCommand,
      details: `Task '${taskName}' is registered in Windows Task Scheduler (Trigger: ${trigger}).`,
      rawOutput: output
    };
  }

  /**
   * Enables Windows autostart.
   * Default: ONLOGON (User logon with desktop session and 30s delay)
   */
  public static enableAutostart(options?: {
    exePath?: string;
    trigger?: 'ONSTART' | 'ONLOGON';
    taskName?: string;
    dryRun?: boolean;
    delaySeconds?: number;
  }): AutostartActionResult {
    const taskName = options?.taskName || this.TASK_NAME;
    const trigger = options?.trigger || 'ONLOGON';
    const targetExe = this.resolveTargetExe(options?.exePath);
    const delaySec = options?.delaySeconds !== undefined ? options?.delaySeconds : 30;
    const delayArg = delaySec > 0 ? ` /delay 0000:${delaySec.toString().padStart(2, '0')}` : '';

    // Assemble schtasks command with --background and --headless flags
    // /f forces overwrite to prevent duplicate tasks
    let cmd = '';
    if (trigger === 'ONSTART') {
      // ONSTART runs on system startup under SYSTEM account without requiring user logon
      cmd = `schtasks /create /tn "${taskName}" /tr "\\"${targetExe}\\" --background --headless"${delayArg} /sc onstart /ru "SYSTEM" /rl highest /f`;
    } else {
      // ONLOGON runs when user logs into Windows desktop (interactive user session, never Session 0)
      cmd = `schtasks /create /tn "${taskName}" /tr "\\"${targetExe}\\" --background --headless"${delayArg} /sc onlogon /rl highest /f`;
    }

    if (options?.dryRun) {
      return {
        success: true,
        message: `[DryRun] Autostart command verified for '${taskName}' with trigger [${trigger}].`,
        commandExecuted: cmd,
        trigger
      };
    }

    console.log(`[TaskScheduler] Configuring autostart task '${taskName}' with trigger [${trigger}]...`);
    const res = this.executeSchtasks(cmd, this.SCHTASKS_TIMEOUT_MS);
    if (res.error) {
      const err = res.error;
      const isTimeout = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
      const errMsg = isTimeout
        ? `Task registration timed out after ${this.SCHTASKS_TIMEOUT_MS}ms.`
        : (err.stderr ? err.stderr.toString().trim() : (err.message || String(err)));
      console.error(`[TaskScheduler] Failed to configure autostart task '${taskName}':`, errMsg);
      return {
        success: false,
        message: errMsg,
        commandExecuted: cmd,
        trigger
      };
    }

    const msg = `Successfully registered '${taskName}' with trigger ${trigger}.`;
    console.log(`[TaskScheduler] ${msg}`);
    return {
      success: true,
      message: msg,
      commandExecuted: cmd,
      trigger
    };
  }

  /**
   * Disables Windows autostart by deleting the scheduled task.
   */
  public static disableAutostart(taskName: string = this.TASK_NAME): AutostartActionResult {
    const cmd = `schtasks /delete /tn "${taskName}" /f`;

    // If task is not registered, it is already effectively disabled
    const currentStatus = this.getAutostartStatus(taskName);
    if (!currentStatus.enabled) {
      return {
        success: true,
        message: `Task '${taskName}' was not registered (already disabled).`,
        commandExecuted: cmd
      };
    }

    console.log(`[TaskScheduler] Removing autostart task '${taskName}'...`);
    const res = this.executeSchtasks(cmd, this.SCHTASKS_TIMEOUT_MS);
    if (res.error) {
      // Recheck status: if no longer enabled, treat as disabled
      const isNowDisabled = !this.getAutostartStatus(taskName).enabled;
      if (isNowDisabled) {
        return {
          success: true,
          message: `Task '${taskName}' is successfully disabled.`,
          commandExecuted: cmd
        };
      }
      const err = res.error;
      const isTimeout = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
      const errMsg = isTimeout
        ? `Task removal timed out after ${this.SCHTASKS_TIMEOUT_MS}ms.`
        : (err.stderr ? err.stderr.toString().trim() : (err.message || String(err)));
      console.error(`[TaskScheduler] Failed to disable autostart task '${taskName}':`, errMsg);
      return {
        success: false,
        message: errMsg,
        commandExecuted: cmd
      };
    }

    const msg = `Successfully removed scheduled task '${taskName}'.`;
    console.log(`[TaskScheduler] ${msg}`);
    return {
      success: true,
      message: msg,
      commandExecuted: cmd
    };
  }

  /**
   * Backward-compatible installation method.
   */
  public static installTaskScheduler(exePath?: string, trigger: 'ONSTART' | 'ONLOGON' = 'ONLOGON'): boolean {
    const res = this.enableAutostart({ exePath, trigger });
    return res.success;
  }

  /**
   * Backward-compatible uninstallation method.
   */
  public static uninstallTaskScheduler(taskName: string = this.TASK_NAME): boolean {
    const res = this.disableAutostart(taskName);
    return res.success;
  }
}
