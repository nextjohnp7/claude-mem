import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { applyPendingRestore } from '../../src/services/backup/restore-swap.js';
import { readLastRestoreResult, readPendingRestore, resolveSnapshotInside, stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { paths } from '../../src/shared/paths.js';
import { ChromaSyncState } from '../../src/services/sync/ChromaSyncState.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  for (const file of [paths.pendingRestore(), paths.lastRestore()]) {
    if (existsSync(file)) rmSync(file);
  }
});

function makeDb(path: string, note: string): void {
  const db = new Database(path);
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  db.run('INSERT INTO observations (note) VALUES (?)', [note]);
  db.close();
}

function readNote(path: string): string {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    return (db.query('SELECT note FROM observations').get() as { note: string }).note;
  } finally {
    db.close();
  }
}

function setup(): { dbPath: string; backupsDir: string; snapshotName: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'pending-restore-test-'));
  const backupsDir = join(tempRoot, 'backups', 'auto');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = join(tempRoot, 'claude-mem.db');
  makeDb(dbPath, 'live');
  const snapshotName = 'claude-mem-2026-10-01T00-00-00-000Z.db';
  makeDb(join(backupsDir, snapshotName), 'snapshot');
  return { dbPath, backupsDir, snapshotName };
}

describe('resolveSnapshotInside', () => {
  it('accepts a snapshot name inside the backups dir', () => {
    // path.resolve (not join): on Windows it also anchors the current drive,
    // matching what resolveSnapshotInside returns.
    expect(resolveSnapshotInside('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db'))
      .toBe(resolve('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db'));
  });

  it('rejects traversal, absolute paths, nested paths and non-snapshot names', () => {
    expect(resolveSnapshotInside('/data/backups/auto', '../../etc/passwd')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', '/etc/claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'nested/claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'notes.txt')).toBeNull();
  });

  it('rejects Windows-style traversal, drive-absolute paths and snapshot sidecar names', () => {
    expect(resolveSnapshotInside('/data/backups/auto', '..\\..\\claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('C:\\data\\backups\\auto', 'C:\\elsewhere\\claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db-wal')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db.partial')).toBeNull();
  });
});

describe('restore marker files', () => {
  it('stages and reads back a marker with its snapshot name and request time', () => {
    mkdirSync(join(paths.pendingRestore(), '..'), { recursive: true });
    stagePendingRestore('claude-mem-2026-10-01T00-00-00-000Z.db');

    const pending = readPendingRestore();

    expect(pending?.snapshot).toBe('claude-mem-2026-10-01T00-00-00-000Z.db');
    expect(pending?.requestedAt).toBeGreaterThan(0);
  });

  it('throws for a well-formed marker that has no snapshot name', () => {
    mkdirSync(join(paths.pendingRestore(), '..'), { recursive: true });
    writeFileSync(paths.pendingRestore(), '{}');

    expect(() => readPendingRestore()).toThrow('no snapshot name');
  });
});

describe('applyPendingRestore', () => {
  it('does nothing when no restore is staged', async () => {
    const { dbPath, backupsDir } = setup();
    expect(await applyPendingRestore(dbPath, backupsDir)).toBeNull();
    expect(readNote(dbPath)).toBe('live');
  });

  it('applies a staged restore once, clears the marker and records the outcome', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    stagePendingRestore(snapshotName);

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(true);
    expect(readNote(dbPath)).toBe('snapshot');
    expect(readNote(result!.preRestoreCopy!)).toBe('live');
    expect(result!.preRestoreCopy!.startsWith(backupsDir)).toBe(true);
    expect(existsSync(paths.pendingRestore())).toBe(false);
    expect(readLastRestoreResult()).toEqual(result);
    // A second boot finds nothing to do.
    expect(await applyPendingRestore(dbPath, backupsDir)).toBeNull();
  });

  it('flags the semantic index for a rebuild after a successful restore', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    ChromaSyncState.resetCacheForTests();
    ChromaSyncState.replace('restore-test-project', { observations: 40, summaries: 4, prompts: 9 });
    stagePendingRestore(snapshotName);

    await applyPendingRestore(dbPath, backupsDir);

    ChromaSyncState.resetCacheForTests();
    expect(ChromaSyncState.isRebuildPending('restore-test-project')).toBe(true);
  });

  it('records a failure, clears the marker and leaves the database unchanged', async () => {
    const { dbPath, backupsDir } = setup();
    stagePendingRestore('claude-mem-2099-01-01T00-00-00-000Z.db');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('snapshot not found');
    expect(readNote(dbPath)).toBe('live');
    expect(existsSync(paths.pendingRestore())).toBe(false);
  });

  it('refuses a marker that points outside the backups dir', async () => {
    const { dbPath, backupsDir } = setup();
    stagePendingRestore('../../claude-mem.db');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('outside the backups directory');
    expect(readNote(dbPath)).toBe('live');
  });

  it('clears and reports an unreadable marker instead of failing every boot', async () => {
    const { dbPath, backupsDir } = setup();
    mkdirSync(join(paths.pendingRestore(), '..'), { recursive: true });
    writeFileSync(paths.pendingRestore(), '{not json');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(existsSync(paths.pendingRestore())).toBe(false);
    expect(readNote(dbPath)).toBe('live');
  });

  it('keeps the marker in place until the swap has succeeded (crash-safe ordering)', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    stagePendingRestore(snapshotName);

    let markerPresentDuringSwap: boolean | null = null;
    const result = await applyPendingRestore(dbPath, backupsDir, {
      swap: async () => {
        markerPresentDuringSwap = existsSync(paths.pendingRestore());
        // No real swap: this test only pins the ordering, the live db stays.
        return { preRestoreCopy: null };
      },
    });

    expect(result?.ok).toBe(true);
    expect(markerPresentDuringSwap).toBe(true);
    expect(existsSync(paths.pendingRestore())).toBe(false);
  });

  it('clears the marker and records the failure when the swap itself fails', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    stagePendingRestore(snapshotName);

    const result = await applyPendingRestore(dbPath, backupsDir, {
      swap: async () => { throw new Error('boom mid-swap'); },
    });

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('boom mid-swap');
    expect(existsSync(paths.pendingRestore())).toBe(false);
    expect(readNote(dbPath)).toBe('live');
    // The failure was recorded, and the next boot finds nothing to retry.
    expect(readLastRestoreResult()?.error).toContain('boom mid-swap');
    expect(await applyPendingRestore(dbPath, backupsDir)).toBeNull();
  });

  it('restores into a data dir that has no live database yet', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pending-restore-test-'));
    const backupsDir = join(tempRoot, 'backups', 'auto');
    mkdirSync(backupsDir, { recursive: true });
    const dbPath = join(tempRoot, 'claude-mem.db'); // deliberately not created
    const snapshotName = 'claude-mem-2026-10-01T00-00-00-000Z.db';
    makeDb(join(backupsDir, snapshotName), 'snapshot');
    stagePendingRestore(snapshotName);

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(true);
    expect(result?.preRestoreCopy).toBeNull();
    expect(readNote(dbPath)).toBe('snapshot');
    expect(existsSync(paths.pendingRestore())).toBe(false);
  });
});
