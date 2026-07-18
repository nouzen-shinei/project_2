// In-memory expo-file-system mock: a Set of "existing" paths. Directories are
// stored with a trailing slash. readDirectoryAsync returns immediate children.
// Methods are jest.fn() so tests can assert call counts directly.
jest.mock('expo-file-system', () => {
  const paths = new Set<string>();
  return {
    __paths: paths,
    documentDirectory: 'file:///doc/',
    getInfoAsync: jest.fn(async (uri: string) => ({ exists: paths.has(uri), uri })),
    makeDirectoryAsync: jest.fn(async (uri: string) => {
      paths.add(uri.endsWith('/') ? uri : `${uri}/`);
    }),
    copyAsync: jest.fn(async ({ to }: { from: string; to: string }) => {
      paths.add(to);
    }),
    deleteAsync: jest.fn(async (uri: string) => {
      paths.delete(uri);
    }),
    readDirectoryAsync: jest.fn(async (dir: string) => {
      const d = dir.endsWith('/') ? dir : `${dir}/`;
      const out: string[] = [];
      for (const p of paths) {
        if (p.startsWith(d) && p.length > d.length) {
          const rest = p.slice(d.length);
          if (!rest.includes('/')) out.push(rest);
        }
      }
      return out;
    }),
  };
});

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } }));

import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import {
  isMediaStagingSupported,
  isStagedOutboxUri,
  stageOutboxMedia,
  removeOutboxMedia,
  sweepOutboxOrphans,
} from '../../lib/chatMediaStaging';

const FS = FileSystem as any;
const paths: Set<string> = FS.__paths;
const OUTBOX = 'file:///doc/chat-outbox/';

beforeEach(() => {
  paths.clear();
  jest.clearAllMocks();
  (Platform as any).OS = 'ios';
});

describe('isMediaStagingSupported', () => {
  it('is true on native with a document directory, false on web', () => {
    expect(isMediaStagingSupported()).toBe(true);
    (Platform as any).OS = 'web';
    expect(isMediaStagingSupported()).toBe(false);
  });
});

describe('stageOutboxMedia', () => {
  it('copies a local file into the outbox and returns the staged uri', async () => {
    const staged = await stageOutboxMedia('pm_1', 'file:///cache/sticker.png', 'png');
    expect(staged).toBe(`${OUTBOX}pm_1.png`);
    expect(paths.has(`${OUTBOX}pm_1.png`)).toBe(true);
    expect(isStagedOutboxUri(staged)).toBe(true);
  });

  it('sanitizes the id + extension into the filename', async () => {
    const staged = await stageOutboxMedia('pm/../weird id', 'content://x', 'JPEG');
    expect(staged).toBe(`${OUTBOX}pm____weird_id.jpeg`);
  });

  it('returns null for a remote (http) source — nothing to stage', async () => {
    expect(await stageOutboxMedia('pm_2', 'https://cdn.example.com/a.gif', 'gif')).toBeNull();
  });

  it('returns null for an empty source', async () => {
    expect(await stageOutboxMedia('pm_3', '   ')).toBeNull();
  });

  it('is idempotent: re-staging returns the existing file without re-copying', async () => {
    const first = await stageOutboxMedia('pm_4', 'file:///cache/a.webp', 'webp');
    expect(first).toBe(`${OUTBOX}pm_4.webp`);
    expect(FS.copyAsync).toHaveBeenCalledTimes(1);
    const second = await stageOutboxMedia('pm_4', 'file:///cache/a.webp', 'webp');
    expect(second).toBe(first);
    expect(FS.copyAsync).toHaveBeenCalledTimes(1); // no second copy
  });

  it('returns the uri as-is when it is already staged', async () => {
    const already = `${OUTBOX}pm_5.png`;
    expect(await stageOutboxMedia('pm_5', already, 'png')).toBe(already);
    expect(FS.copyAsync).not.toHaveBeenCalled();
  });

  it('is a no-op (null) on web', async () => {
    (Platform as any).OS = 'web';
    expect(await stageOutboxMedia('pm_6', 'file:///cache/a.png', 'png')).toBeNull();
    expect(FS.copyAsync).not.toHaveBeenCalled();
  });
});

describe('removeOutboxMedia', () => {
  it('deletes a staged file by its staged uri', async () => {
    const staged = (await stageOutboxMedia('pm_7', 'file:///cache/a.png', 'png'))!;
    expect(paths.has(staged)).toBe(true);
    await removeOutboxMedia(staged);
    expect(paths.has(staged)).toBe(false);
  });

  it('deletes a staged file by pending id + ext', async () => {
    await stageOutboxMedia('pm_8', 'file:///cache/a.png', 'png');
    expect(paths.has(`${OUTBOX}pm_8.png`)).toBe(true);
    await removeOutboxMedia('pm_8', 'png');
    expect(paths.has(`${OUTBOX}pm_8.png`)).toBe(false);
  });

  it('ignores a non-staged scheme uri (remote/content) safely', async () => {
    await removeOutboxMedia('https://cdn/a.gif');
    await removeOutboxMedia('content://media/1');
    expect(FS.deleteAsync).not.toHaveBeenCalled();
  });
});

describe('sweepOutboxOrphans', () => {
  it('deletes files not owned by an active id and keeps active ones', async () => {
    await stageOutboxMedia('pm_keep', 'file:///cache/a.png', 'png');
    await stageOutboxMedia('pm_orphan1', 'file:///cache/b.gif', 'gif');
    await stageOutboxMedia('pm_orphan2', 'file:///cache/c.webp', 'webp');

    await sweepOutboxOrphans(new Set(['pm_keep']));

    expect(paths.has(`${OUTBOX}pm_keep.png`)).toBe(true);
    expect(paths.has(`${OUTBOX}pm_orphan1.gif`)).toBe(false);
    expect(paths.has(`${OUTBOX}pm_orphan2.webp`)).toBe(false);
  });

  it('keeps per-file attachment staged files (id__index) owned by an active parent id', async () => {
    await stageOutboxMedia('pa_1__0', 'file:///cache/a.png', 'png');
    await stageOutboxMedia('pa_1__1', 'file:///cache/b.pdf', 'pdf');
    await stageOutboxMedia('pa_2__0', 'file:///cache/c.png', 'png');

    await sweepOutboxOrphans(new Set(['pa_1'])); // parent id only

    expect(paths.has(`${OUTBOX}pa_1__0.png`)).toBe(true);
    expect(paths.has(`${OUTBOX}pa_1__1.pdf`)).toBe(true);
    expect(paths.has(`${OUTBOX}pa_2__0.png`)).toBe(false);
  });

  it('deletes all staged files when there are no active ids', async () => {
    await stageOutboxMedia('pm_a', 'file:///cache/a.png', 'png');
    await stageOutboxMedia('pm_b', 'file:///cache/b.png', 'png');
    await sweepOutboxOrphans(new Set());
    expect(paths.has(`${OUTBOX}pm_a.png`)).toBe(false);
    expect(paths.has(`${OUTBOX}pm_b.png`)).toBe(false);
  });

  it('is a no-op on web', async () => {
    await stageOutboxMedia('pm_x', 'file:///cache/a.png', 'png'); // staged while native
    (Platform as any).OS = 'web';
    await sweepOutboxOrphans(new Set());
    expect(FS.readDirectoryAsync).not.toHaveBeenCalled();
  });
});
