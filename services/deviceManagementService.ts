import { logger } from '@/lib/logger';
import { deviceTrackingService } from './deviceTrackingService';

/**
 * Background service for device management tasks
 */
class DeviceManagementService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Start background device management tasks
   */
  start(): void {
    // Run cleanup immediately on start
    this.runCleanup();
    
    // Schedule periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.runCleanup();
    }, this.CLEANUP_INTERVAL);

    logger.debug('Device management service started');
  }

  /**
   * Stop background tasks
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.debug('Device management service stopped');
  }

  /**
   * Run device cleanup tasks
   */
  private async runCleanup(): Promise<void> {
    try {
      logger.debug('Running device cleanup...');
      await deviceTrackingService.cleanupOfflineDevices();
      logger.debug('Device cleanup completed');
    } catch (error) {
      logger.error('Device cleanup failed:', error);
    }
  }

  /**
   * Force cleanup now (for admin use)
   */
  async forceCleanup(): Promise<void> {
    await this.runCleanup();
  }
}

export const deviceManagementService = new DeviceManagementService();
