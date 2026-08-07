import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitIndex } from '../src/lib/gitTracked.js';

describe('parseGitIndex', () => {
  it('returns null when .git/index is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-no-git-'));
    expect(await parseGitIndex(dir)).toBeNull();
  });

  it('returns null for non-DIRC magic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-bad-magic-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'index'), Buffer.from('NOPEnotanindex'));
    expect(await parseGitIndex(dir)).toBeNull();
  });

  it('parses a hand-crafted v2 index with one entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-v2-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    const path = 'package.json';
    const nameLen = path.length;
    const headerLen = 62;
    const totalBeforePad = headerLen + nameLen + 1;
    const padded = Math.ceil(totalBeforePad / 8) * 8;
    const entry = Buffer.alloc(padded);
    entry.writeUInt16BE(nameLen, 60);
    entry.write(path, headerLen);
    const fileHeader = Buffer.alloc(12);
    fileHeader.write('DIRC', 0);
    fileHeader.writeUInt32BE(2, 4);
    fileHeader.writeUInt32BE(1, 8);
    const buf = Buffer.concat([fileHeader, entry]);
    await writeFile(join(dir, '.git', 'index'), buf);
    const set = await parseGitIndex(dir);
    expect(set).not.toBeNull();
    expect(set.has('package.json')).toBe(true);
  });
});
