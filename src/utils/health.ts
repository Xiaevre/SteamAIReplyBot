import * as os from 'os';
import { Logger } from './logger';

export interface MemoryReport {
  nodeRssMb: number;
  nodeHeapUsedMb: number;
  systemFreeMb: number;
  systemTotalMb: number;
  openPagesCount: number;
  status: 'NORMAL' | 'WARNING' | 'CRITICAL';
}

export class HealthMonitor {
  private warningMb: number;
  private criticalMb: number;
  private logger: Logger;

  constructor(logger: Logger, warningMb: number = 450, criticalMb: number = 700) {
    this.logger = logger;
    this.warningMb = warningMb;
    this.criticalMb = criticalMb;
  }

  public checkHealth(openPagesCount: number = 0): MemoryReport {
    const mem = process.memoryUsage();
    const nodeRssMb = Math.round(mem.rss / (1024 * 1024));
    const nodeHeapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const systemFreeMb = Math.round(os.freemem() / (1024 * 1024));
    const systemTotalMb = Math.round(os.totalmem() / (1024 * 1024));

    let status: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';

    if (nodeRssMb >= this.criticalMb || systemFreeMb < 80) {
      status = 'CRITICAL';
    } else if (nodeRssMb >= this.warningMb || openPagesCount > 3) {
      status = 'WARNING';
    }

    const report: MemoryReport = {
      nodeRssMb,
      nodeHeapUsedMb,
      systemFreeMb,
      systemTotalMb,
      openPagesCount,
      status
    };

    if (status === 'CRITICAL') {
      this.logger.warn('HEALTH_CRITICAL', report);
    } else if (status === 'WARNING') {
      this.logger.warn('HEALTH_WARNING', report);
    }

    return report;
  }
}
