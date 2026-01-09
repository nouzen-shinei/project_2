import * as admin from 'firebase-admin';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Writable } from 'node:stream';
import { ensureFirebase } from '../firebaseAdmin';

const EXPORT_SCHEMA_VERSION = '2025.12.03-preview';
const DEFAULT_CHUNK_SIZE = 500;
const MAX_CHUNK_SIZE = 2000;
const MIN_CHUNK_SIZE = 50;

export const DEFAULT_TENANT_EXPORT_COLLECTIONS = [
  'students',
  'fees',
  'attendance',
  'deviceTracking',
  'quotes',
  'device_actions',
  'device_bans',
] as const;

export type TenantExportCollection = (typeof DEFAULT_TENANT_EXPORT_COLLECTIONS)[number];

export interface TenantExportStreamOptions {
  tenantId: string;
  writer: Writable;
  exportedBy?: string | null;
  includeCollections?: string[];
  chunkSize?: number;
  signal?: AbortSignal;
  startedAt?: string;
}

export interface TenantExportStreamResult {
  datasetCounts: Record<string, number>;
  totalDocuments: number;
}

export class TenantExportAbortedError extends Error {
  constructor() {
    super('tenant_export_aborted');
    this.name = 'TenantExportAbortedError';
  }
}

type QueryFactory = (lastDoc: QueryDocumentSnapshot | null) => admin.firestore.Query;

function clampChunkSize(value?: number): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, Math.floor(value)));
}

function resolveCollections(list?: string[]): string[] {
  if (!Array.isArray(list) || list.length === 0) {
    return [...DEFAULT_TENANT_EXPORT_COLLECTIONS];
  }
  const unique = new Set<string>();
  list.forEach((entry) => {
    if (typeof entry !== 'string') {
      return;
    }
    const normalized = entry.trim();
    if (!normalized) {
      return;
    }
    unique.add(normalized);
  });
  return Array.from(unique.values());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TenantExportAbortedError();
  }
}

function waitForDrain(stream: Writable, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      cleanup();
      reject(new TenantExportAbortedError());
    };

    const cleanup = () => {
      stream.removeListener('drain', handleDrain);
      stream.removeListener('error', handleError);
      signal?.removeEventListener('abort', handleAbort);
    };

    stream.once('drain', handleDrain);
    stream.once('error', handleError);
    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }
  });
}

async function writeChunk(stream: Writable, chunk: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (stream.write(chunk, 'utf8')) {
    return;
  }
  await waitForDrain(stream, signal);
}

async function streamCollectionDocuments(options: {
  db: admin.firestore.Firestore;
  tenantId: string;
  collectionName: string;
  writer: Writable;
  chunkSize: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { db, tenantId, collectionName, writer, chunkSize, signal } = options;
  const docIdField = admin.firestore.FieldPath.documentId();
  let total = 0;
  let wroteEntry = false;

  const buildQuery: QueryFactory = (lastDoc) => {
    let query: admin.firestore.Query = db
      .collection(collectionName)
      .where('tenantId', '==', tenantId)
      .orderBy(docIdField)
      .limit(chunkSize);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }
    return query;
  };

  let cursor: QueryDocumentSnapshot | null = null;
  while (true) {
    throwIfAborted(signal);
    const snapshot = await buildQuery(cursor).get();
    if (snapshot.empty) {
      break;
    }

    for (const docSnap of snapshot.docs) {
      throwIfAborted(signal);
      const payload = JSON.stringify({ id: docSnap.id, ...docSnap.data() });
      if (wroteEntry) {
        await writeChunk(writer, ',', signal);
      } else {
        wroteEntry = true;
      }
      await writeChunk(writer, payload, signal);
      total += 1;
    }

    cursor = snapshot.docs[snapshot.docs.length - 1] ?? null;
  }

  return total;
}

export async function streamTenantExport(options: TenantExportStreamOptions): Promise<TenantExportStreamResult> {
  const tenantId = options.tenantId.trim();
  if (!tenantId) {
    throw new Error('tenantId_required');
  }
  ensureFirebase();
  const db = admin.firestore();
  const chunkSize = clampChunkSize(options.chunkSize);
  const collections = resolveCollections(options.includeCollections);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const datasetCounts: Record<string, number> = {};
  let totalDocuments = 0;

  const meta = {
    version: EXPORT_SCHEMA_VERSION,
    generatedAt: startedAt,
    tenantId,
    exportedBy: options.exportedBy ?? null,
    collections,
    format: 'json',
    compression: 'gzip',
  };

  await writeChunk(options.writer, '{\n', options.signal);
  await writeChunk(options.writer, `"meta":${JSON.stringify(meta)}`, options.signal);

  for (const collectionName of collections) {
    await writeChunk(options.writer, `,\n"${collectionName}":[`, options.signal);
    const count = await streamCollectionDocuments({
      db,
      tenantId,
      collectionName,
      writer: options.writer,
      chunkSize,
      signal: options.signal,
    });
    datasetCounts[collectionName] = count;
    totalDocuments += count;
    await writeChunk(options.writer, ']', options.signal);
  }

  const statistics = {
    datasetCounts,
    totalDocuments,
  };
  await writeChunk(options.writer, `,\n"statistics":${JSON.stringify(statistics)}\n}`, options.signal);

  return { datasetCounts, totalDocuments };
}
