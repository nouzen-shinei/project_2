export type NotificationDeviceFailureReason =
  | 'tenant_scope_blocked'
  | 'device_declined'
  | 'delivery_error'
  | string | undefined;

export function describeDeviceFailureReason(reason?: NotificationDeviceFailureReason): string | undefined {
  switch (reason) {
    case 'tenant_scope_blocked':
      return 'Device belongs to another coaching center.';
    case 'device_declined':
      return 'Device declined delivery (offline or notifications disabled).';
    case 'delivery_error':
      return 'Unexpected delivery error.';
    default:
      return reason ? 'Delivery failed.' : undefined;
  }
}
