export const formatTodayKey = (d = new Date()) => {
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${mm}-${dd}`;
};

// Extract MM-DD from various date string formats (e.g., YYYY-MM-DD or MM-DD)
export const toMonthDay = (dateStr: string): string | null => {
  if (!dateStr || typeof dateStr !== 'string') return null;
  // Normalize common formats
  // If already MM-DD
  const md = dateStr.match(/^\d{2}-\d{2}$/);
  if (md) return dateStr;
  // If ISO-like YYYY-MM-DD
  const ymd = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[2]}-${ymd[3]}`;
  // Try Date parsing fallback
  const dt = new Date(dateStr);
  if (!isNaN(dt.getTime())) {
    const mm = `${dt.getMonth() + 1}`.padStart(2, '0');
    const dd = `${dt.getDate()}`.padStart(2, '0');
    return `${mm}-${dd}`;
  }
  return null;
};
