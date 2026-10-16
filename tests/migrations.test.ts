import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MIGRATIONS } from '../src/main/db';

// Databases record how many migrations they ran: editing or reordering a
// shipped migration breaks every existing install. Only append new ones, then
// add their fingerprints here.
const SHIPPED = ["2860cc433f8e","5be9f56bd8d1","05a8cc7ba677","d5b871fcc940","13fa3a6b4497","4fac6e163c97","cbb10e5405a5","7b1fb9e75176","d14be59e6938","78d71bb979a4","9b62294be058","108b9f9f85ee","40803a05964e","084510e5fe61","17bc9237c5be","3aec3458abb1","e56ac3d0219e"];

describe('database migrations', () => {
  it('are append-only', () => {
    const hashes = MIGRATIONS.map((m) => createHash('sha256').update(m).digest('hex').slice(0, 12));
    expect(hashes.slice(0, SHIPPED.length)).toEqual(SHIPPED);
  });
});
