/**
 * Shared fakes for the storage-orphan-cleanup Phase 2 suites (spec tasks 6.5–6.10).
 *
 * NOT a test file — jest's `testMatch` is `**​/__tests__/**​/*.test.ts`, so this
 * module is only ever imported.
 *
 * ── One chronological operation log ─────────────────────────────────────────
 *
 * The fake bucket, the in-memory Firestore and the in-memory Realtime Database all
 * append to a SINGLE ordered log. That is what makes the ordering claims directly
 * assertable rather than inferred: "the resume cursor is persisted after the
 * page's work", "copy precedes delete for every object", "the quota recompute
 * happens once, after the last page" are all statements about the relative
 * position of two entries in one list. The precedent is
 * `storageUploadRoute.integration.test.ts`.
 *
 * Every fake also records the SET of method names invoked on it, because Property
 * 6 is stated over the methods called rather than over an outcome: a mutation that
 * happened to be a no-op must still fail the assertion.
 */

// ─── The log ─────────────────────────────────────────────────────────────────

export interface Operation {
  /** `bucket` | `firestore` | `rtdb` */
  store: 'bucket' | 'firestore' | 'rtdb';
  /** The method invoked, e.g. `getFiles`, `file.copy`, `doc.set`, `ref.get`. */
  method: string;
  /** The object path / document path / database path it was invoked on. */
  target: string;
  /** `read` for anything that cannot change state, `write` for anything that can. */
  kind: 'read' | 'write';
  detail?: Record<string, unknown>;
}

export interface OperationLog {
  entries: Operation[];
  record(entry: Operation): void;
  /** Every distinct `store.method` seen. Property 6 asserts over this. */
  methods(): string[];
  writes(): Operation[];
  filter(predicate: (entry: Operation) => boolean): Operation[];
  indexOf(predicate: (entry: Operation) => boolean): number;
  clear(): void;
}

export function createOperationLog(): OperationLog {
  const entries: Operation[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
    methods() {
      return Array.from(new Set(entries.map((entry) => `${entry.store}.${entry.method}`))).sort();
    },
    writes() {
      return entries.filter((entry) => entry.kind === 'write');
    },
    filter(predicate) {
      return entries.filter(predicate);
    },
    indexOf(predicate) {
      return entries.findIndex(predicate);
    },
    clear() {
      entries.length = 0;
    },
  };
}

// ─── The bucket ──────────────────────────────────────────────────────────────

export const BUCKET_NAME = 'tution-app-6c0c3.firebasestorage.app';

export interface FakeObject {
  name: string;
  size: number;
  /** RFC 3339, as GCS returns. Omit both to make the age unreadable. */
  timeCreated?: string;
  updated?: string;
  /**
   * Custom object metadata, i.e. GCS's `metadata.metadata` bag — which is where
   * `firebaseStorageDownloadTokens` lives. Carried through `copy` exactly as GCS
   * carries it, so "a restored object still answers its original download URL" is
   * assertable rather than assumed.
   */
  metadata?: Record<string, string>;
}

export interface GetFilesCall {
  index: number;
  prefix: string | undefined;
  pageToken: string | undefined;
  maxResults: number | undefined;
  autoPaginate: boolean | undefined;
}

export interface FakeBucketOptions {
  log: OperationLog;
  objects: FakeObject[];
  name?: string;
  /**
   * The order in which the listing returns object names. Defaults to
   * lexicographic, as GCS does. Overridden by Property 14, which asserts that no
   * ordering of the listing changes a single verdict — so the fake has to be able
   * to return an order the sweep did not choose.
   */
  order?: string[];
  /**
   * Throw from `getFiles` when this returns a value. Receives every call, so a
   * test can fail only the paged listing (`maxResults` set) and leave the quota
   * recompute (which pages without `maxResults`) working.
   */
  failGetFiles?: (call: GetFilesCall) => unknown | undefined;
  /** Make a mover's `copy` or `delete` fail, for the quota over-count cases. */
  failCopy?: (objectPath: string) => unknown | undefined;
  failDelete?: (objectPath: string) => unknown | undefined;
  /**
   * Throw from `file(path).getMetadata()`. The quarantine move's VERIFY step is
   * the only caller, so this injects "the copy cannot be verified" without
   * disturbing the listing, which reads metadata off the `getFiles` page instead.
   */
  failGetMetadata?: (objectPath: string) => unknown | undefined;
  /**
   * Report a DIFFERENT byte size from `file(path).getMetadata()` than the object
   * actually has. Applied to `getMetadata` only, never to the listing, so a test
   * can make a copy land at the right path with the wrong size — the one failure
   * mode a fake that simply mirrors the source cannot otherwise produce.
   */
  metadataSizeOverride?: (objectPath: string) => number | undefined;
}

export interface FakeBucket {
  name: string;
  getFiles(options: Record<string, unknown>): Promise<unknown[]>;
  file(objectPath: string): Record<string, unknown>;
  /** Current bucket contents, keyed by object name. */
  contents(): Map<string, FakeObject>;
  getFilesCalls: GetFilesCall[];
}

/**
 * A bucket that pages, tracks metadata, and logs EVERY method invoked on it or on
 * a `file()` handle — including the mutators, which report mode must never reach.
 */
export function createFakeBucket(options: FakeBucketOptions): FakeBucket {
  const store = new Map<string, FakeObject>();
  for (const object of options.objects) store.set(object.name, { ...object });
  const getFilesCalls: GetFilesCall[] = [];

  const metadataOf = (object: FakeObject): Record<string, unknown> => ({
    size: String(object.size),
    ...(object.timeCreated === undefined ? {} : { timeCreated: object.timeCreated }),
    ...(object.updated === undefined ? {} : { updated: object.updated }),
    ...(object.metadata === undefined ? {} : { metadata: { ...object.metadata } }),
  });

  const bucket: FakeBucket = {
    name: options.name ?? BUCKET_NAME,
    getFilesCalls,
    contents: () => store,

    async getFiles(query: Record<string, unknown>) {
      const call: GetFilesCall = {
        index: getFilesCalls.length,
        prefix: typeof query.prefix === 'string' ? query.prefix : undefined,
        pageToken: typeof query.pageToken === 'string' ? query.pageToken : undefined,
        maxResults: typeof query.maxResults === 'number' ? query.maxResults : undefined,
        autoPaginate: typeof query.autoPaginate === 'boolean' ? query.autoPaginate : undefined,
      };
      getFilesCalls.push(call);
      options.log.record({
        store: 'bucket',
        method: 'getFiles',
        target: call.prefix ?? '',
        kind: 'read',
        detail: { pageToken: call.pageToken ?? null, maxResults: call.maxResults ?? null },
      });

      const failure = options.failGetFiles?.(call);
      if (failure !== undefined) throw failure;

      // GCS lists lexicographically by name unless `order` says otherwise, and its
      // page token is opaque — here the LAST NAME the previous page returned, i.e.
      // a cursor, deliberately not an offset into the list.
      //
      // The distinction is load-bearing for every walk that mutates as it goes: an
      // apply-mode sweep deletes each original after copying it, and
      // `purgeExpiredQuarantine` deletes as it pages. Under an offset token those
      // deletions shift the remaining objects left and the next page silently skips
      // one per deletion — which is a bug in the fake, not in the code under test.
      // A name cursor is stable under deletion behind it, exactly as GCS's is.
      const prefix = call.prefix ?? '';
      const order = options.order;
      const ordered = order ? order.filter((name) => store.has(name)) : Array.from(store.keys()).sort();
      const all = ordered.filter((name) => name.startsWith(prefix));

      const cursor = call.pageToken ? call.pageToken.replace(/^after:/, '') : null;
      // A generated ordering is not sorted, so "after the cursor" is resolved
      // against the ORDER array — which is fixed for the run and therefore stable
      // even when the cursor object has since been deleted.
      const cursorPosition = cursor !== null && order ? order.indexOf(cursor) : -1;
      let names =
        cursor === null
          ? all
          : cursorPosition >= 0
            ? all.filter((name) => order!.indexOf(name) > cursorPosition)
            : all.filter((name) => name > cursor);

      let nextPageToken: string | undefined;
      if (call.maxResults !== undefined && names.length > call.maxResults) {
        names = names.slice(0, call.maxResults);
        nextPageToken = `after:${names[names.length - 1]}`;
      }

      const files = names.map((name) => {
        const object = store.get(name)!;
        return { name, metadata: metadataOf(object) };
      });

      // Recorded so "the union of objects a run examined" is observable from the
      // log rather than inferred. A page is fetched and then fully examined, so the
      // two coincide as long as a failure is injected at fetch time.
      options.log.record({
        store: 'bucket',
        method: 'getFiles.page',
        target: prefix,
        kind: 'read',
        detail: { names, maxResults: call.maxResults ?? null },
      });

      return [
        files,
        nextPageToken ? { pageToken: nextPageToken } : null,
        nextPageToken ? { nextPageToken } : {},
      ];
    },

    file(objectPath: string) {
      const mutator = (method: string, body?: () => void) => async () => {
        options.log.record({ store: 'bucket', method: `file.${method}`, target: objectPath, kind: 'write' });
        body?.();
        return [{}];
      };
      return {
        name: objectPath,
        async get() {
          options.log.record({ store: 'bucket', method: 'file.get', target: objectPath, kind: 'read' });
          return [{}];
        },
        async exists() {
          options.log.record({ store: 'bucket', method: 'file.exists', target: objectPath, kind: 'read' });
          return [store.has(objectPath)];
        },
        async getMetadata() {
          options.log.record({
            store: 'bucket',
            method: 'file.getMetadata',
            target: objectPath,
            kind: 'read',
          });
          const failure = options.failGetMetadata?.(objectPath);
          if (failure !== undefined) throw failure;
          const object = store.get(objectPath);
          if (!object) throw new Error(`No such object: ${objectPath}`);
          const overriddenSize = options.metadataSizeOverride?.(objectPath);
          return [
            overriddenSize === undefined
              ? metadataOf(object)
              : { ...metadataOf(object), size: String(overriddenSize) },
          ];
        },
        async copy(destination: unknown) {
          const destinationPath =
            typeof destination === 'string'
              ? destination
              : String((destination as { name?: unknown })?.name ?? '');
          options.log.record({
            store: 'bucket',
            method: 'file.copy',
            target: objectPath,
            kind: 'write',
            detail: { destination: destinationPath },
          });
          const failure = options.failCopy?.(objectPath);
          if (failure !== undefined) throw failure;
          const object = store.get(objectPath);
          if (!object) throw new Error(`No such object: ${objectPath}`);
          store.set(destinationPath, { ...object, name: destinationPath });
          return [{}];
        },
        async delete() {
          options.log.record({ store: 'bucket', method: 'file.delete', target: objectPath, kind: 'write' });
          const failure = options.failDelete?.(objectPath);
          if (failure !== undefined) throw failure;
          store.delete(objectPath);
          return [{}];
        },
        save: mutator('save'),
        move: mutator('move'),
        setMetadata: mutator('setMetadata'),
        makePublic: mutator('makePublic'),
        createWriteStream: () => {
          options.log.record({
            store: 'bucket',
            method: 'file.createWriteStream',
            target: objectPath,
            kind: 'write',
          });
          return {};
        },
      };
    },
  };

  return bucket;
}

/**
 * A quarantine mover standing in for task 8's `quarantineObject`, so the
 * apply-mode half of Property 13 is assertable before the real mover exists.
 *
 * Deliberately minimal — copy, verify, delete, in that order — and NOT the
 * implementation: task 8 owns the manifest entry, the scope assertion and the
 * failure accounting. This exists only to make apply mode observable.
 */
export function createTestQuarantineMover(log: OperationLog) {
  return async (args: {
    bucket: unknown;
    tenantId: string;
    sweepId: string;
    objectPath: string;
    bytes: number | null;
  }): Promise<{ ok: true; bytes: number | null } | { ok: false; message: string }> => {
    const bucket = args.bucket as FakeBucket;
    const destination = `_orphan-quarantine/${args.tenantId}/${args.sweepId}/${args.objectPath}`;
    try {
      await (bucket.file(args.objectPath) as { copy(d: unknown): Promise<unknown> }).copy(
        bucket.file(destination)
      );
    } catch (error) {
      log.record({ store: 'bucket', method: 'quarantine.copyFailed', target: args.objectPath, kind: 'read' });
      return { ok: false, message: String(error) };
    }
    try {
      await (bucket.file(destination) as { getMetadata(): Promise<unknown> }).getMetadata();
    } catch (error) {
      return { ok: false, message: String(error) };
    }
    try {
      await (bucket.file(args.objectPath) as { delete(): Promise<unknown> }).delete();
    } catch (error) {
      return { ok: false, message: String(error) };
    }
    return { ok: true, bytes: args.bytes };
  };
}

// ─── Firestore ───────────────────────────────────────────────────────────────

export type DocData = Record<string, unknown>;

export interface FakeFirestoreOptions {
  log: OperationLog;
  /** Collection name → document id → data. */
  collections?: Record<string, Record<string, DocData>>;
  /** Collection name → value thrown by every read of it. */
  failures?: Record<string, unknown>;
  /** Document path → value thrown by every write to it. */
  writeFailures?: Record<string, unknown>;
}

export interface FakeFirestore {
  collection(name: string): Record<string, unknown>;
  doc(path: string): Record<string, unknown>;
  /** Raw document store, keyed by full path. */
  documents: Map<string, DocData>;
  read(path: string): DocData | undefined;
}

/**
 * A queryable in-memory Firestore supporting `where('tenantId','==',t).get()`,
 * `doc().get()` and `set(data, { merge: true })`, with every write logged by full
 * document path — which is what lets Property 6 assert that report mode writes
 * nothing outside `storageMaintenanceJobs/`.
 */
export function createFakeFirestore(options: FakeFirestoreOptions): FakeFirestore {
  const documents = new Map<string, DocData>();
  for (const [name, docs] of Object.entries(options.collections ?? {})) {
    for (const [id, data] of Object.entries(docs)) documents.set(`${name}/${id}`, { ...data });
  }

  const failIfConfigured = (name: string): void => {
    if (Object.prototype.hasOwnProperty.call(options.failures ?? {}, name)) {
      throw (options.failures as Record<string, unknown>)[name];
    }
  };

  const snapshotFor = (path: string) => {
    const data = documents.get(path);
    return {
      id: path.slice(path.lastIndexOf('/') + 1),
      ref: { path },
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : data),
    };
  };

  const writeDoc = async (path: string, data: DocData, merge: boolean): Promise<void> => {
    options.log.record({ store: 'firestore', method: 'doc.set', target: path, kind: 'write' });
    if (Object.prototype.hasOwnProperty.call(options.writeFailures ?? {}, path)) {
      throw (options.writeFailures as Record<string, unknown>)[path];
    }
    const existing = merge ? (documents.get(path) ?? {}) : {};
    documents.set(path, { ...existing, ...data });
  };

  const docHandle = (path: string) => ({
    path,
    async get() {
      options.log.record({ store: 'firestore', method: 'doc.get', target: path, kind: 'read' });
      failIfConfigured(path.slice(0, path.indexOf('/')));
      return snapshotFor(path);
    },
    async set(data: DocData, options_?: { merge?: boolean }) {
      await writeDoc(path, data, options_?.merge === true);
    },
    async update(data: DocData) {
      options.log.record({ store: 'firestore', method: 'doc.update', target: path, kind: 'write' });
      documents.set(path, { ...(documents.get(path) ?? {}), ...data });
    },
    async create(data: DocData) {
      options.log.record({ store: 'firestore', method: 'doc.create', target: path, kind: 'write' });
      documents.set(path, { ...data });
    },
    async delete() {
      options.log.record({ store: 'firestore', method: 'doc.delete', target: path, kind: 'write' });
      documents.delete(path);
    },
  });

  const collection = (name: string) => {
    const filters: [string, string, unknown][] = [];
    const query: Record<string, unknown> = {
      where(field: string, operator: string, value: unknown) {
        filters.push([field, operator, value]);
        return query;
      },
      async get() {
        options.log.record({ store: 'firestore', method: 'query.get', target: name, kind: 'read' });
        failIfConfigured(name);
        const entries = Array.from(documents.entries())
          .filter(([path]) => path.startsWith(`${name}/`) && !path.slice(name.length + 1).includes('/'))
          .filter(([, data]) =>
            filters.every(([field, operator, value]) => operator === '==' && data?.[field] === value)
          );
        const docs = entries.map(([path]) => snapshotFor(path));
        return {
          size: docs.length,
          empty: docs.length === 0,
          docs,
          forEach(callback: (doc: (typeof docs)[number]) => void) {
            for (const doc of docs) callback(doc);
          },
        };
      },
      doc: (id: string) => docHandle(`${name}/${id}`),
      add: async (data: DocData) => {
        options.log.record({ store: 'firestore', method: 'collection.add', target: name, kind: 'write' });
        const id = `generated_${documents.size}`;
        documents.set(`${name}/${id}`, { ...data });
        return { id };
      },
    };
    return query;
  };

  return {
    collection,
    doc: (path: string) => docHandle(path),
    documents,
    read: (path: string) => documents.get(path),
  };
}

// ─── Realtime Database ───────────────────────────────────────────────────────

export interface FakeRtdbOptions {
  log: OperationLog;
  tree?: Record<string, unknown>;
  /** Present ⇒ every read throws this value, i.e. "the RTDB source is disabled". */
  failure?: { value: unknown };
}

/**
 * An in-memory Realtime Database supporting exactly the read shape the collector
 * uses — `orderByKey().startAfter().limitToFirst().get()` at two levels — plus
 * every mutator, logged, so "report mode performs no RTDB write" is asserted over
 * the calls attempted.
 */
export function createFakeRtdb(options: FakeRtdbOptions): { ref(path: string): Record<string, unknown> } {
  const tree = options.tree ?? {};

  const resolveNode = (segments: string[]): unknown => {
    let node: unknown = tree;
    for (const segment of segments) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  };

  const makeQuery = (segments: string[], cursor: string | null, limit: number | null) => {
    const path = segments.join('/');
    const mutator = (method: string) => async () => {
      options.log.record({ store: 'rtdb', method, target: path, kind: 'write' });
    };
    const node: Record<string, unknown> = {
      orderByKey: () => makeQuery(segments, cursor, limit),
      startAfter: (value: string) => makeQuery(segments, String(value), limit),
      limitToFirst: (count: number) => makeQuery(segments, cursor, count),
      child: (key: string) => makeQuery([...segments, key], null, null),
      async get() {
        options.log.record({ store: 'rtdb', method: 'ref.get', target: path, kind: 'read' });
        if (options.failure) throw options.failure.value;
        const target = resolveNode(segments);
        let entries: [string, unknown][] =
          target !== null && typeof target === 'object'
            ? Object.entries(target as Record<string, unknown>).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
              )
            : [];
        if (cursor !== null) entries = entries.filter(([key]) => key > cursor);
        if (limit !== null) entries = entries.slice(0, limit);
        return {
          exists: () => entries.length > 0,
          val: () => (entries.length ? Object.fromEntries(entries) : target),
          forEach(callback: (child: { key: string; val: () => unknown }) => boolean | void) {
            for (const [key, value] of entries) {
              if (callback({ key, val: () => value }) === true) return true;
            }
            return false;
          },
        };
      },
      set: mutator('set'),
      update: mutator('update'),
      remove: mutator('remove'),
      transaction: mutator('transaction'),
      push: () => {
        options.log.record({ store: 'rtdb', method: 'push', target: path, kind: 'write' });
        return makeQuery([...segments, 'generated'], null, null);
      },
    };
    return node;
  };

  return { ref: (path: string) => makeQuery(String(path).split('/').filter(Boolean), null, null) };
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/** A stored Firebase download URL for `objectPath`, as every url field holds. */
export function downloadUrl(objectPath: string, token = 'tok-1', bucket = BUCKET_NAME): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

/** RFC 3339, as GCS metadata carries. */
export function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** A baseline sweep config; every field is explicit so a test overrides one knob. */
export function sweepConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantIds: ['acme'],
    mode: 'report',
    apply: false,
    graceDays: 7,
    quarantineRetentionDays: 7,
    pageSize: 1_000,
    maxQuarantinePerTenant: 1_000,
    maxReferences: 10_000,
    runnerId: 'test-runner',
    sweepId: 'sweep_test_0001',
    ...overrides,
  };
}
