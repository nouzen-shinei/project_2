export function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as any;
  }
  if (typeof value === 'object') {
    // Preserve non-plain objects (Firestore sentinels like FieldValue.serverTimestamp(),
    // Timestamp, GeoPoint, DocumentReference, etc). Treat only POJOs as maps.
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
      return value;
    }
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value as any)) {
      const cleaned = stripUndefinedDeep(entry);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out as any;
  }
  return value;
}
