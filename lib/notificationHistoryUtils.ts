import { useAdminNotificationHistory } from '../hooks/useAdminNotificationHistory';
import { adminNotificationHistoryService } from '../services/adminNotificationHistoryService';

// Export the service and hook for easy access
export { useAdminNotificationHistory, adminNotificationHistoryService };

// Example usage and testing functions
export const notificationHistoryUtils = {
  // Test function to save a sample notification
  async saveTestNotification(adminEmail: string, adminName: string) {
    const testNotification = {
      adminEmail,
      adminName,
      title: 'Test Admin Notification',
      body: 'This is a test notification to verify the history system is working correctly.',
      type: 'info' as const,
      priority: 'normal' as const,
      targetUsers: ['test@example.com'],
      targetDevices: [{ email: 'test@example.com', deviceId: 'test-device-123', deviceName: 'Test Device' }],
      totalTargets: 2,
      successfulDeliveries: 1,
      failedDeliveries: 1,
      userResults: [{ email: 'test@example.com', success: 1, failed: 0 }],
      deviceResults: [{ email: 'test@example.com', deviceId: 'test-device-123', success: false, deviceName: 'Test Device' }],
      deliveryMethod: 'mixed' as const,
      onlineOnly: true,
      data: { 
        testData: true,
        type: 'admin_notification',
        timestamp: Date.now()
      },
      sentAt: new Date() as any
    };

    return await adminNotificationHistoryService.saveNotificationHistory(testNotification);
  },

  // Get notification statistics summary
  async getStatsSummary(adminEmail?: string, days = 30, tenantId?: string) {
    const stats = await adminNotificationHistoryService.getNotificationStats({
      adminEmail,
      days,
      tenantId,
    });
    
    return {
      summary: `${stats.totalNotifications} notifications sent in last ${days} days`,
      successRate: `${Math.round(stats.averageSuccessRate * 100)}% average success rate`,
      recipients: `${stats.totalRecipientsReached} total recipients reached`,
      breakdown: {
        successful: stats.successfulNotifications,
        failed: stats.failedNotifications,
        byType: stats.notificationsByType,
        byPriority: stats.notificationsByPriority
      }
    };
  },

  // Search notifications by keyword
  async searchNotificationsByKeyword(keyword: string, adminEmail?: string, tenantId?: string) {
    return await adminNotificationHistoryService.searchNotifications(keyword, {
      adminEmail,
      tenantId,
      pageSize: 50,
    });
  }
};

export default notificationHistoryUtils;
