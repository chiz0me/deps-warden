/**
 * Parse `.git/index` directly to produce the set of tracked paths.
 *
 * Index format reference: https://git-scm.com/docs/index-format
 * Supports v2, v3, and v4 entries. v4 uses prefix-compressed paths where
 * each entry stores a strip length (variable-length encoded) and a suffix
 * to append to the previous path. When parsing fails, returns null so
 * callers can degrade gracefully (rules emit SKIP).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {string} cwd
 * @returns {Promise<Set<string>|null>}
 */
export async function parseGitIndex(cwd) {
  let buf;
  try {
    buf = await readFile(join(cwd, '.git', 'index'));
  } catch {
    return null;
  }
  if (buf.length < 12) return null;
  if (buf.slice(0, 4).toString() !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = buf.readUInt32BE(8);
  const out = new Set();
  let off = 12;
  let prev = '';
  for (let i = 0; i < count; i += 1) {
    if (off + 62 > buf.length) return null;
    const flags = buf.readUInt16BE(off + 60);
    const nameLenField = flags & 0xfff;
    const extended = version >= 3 && (flags & 0x4000) !== 0;
    const headerLen = extended ? 64 : 62;
    let path;
    if (version === 4) {
      // Variable-length strip-length + NUL-terminated suffix; no padding.
      const decoded = decodeVarInt(buf, off + headerLen);
      if (decoded === null) return null;
      const suffixStart = off + headerLen + decoded.bytes;
      const nullIdx = buf.indexOf(0, suffixStart);
      if (nullIdx === -1) return null;
      const suffix = buf.slice(suffixStart, nullIdx).toString('utf8');
      const stripLen = decoded.value;
      if (stripLen > prev.length) return null;
      path = prev.slice(0, prev.length - stripLen) + suffix;
      off = nullIdx + 1;
    } else {
      const nameStart = off + headerLen;
      let nameEnd;
      if (nameLenField < 0xfff) {
        nameEnd = nameStart + nameLenField;
      } else {
        nameEnd = buf.indexOf(0, nameStart);
        if (nameEnd === -1) return null;
      }
      if (nameEnd > buf.length) return null;
      path = buf.slice(nameStart, nameEnd).toString('utf8');
      const rawLen = (nameEnd - off) + 1;
      const padded = Math.ceil(rawLen / 8) * 8;
      off += padded;
    }
    out.add(path);
    prev = path;
  }
  return out;
}

/**
 * Decode git's offset-style varint.
 *
 *   value = (byte0 & 0x7f)
 *   while byte has high bit:
 *     value += 1
 *     value = (value << 7) | (nextByte & 0x7f)
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {{value: number, bytes: number}|null}
 */
function decodeVarInt(buf, off) {
  if (off >= buf.length) return null;
  let bytes = 0;
  let byte = buf[off + bytes];
  bytes += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (off + bytes >= buf.length) return null;
    value += 1;
    byte = buf[off + bytes];
    bytes += 1;
    value = (value << 7) | (byte & 0x7f);
  }
  return { value, bytes };
}
