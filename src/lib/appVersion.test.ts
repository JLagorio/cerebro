import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './appVersion';

const REPO = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

describe('APP_VERSION (M59.1)', () => {
  it("is package.json's version, and tauri.conf.json and Cargo.toml agree", () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string };
    const cargo = /\[package\][^[]*?\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.toml'));
    expect(APP_VERSION).toBe(pkg.version);
    expect(tauri.version).toBe(APP_VERSION);
    expect(cargo?.[1]).toBe(APP_VERSION);
  });
});
