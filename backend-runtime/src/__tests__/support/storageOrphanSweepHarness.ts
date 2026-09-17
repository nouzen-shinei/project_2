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
 *
 * ── Transactions are observed at the CALL SITE, not at commit ───────────────
 *
 * `createFakeFirestore` exposes `runTransaction` (storage-sweep-scale-hardening
 * task 2.1), and every `tx.get` / `tx.set` / `tx.update` / `tx.delete` appends to
 * the same log the instant it is invoked, with `kind: 'write'` for the three
 * mutators. That follows from the paragraph above rather than extending it: an
 * attempted write inside a transaction that later aborts is precisely "a mutation
 * that happened to be a no-op", so it must still fail an assertion stated over
 * the methods invoked. **The log records intent; `documents` records outcome.**
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

/** The snapshot shape both `doc().get()` and a query page hand back. */
export interface FakeDocSnapshot {
  id: string;
  ref: { path: string };
  exists: boolean;
  data(): DocData | undefined;
}

/** Anything with a document path: a `doc()` handle, or a real `DocumentReference`. */
export interface FakeDocumentRef {
  path: string;
}

/**
 * The transaction surface `runTransaction` hands its body. Deliberately exactly
 * the four methods `acquireRunLease`'s shape uses — `get`, `set`, `update`,
 * `delete` — and the three mutators are synchronous and chainable, as the real
 * SDK's are.
 */
export interface FakeTransaction {
  get(ref: FakeDocumentRef): Promise<FakeDocSnapshot>;
  set(ref: FakeDocumentRef, data: DocData, options?: { merge?: boolean }): FakeTransaction;
  update(ref: FakeDocumentRef, data: DocData): FakeTransaction;
  delete(ref: FakeDocumentRef): FakeTransaction;
}

/**
 * One EXECUTED query, recorded so the ordering fields are assertable directly
 * (Req 3.4, 11.9) rather than inferred from the documents that came back. Pushed
 * by `get()` before the configured failure check, so a page that failed is still
 * visible here.
 */
export interface FakeQueryRecord {
  collection: string;
  filters: { field: string; operator: string; value: unknown }[];
  /** The `orderBy` fields, in the order they were requested. `[]` when unordered. */
  orderBy: string[];
  orderByDirections: ('asc' | 'desc')[];
  /** `null` when the query asked for no limit. */
  limit: number | null;
  /** The cursor snapshot's document path, or `null` when there was no cursor. */
  startAfterPath: string | null;
}

export interface FakeFirestore {
  collection(name: string): Record<string, unknown>;
  doc(path: string): Record<string, unknown>;
  runTransaction<T>(body: (tx: FakeTransaction) => Promise<T>): Promise<T>;
  /** Raw document store, keyed by full path. */
  documents: Map<string, DocData>;
  read(path: string): DocData | undefined;
  /** Every query executed, in order. See `FakeQueryRecord`. */
  queries: FakeQueryRecord[];
}

/**
 * A queryable in-memory Firestore supporting `where('tenantId','==',t).get()`,
 * `doc().get()` and `set(data, { merge: true })`, with every write logged by full
 * document path — which is what lets Property 6 assert that report mode writes
 * nothing outside `storageMaintenanceJobs/`.
 *
 * Extended by storage-sweep-scale-hardening tasks 2.1 and 2.2 with
 * `runTransaction` and with `orderBy` / `limit` / `startAfter` on the query. Both
 * additions are strictly additive: a query that asks for none of the three
 * behaves exactly as it did before — same insertion order, every match, no slice
 * — because every existing suite reads that path.
 */
export function createFakeFirestore(options: FakeFirestoreOptions): FakeFirestore {
  const documents = new Map<string, DocData>();
  for (const [name, docs] of Object.entries(options.collections ?? {})) {
    for (const [id, data] of Object.entries(docs)) documents.set(`${name}/${id}`, { ...data });
  }
  const queries: FakeQueryRecord[] = [];

  const failIfConfigured = (name: string): void => {
    if (Object.prototype.hasOwnProperty.call(options.failures ?? {}, name)) {
      throw (options.failures as Record<string, unknown>)[name];
    }
  };

  /**
   * Every snapshot this fake ever minted. `startAfter` checks membership, which is
   * how a bare field value is told apart from a `QueryDocumentSnapshot` without
   * putting a marker property on the snapshot itself — the snapshot shape stays
   * byte-identical to the shipped one.
   */
  const snapshots = new WeakSet<object>();

  const snapshotFor = (path: string): FakeDocSnapshot => {
    const data = documents.get(path);
    const snapshot: FakeDocSnapshot = {
      id: path.slice(path.lastIndexOf('/') + 1),
      ref: { path },
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : data),
    };
    snapshots.add(snapshot);
    return snapshot;
  };

  const isSnapshot = (candidate: unknown): candidate is FakeDocSnapshot =>
    typeof candidate === 'object' && candidate !== null && snapshots.has(candidate);

  const refPath = (ref: unknown, method: string): string => {
    const path = (ref as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError(
        `FakeTransaction.${method} requires a document reference with a string path, received ${String(ref)}`
      );
    }
    return path;
  };

  /**
   * One document's ordering key, with the document path appended as the final
   * tie-break exactly as Firestore appends `__name__`.
   *
   * `__name__` resolves to the full document path, so ordering is lexicographic by
   * name — which is what makes "pages by document id" and therefore "visits every
   * document exactly once" a meaningful claim. Ordering by a data field is
   * supported so the fake does not silently accept a query it cannot serve, but
   * this spec exercises only `__name__` (Req 3.4).
   */
  const orderingKey = (path: string, orderings: { field: string }[]): unknown[] => {
    const data = documents.get(path);
    const key: unknown[] = orderings.map(({ field }) => (field === '__name__' ? path : data?.[field]));
    key.push(path);
    return key;
  };

  const compareOrderingKeys = (
    left: unknown[],
    right: unknown[],
    orderings: { direction: 'asc' | 'desc' }[]
  ): number => {
    for (let index = 0; index < left.length; index += 1) {
      // The implicit trailing `__name__` term follows the direction of the last
      // explicit `orderBy`, as Firestore's does.
      const direction = orderings[Math.min(index, orderings.length - 1)]?.direction ?? 'asc';
      const one = left[index];
      const other = right[index];
      let comparison = 0;
      if (one !== other) {
        comparison =
          typeof one === 'number' && typeof other === 'number'
            ? one < other
              ? -1
              : 1
            : String(one ?? '') < String(other ?? '')
              ? -1
              : String(one ?? '') > String(other ?? '')
                ? 1
                : 0;
      }
      if (comparison !== 0) return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
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
    /**
     * The ordering fields, recorded so Req 3.4 ("`__name__` and no other field")
     * and Req 11.9 are assertable from `db.queries` rather than inferred from the
     * documents that came back.
     */
    const orderings: { field: string; direction: 'asc' | 'desc' }[] = [];
    let limitCount: number | null = null;
    let cursorPath: string | null = null;

    const query: Record<string, unknown> = {
      where(field: string, operator: string, value: unknown) {
        filters.push([field, operator, value]);
        return query;
      },
      orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
        orderings.push({ field, direction });
        return query;
      },
      limit(count: number) {
        limitCount = count;
        return query;
      },
      /**
       * Req 3.3 — **a `QueryDocumentSnapshot`, never a bare field value**, and the
       * throw is the point rather than defensiveness.
       *
       * A value cursor over documents that all share one `tenantId` either returns
       * nothing or returns everything, and the failure that matters is the *skip*:
       * a skipped document is a reference not collected, which makes the object it
       * names an Orphan candidate. A regression to a value cursor must therefore
       * fail loudly here rather than pass quietly on a fixture whose field values
       * happen to be distinct.
       */
      startAfter(cursor: unknown) {
        if (!isSnapshot(cursor)) {
          throw new TypeError(
            `startAfter(...) requires a QueryDocumentSnapshot from a previous page of this fake, ` +
              `not a bare field value — received ${typeof cursor}: ${String(cursor)}`
          );
        }
        cursorPath = cursor.ref.path;
        return query;
      },
      async get() {
        // UNCHANGED, deliberately: same method name, same target, same kind and no
        // `detail`. Existing suites read this entry — one asserts `log.methods()`
        // equals exactly `['firestore.query.get']` — so the ordering metadata goes
        // to `db.queries` instead of into this entry.
        options.log.record({ store: 'firestore', method: 'query.get', target: name, kind: 'read' });
        queries.push({
          collection: name,
          filters: filters.map(([field, operator, value]) => ({ field, operator, value })),
          orderBy: orderings.map((ordering) => ordering.field),
          orderByDirections: orderings.map((ordering) => ordering.direction),
          limit: limitCount,
          startAfterPath: cursorPath,
        });
        failIfConfigured(name);
        const entries = Array.from(documents.entries())
          .filter(([path]) => path.startsWith(`${name}/`) && !path.slice(name.length + 1).includes('/'))
          .filter(([, data]) =>
            filters.every(([field, operator, value]) => operator === '==' && data?.[field] === value)
          );
        let docs = entries.map(([path]) => snapshotFor(path));

        // The unordered, unlimited, uncursored query takes NONE of this: insertion
        // order, every match, no slice — precisely what it did before task 2.2, so
        // every existing suite is unaffected.
        if (orderings.length > 0 || limitCount !== null || cursorPath !== null) {
          docs = docs
            .slice()
            .sort((left, right) =>
              compareOrderingKeys(
                orderingKey(left.ref.path, orderings),
                orderingKey(right.ref.path, orderings),
                orderings
              )
            );
          if (cursorPath !== null) {
            // Keyset, by document name: the cursor is resolved from its PATH, so it
            // stays meaningful even if the cursor document has since been deleted —
            // the same stability the bucket fake's name cursor has.
            const cursorKey = orderingKey(cursorPath, orderings);
            docs = docs.filter(
              (doc) => compareOrderingKeys(orderingKey(doc.ref.path, orderings), cursorKey, orderings) > 0
            );
          }
          if (limitCount !== null) docs = docs.slice(0, Math.max(0, Math.trunc(limitCount)));
        }

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

  /**
   * ── `runTransaction` (spec task 2.1, Reqs 6.7, 11.12) ──────────────────────
   *
   * Three properties, each deliberate:
   *
   * 1. **Every `tx.get`, `tx.set`, `tx.update` and `tx.delete` is logged at the
   *    CALL SITE — not at commit** — with the full document path and, for the
   *    three mutators, `kind: 'write'`. The parent spec's Property 6 is stated
   *    over the *methods invoked*, so a mutation that turned out to be a no-op
   *    must still fail it, and an attempted write inside a transaction that later
   *    aborts is exactly such a case. The log records **intent**; `documents`
   *    records **outcome**.
   * 2. **Writes are buffered and applied at commit**, matching the real SDK, so a
   *    body that reads its own write sees the pre-transaction value.
   * 3. **No retry.** The real SDK retries on contention; this fake runs the body
   *    exactly once, because a retrying fake hides a non-idempotent transaction
   *    body, and because the Run_Lease's correctness must not depend on a retry.
   *    A body that throws propagates on the first attempt, with nothing applied.
   *
   * ── What this buys, with no test edited ───────────────────────────────────
   *
   * The parent's `storageOrphanSweep.reportNoMutation.property.test.ts` becomes
   * strictly **stronger with no edit at all**. Its `foreignWrites` filter is
   * `log.writes().filter((e) => e.store !== 'firestore' || !e.target.startsWith('storageMaintenanceJobs/'))`
   * — i.e. it already selects every `kind: 'write'` whose target lies outside
   * `storageMaintenanceJobs/`. So the moment `tx.set` is logged as a write, a
   * lease written to `jobLeases/` inside a transaction fails that assertion
   * automatically, and the file keeps its
   * `// Feature: storage-orphan-cleanup, Property 6:` tag (Req 11.5) while
   * satisfying Req 11.12.
   */
  const runTransaction = async <T>(body: (tx: FakeTransaction) => Promise<T>): Promise<T> => {
    type BufferedWrite =
      | { kind: 'set'; path: string; data: DocData; merge: boolean }
      | { kind: 'update'; path: string; data: DocData }
      | { kind: 'delete'; path: string };

    const buffered: BufferedWrite[] = [];

    const tx: FakeTransaction = {
      async get(ref) {
        const path = refPath(ref, 'get');
        options.log.record({ store: 'firestore', method: 'tx.get', target: path, kind: 'read' });
        failIfConfigured(path.slice(0, path.indexOf('/')));
        // The pre-transaction value: buffered writes are not visible to a read,
        // exactly as in the real SDK.
        return snapshotFor(path);
      },
      set(ref, data, setOptions) {
        const path = refPath(ref, 'set');
        options.log.record({ store: 'firestore', method: 'tx.set', target: path, kind: 'write' });
        buffered.push({ kind: 'set', path, data: { ...data }, merge: setOptions?.merge === true });
        return tx;
      },
      update(ref, data) {
        const path = refPath(ref, 'update');
        options.log.record({ store: 'firestore', method: 'tx.update', target: path, kind: 'write' });
        buffered.push({ kind: 'update', path, data: { ...data } });
        return tx;
      },
      delete(ref) {
        const path = refPath(ref, 'delete');
        options.log.record({ store: 'firestore', method: 'tx.delete', target: path, kind: 'write' });
        buffered.push({ kind: 'delete', path });
        return tx;
      },
    };

    // Exactly once. See property 3 above.
    const result = await body(tx);

    // Commit. Every configured write failure is checked BEFORE anything is
    // applied, so a rejected commit leaves the store exactly as the transaction
    // found it — atomic, as the real SDK is. The intent is already in the log.
    for (const write of buffered) {
      if (Object.prototype.hasOwnProperty.call(options.writeFailures ?? {}, write.path)) {
        throw (options.writeFailures as Record<string, unknown>)[write.path];
      }
    }
    for (const write of buffered) {
      if (write.kind === 'delete') {
        documents.delete(write.path);
        continue;
      }
      // `update` merges, matching this fake's own `doc.update` rather than the real
      // SDK's precondition that the document exist; the lease uses `set`/`delete`.
      const existing = write.kind === 'update' || write.merge ? (documents.get(write.path) ?? {}) : {};
      documents.set(write.path, { ...existing, ...write.data });
    }

    return result;
  };

  return {
    collection,
    doc: (path: string) => docHandle(path),
    runTransaction,
    documents,
    read: (path: string) => documents.get(path),
    queries,
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
