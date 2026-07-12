import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACT_WINDOW_MIN_HEIGHT,
  COMPACT_WINDOW_MIN_WIDTH,
  WINDOW_BACKGROUND,
  launchBackgroundColor,
  mainWindowOptions,
  popoutWindowOptions,
} from './windowConfig.js';

test('uses an OS-theme-appropriate launch background', () => {
  assert.equal(launchBackgroundColor(true), WINDOW_BACKGROUND.dark);
  assert.equal(launchBackgroundColor(false), WINDOW_BACKGROUND.light);
});

test('uses the renderer compact layout floor for main and popout windows', () => {
  const context = { platform: 'linux' as const, shouldUseDarkColors: false };

  for (const options of [mainWindowOptions('/preload.mjs', context), popoutWindowOptions('/preload.mjs', context)]) {
    assert.equal(options.minWidth, COMPACT_WINDOW_MIN_WIDTH);
    assert.equal(options.minHeight, COMPACT_WINDOW_MIN_HEIGHT);
    assert.equal(options.backgroundColor, WINDOW_BACKGROUND.light);
  }
});

test('uses inset macOS chrome and native Windows/Linux title bars', () => {
  assert.equal(
    mainWindowOptions('/preload.mjs', { platform: 'darwin', shouldUseDarkColors: true }).titleBarStyle,
    'hiddenInset',
  );
  assert.equal(
    mainWindowOptions('/preload.mjs', { platform: 'win32', shouldUseDarkColors: true }).titleBarStyle,
    'default',
  );
  assert.equal(
    mainWindowOptions('/preload.mjs', { platform: 'linux', shouldUseDarkColors: true }).titleBarStyle,
    'default',
  );
});

test('keeps the desktop security settings on every window type', () => {
  const context = { platform: 'darwin' as const, shouldUseDarkColors: true };

  for (const options of [mainWindowOptions('/preload.mjs', context), popoutWindowOptions('/preload.mjs', context)]) {
    assert.equal(options.webPreferences?.contextIsolation, true);
    assert.equal(options.webPreferences?.nodeIntegration, false);
    assert.equal(options.webPreferences?.sandbox, false);
    assert.equal(options.webPreferences?.preload, '/preload.mjs');
  }
});
