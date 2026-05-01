export function pruneMapByKeySet<K, V>(map: Map<K, V>, activeKeys: ReadonlySet<K>): number {
  let removedCount = 0;

  for (const key of map.keys()) {
    if (!activeKeys.has(key)) {
      map.delete(key);
      removedCount += 1;
    }
  }

  return removedCount;
}

export function pruneMapByNumericRange<V>(
  map: Map<number, V>,
  maxExclusive: number,
  minInclusive: number = 0
): number {
  const normalizedMin = Number.isFinite(minInclusive) ? Math.trunc(minInclusive) : 0;
  const normalizedMax = Number.isFinite(maxExclusive) ? Math.trunc(maxExclusive) : 0;

  let removedCount = 0;
  for (const key of map.keys()) {
    if (!Number.isInteger(key) || key < normalizedMin || key >= normalizedMax) {
      map.delete(key);
      removedCount += 1;
    }
  }

  return removedCount;
}

export function pruneDelimitedMapByPrefixSet<V>(
  map: Map<string, V>,
  activePrefixes: ReadonlySet<string>,
  delimiter: string
): number {
  let removedCount = 0;

  for (const key of map.keys()) {
    const separatorIndex = key.indexOf(delimiter);
    const prefix = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;

    if (!activePrefixes.has(prefix)) {
      map.delete(key);
      removedCount += 1;
    }
  }

  return removedCount;
}

export function resolveMapCacheEntry<K, V>(
  map: Map<K, V>,
  key: K,
  createValue: () => V
): V {
  if (map.has(key)) {
    return map.get(key) as V;
  }

  const value = createValue();
  map.set(key, value);
  return value;
}

export function resolveChatAttachmentBaseKeySet<T>(
  attachments: Iterable<T>,
  resolveAttachmentBaseKey: (attachment: T) => string
): Set<string> {
  const activeKeys = new Set<string>();

  for (const attachment of attachments) {
    const key = resolveAttachmentBaseKey(attachment);
    if (key) {
      activeKeys.add(key);
    }
  }

  return activeKeys;
}
