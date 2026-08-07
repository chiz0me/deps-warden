import { describe, it, expect } from 'vitest';
import { parsePkgJson, setTopLevelKey, setNestedKey } from '../src/lib/pkgJsonParser.js';

describe('parsePkgJson', () => {
  it('parses raw and tracks top-level key lines', () => {
    const src = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    const ast = parsePkgJson(src);
    expect(ast.raw).toEqual({ name: 'x', version: '1.0.0' });
    expect(ast.topLevelLines.get('name')).toBe(2);
    expect(ast.topLevelLines.get('version')).toBe(3);
    expect(ast.indent).toBe('  ');
  });

  it('infers 4-space indent', () => {
    const src = '{\n    "name": "x"\n}\n';
    expect(parsePkgJson(src).indent).toBe('    ');
  });
});

describe('setTopLevelKey', () => {
  it('replaces an existing string value in place', () => {
    const src = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    const out = setTopLevelKey(src, 'name', 'y');
    expect(out).toBe('{\n  "name": "y",\n  "version": "1.0.0"\n}\n');
  });

  it('replaces an existing object value in place', () => {
    const src = '{\n  "name": "x",\n  "engines": {\n    "node": ">=18"\n  }\n}\n';
    const out = setTopLevelKey(src, 'engines', { node: '>=20.0.0' });
    expect(out).toContain('"engines": {\n    "node": ">=20.0.0"\n  }');
  });

  it('appends a new key when absent', () => {
    const src = '{\n  "name": "x"\n}\n';
    const out = setTopLevelKey(src, 'version', '1.0.0');
    expect(out).toBe('{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
  });

  it('appends to empty object', () => {
    const src = '{}\n';
    const out = setTopLevelKey(src, 'name', 'x');
    expect(out).toBe('{\n  "name": "x"\n}\n');
  });
});

describe('setNestedKey', () => {
  it('sets a 2-level path, round-tripping', () => {
    const src = '{\n  "name": "x"\n}\n';
    const out = setNestedKey(src, ['engines', 'node'], '>=20.0.0');
    const parsed = JSON.parse(out);
    expect(parsed.engines.node).toBe('>=20.0.0');
  });
});
