/**
 * Smoke test for the `devices` / `tenantIndex` Firestore index declaration
 * (device-tenant-index Task 10.4, Requirement 5.1).
 *
 * Asserts the workspace-root `firestore.indexes.json` (the file Firebase
 * actually deploys — read verbatim, never inlined) declares a `fieldOverrides`
 * entry that makes the scoped listing query servable:
 *
 *     db.collectionGroup('devices').where('tenantIndex', 'array-contains', t)
 *
 * A collection-group `array-contains` query requires a `fieldOverrides` entry
 * on `devices` / `tenantIndex` exposing `CONTAINS` for BOTH the `COLLECTION`
 * and `COLLECTION_GROUP` query scopes. The `COLLECTION_GROUP` + `CONTAINS`
 * entry is the one that makes the cross-owner collection-group query work; the
 * `COLLECTION` entry keeps the same field queryable within a single owner's
 * subcollection. Both must be present.
 *
 * The file is parsed from disk so the test fails if the declaration is removed,
 * renamed, or the JSON becomes invalid.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// backend-runtime/src/__tests__ -> repo root is three levels up.
const INDEXES_PATH = resolve(__dirname, '../../../firestore.indexes.json');

interface FieldOverrideIndex {
  arrayConfig?: string;
  order?: string;
  queryScope?: string;
}

interface FieldOverride {
  collectionGroup?: string;
  fieldPath?: string;
  ttl?: boolean;
  indexes?: FieldOverrideIndex[];
}

interface IndexesFile {
  indexes?: unknown[];
  fieldOverrides?: FieldOverride[];
}

describe('firestore.indexes.json — devices/tenantIndex collection-group array-contains override (Req 5.1)', () => {
  let parsed: IndexesFile;

  beforeAll(() => {
    const raw = readFileSync(INDEXES_PATH, 'utf8');
    // Throws (failing the test) if the file is not valid JSON.
    parsed = JSON.parse(raw) as IndexesFile;
  });

  it('has a fieldOverrides array', () => {
    expect(Array.isArray(parsed.fieldOverrides)).toBe(true);
  });

  it('declares exactly one devices/tenantIndex field override', () => {
    const matches = (parsed.fieldOverrides ?? []).filter(
      (o) => o.collectionGroup === 'devices' && o.fieldPath === 'tenantIndex',
    );
    expect(matches).toHaveLength(1);
  });

  it('exposes CONTAINS for BOTH COLLECTION and COLLECTION_GROUP query scopes', () => {
    const override = (parsed.fieldOverrides ?? []).find(
      (o) => o.collectionGroup === 'devices' && o.fieldPath === 'tenantIndex',
    );
    expect(override).toBeDefined();

    const indexes = override?.indexes ?? [];

    // CONTAINS + COLLECTION (single-owner subcollection array-contains).
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ arrayConfig: 'CONTAINS', queryScope: 'COLLECTION' }),
      ]),
    );

    // CONTAINS + COLLECTION_GROUP (the cross-owner query the scoped listing issues).
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ arrayConfig: 'CONTAINS', queryScope: 'COLLECTION_GROUP' }),
      ]),
    );
  });

  it('does not clobber the pre-existing devices/fallbackFingerprintHash override', () => {
    const fallback = (parsed.fieldOverrides ?? []).find(
      (o) => o.collectionGroup === 'devices' && o.fieldPath === 'fallbackFingerprintHash',
    );
    expect(fallback).toBeDefined();
  });
});
