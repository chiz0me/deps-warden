import { describe, it, expect } from 'vitest';
import { unifiedDiff } from '../src/lib/diff.js';

describe('unifiedDiff', () => {
  it('returns null for identical inputs', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'f')).toBeNull();
  });

  it('produces a unified diff with hunk header', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f');
    expect(out).toContain('--- a/f');
    expect(out).toContain('+++ b/f');
    expect(out).toContain('@@');
    expect(out).toContain('-b');
    expect(out).toContain('+B');
  });

  it('handles pure insertion', () => {
    const out = unifiedDiff('a\n', 'a\nb\n', 'f');
    expect(out).toContain('+b');
  });

  it('handles pure deletion', () => {
    const out = unifiedDiff('a\nb\n', 'a\n', 'f');
    expect(out).toContain('-b');
  });
});
