import { clsx, type ClassValue } from "clsx"

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

/**
 * Format a Date object to YYYY-MM-DD string without timezone issues
 * @param date The Date object to format
 * @returns String in YYYY-MM-DD format
 */
export function formatDateToString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get today's date as YYYY-MM-DD string without timezone issues
 * @returns String in YYYY-MM-DD format for today
 */
export function getTodayDateString(): string {
  return formatDateToString(new Date());
}
