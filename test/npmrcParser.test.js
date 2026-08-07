import { describe, it, expect } from 'vitest';
import { parseNpmrc, setNpmrcKey, setNpmrcArray } from '../src/lib/npmrcParser.js';

describe('parseNpmrc', () => {
  it('parses scalar key=value pairs with line numbers', () => {
    const ast = parseNpmrc('save-exact=true\nregistry=https://registry.npmjs.org/\n');
    expect(ast.scalars.get('save-exact')).toEqual({ value: 'true', line: 1 });
    expect(ast.scalars.get('registry')).toEqual({ value: 'https://registry.npmjs.org/', line: 2 });
  });

  it('tolerates surrounding whitespace and `=` spacing', () => {
    const ast = parseNpmrc('  save-exact = true  \n');
    expect(ast.scalars.get('save-exact')).toEqual({ value: 'true', line: 1 });
  });

  it('collects array entries with all line numbers', () => {
    const ast = parseNpmrc('only-built-dependencies[]=esbuild\nonly-built-dependencies[]=sharp\n');
    const arr = ast.arrays.get('only-built-dependencies');
    expect(arr.values).toEqual(['esbuild', 'sharp']);
    expect(arr.firstLine).toBe(1);
    expect(arr.lines).toEqual([1, 2]);
  });

  it('parses scoped auth keys', () => {
    const src = '//registry.npmjs.org/:_authToken=secret-token\n';
    const ast = parseNpmrc(src);
    expect(ast.scalars.get('//registry.npmjs.org/:_authToken'))
      .toEqual({ value: 'secret-token', line: 1 });
  });

  it('ignores comments and blank lines', () => {
    const ast = parseNpmrc('# hello\n;world\n\nkey=value\n');
    expect(ast.scalars.size).toBe(1);
    expect(ast.scalars.get('key')).toEqual({ value: 'value', line: 4 });
  });

  it('strips surrounding quotes', () => {
    const ast = parseNpmrc('key="quoted value"\n');
    expect(ast.scalars.get('key').value).toBe('quoted value');
  });

  it('reports malformed non-comment lines', () => {
    const ast = parseNpmrc('save-exact true\nregistry=https://registry.npmjs.org/\n');
    expect(ast.errors).toEqual([{ line: 1, message: 'expected key=value syntax' }]);
  });
});

describe('setNpmrcKey', () => {
  it('replaces an existing scalar in place', () => {
    const src = 'save-exact=false\nregistry=https://registry.npmjs.org/\n';
    expect(setNpmrcKey(src, 'save-exact', true))
      .toBe('save-exact=true\nregistry=https://registry.npmjs.org/\n');
  });

  it('appends a new key when absent', () => {
    const src = 'registry=https://registry.npmjs.org/\n';
    expect(setNpmrcKey(src, 'save-exact', true))
      .toBe('registry=https://registry.npmjs.org/\nsave-exact=true\n');
  });

  it('handles empty source', () => {
    expect(setNpmrcKey('', 'save-exact', true)).toBe('save-exact=true\n');
  });

  it('serialises booleans as true/false', () => {
    expect(setNpmrcKey('', 'ignore-scripts', false)).toBe('ignore-scripts=false\n');
  });
});

describe('setNpmrcArray', () => {
  it('replaces existing array entries in place', () => {
    const src = 'only-built-dependencies[]=old\nfoo=bar\n';
    const out = setNpmrcArray(src, 'only-built-dependencies', ['esbuild', 'sharp']);
    expect(out).toBe('only-built-dependencies[]=esbuild\nonly-built-dependencies[]=sharp\nfoo=bar\n');
  });

  it('appends a new array when absent', () => {
    const src = 'foo=bar\n';
    const out = setNpmrcArray(src, 'only-built-dependencies', ['esbuild']);
    expect(out).toBe('foo=bar\nonly-built-dependencies[]=esbuild\n');
  });

  it('emits empty array as no lines', () => {
    const src = 'only-built-dependencies[]=old\nfoo=bar\n';
    const out = setNpmrcArray(src, 'only-built-dependencies', []);
    expect(out).toBe('foo=bar\n');
  });
});
