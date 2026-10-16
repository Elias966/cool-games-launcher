import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MIGRATIONS, openDb } from '../src/main/db';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Databases record how many migrations they ran: editing or reordering a
// shipped migration breaks every existing install. Only append new ones, then
// add their fingerprints here.
const SHIPPED = ["2860cc433f8e","5be9f56bd8d1","05a8cc7ba677","d5b871fcc940","13fa3a6b4497","4fac6e163c97","cbb10e5405a5","7b1fb9e75176","d14be59e6938","78d71bb979a4","9b62294be058","108b9f9f85ee","40803a05964e","084510e5fe61","17bc9237c5be","3aec3458abb1","55a768acabb0","afa71c57e4ab"];

describe('database migrations', () => {
  it('are append-only', () => {
    const hashes = MIGRATIONS.map((m) => createHash('sha256').update(typeof m === 'string' ? m : m.id).digest('hex').slice(0, 12));
    expect(hashes.slice(0, SHIPPED.length)).toEqual(SHIPPED);
  });
});

describe('cover filter columns on upgrade', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'cgl-mig-')), 'launcher.db');
  // Builds a database as an earlier build left it: all migrations up to `upTo`, the last one replaced.
  const asLeftBy = (file: string, lastSql: string) => {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (0)');
    for (const m of MIGRATIONS.slice(0, 16)) typeof m === 'string' ? db.exec(m) : m.run(db);
    db.exec(lastSql);
    db.exec('UPDATE schema_version SET version = 17');
    db.close();
  };
  const columns = (db: ReturnType<typeof openDb>) => (db.prepare('PRAGMA table_info(catalog)').all() as Array<{ name: string }>).map((c) => c.name);

  it('adds cover_score after the build that added cover_woman', () => {
    const file = tmp();
    asLeftBy(file, 'ALTER TABLE catalog ADD COLUMN cover_woman INTEGER;');
    const db = openDb(file);
    expect(columns(db)).toEqual(expect.arrayContaining(['cover_woman', 'cover_score']));
    db.close();
  });
  it('does not fail after the build that added cover_score in its place', () => {
    const file = tmp();
    asLeftBy(file, 'ALTER TABLE catalog ADD COLUMN cover_score REAL;');
    const db = openDb(file);
    expect(columns(db)).toContain('cover_score');
    db.close();
  });
  it('creates both on a fresh database', () => {
    const db = openDb(tmp());
    expect(columns(db)).toEqual(expect.arrayContaining(['cover_woman', 'cover_score']));
    db.close();
  });
});
