import { describe, it, expect } from 'vitest';
import { parseYaml, getYamlValue, setYamlKey } from '../src/lib/yamlParser.js';

describe('yamlParser', () => {
  it('reads a top-level scalar with line', () => {
    const src = 'strictDepBuilds: true\n';
    const doc = parseYaml(src);
    const hit = getYamlValue(doc, ['strictDepBuilds']);
    expect(hit.value).toBe(true);
    expect(hit.line).toBe(1);
  });

  it('reads a top-level map', () => {
    const src = 'allowBuilds:\n  esbuild: true\n  sharp: false\n';
    const doc = parseYaml(src);
    const hit = getYamlValue(doc, ['allowBuilds']);
    expect(hit.value).toEqual({ esbuild: true, sharp: false });
  });

  it('returns null for missing keys', () => {
    const doc = parseYaml('foo: 1\n');
    expect(getYamlValue(doc, ['missing'])).toBeNull();
  });

  it('sets a scalar key, creating the file when empty', () => {
    const out = setYamlKey('', ['strictDepBuilds'], true);
    expect(out).toMatch(/strictDepBuilds:\s*true/);
  });

  it('sets a map value', () => {
    const out = setYamlKey('foo: 1\n', ['allowBuilds'], { esbuild: true, sharp: false });
    expect(out).toMatch(/allowBuilds:/);
    expect(out).toMatch(/esbuild/);
    expect(out).toMatch(/sharp/);
  });

  it('updates an existing key', () => {
    const out = setYamlKey('strictDepBuilds: false\n', ['strictDepBuilds'], true);
    expect(out).toMatch(/strictDepBuilds:\s*true/);
    expect(out).not.toMatch(/false/);
  });
});
