import { DateTime } from 'luxon';

export function dayKeyForTimezone(date = new Date(), tz?: string): string {
  try {
    const dt = tz ? DateTime.fromJSDate(date).setZone(tz) : DateTime.fromJSDate(date);
    return dt.toFormat('yyyy-LL-dd');
  } catch {
    return new Date(date).toDateString();
  }
}

export function secondsUntilEndOfDay(tz?: string): number {
  try {
    const now = tz ? DateTime.now().setZone(tz) : DateTime.now();
    const end = now.endOf('day');
    const diffSec = Math.max(1, Math.floor(end.diff(now, 'seconds').seconds));
    return diffSec;
  } catch {
    const end = new Date(); end.setHours(23,59,59,999);
    return Math.max(1, Math.floor((end.getTime() - Date.now())/1000));
  }
}
