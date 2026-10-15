/**
 * The app's version, from package.json (M59.1). Settings and the status bar
 * both read it; they used to spell two different literals (0.1.0 and
 * 2026.7.29). A named import, so the bundle carries the one field, not the
 * manifest. appVersion.test.ts holds package.json, tauri.conf.json and
 * Cargo.toml to one version.
 */
export { version as APP_VERSION } from '../../package.json';
