// Shared phone number normalization helpers
// Mirrors the logic used in Reminders flow to ensure E.164 with +91 for 10-digit Indian numbers

export function normalizePhoneNumber(phone: string): string {
  if (!phone) return '';

  const digitsOnly = phone.replace(/\D/g, '');

  // If it starts with 91 and has total 12 digits, assume already in E.164 (without '+')
  if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
    return `+${digitsOnly}`;
  }

  // If it's a 10-digit local Indian number, prefix +91
  if (digitsOnly.length === 10) {
    return `+91${digitsOnly}`;
  }

  // If original already has a leading '+', keep as-is
  if (phone.startsWith('+')) {
    return phone;
  }

  // Fallback: add '+' to whatever digits we have; callers should ensure valid numbers
  return `+${digitsOnly}`;
}
