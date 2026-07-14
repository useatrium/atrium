import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOW_BACKGROUND = {
  dark: '#09090b',
  light: '#fafafa',
} as const;

export const COMPACT_WINDOW_MIN_WIDTH = 420;
export const COMPACT_WINDOW_MIN_HEIGHT = 480;

interface WindowConfigContext {
  platform: NodeJS.Platform;
  shouldUseDarkColors: boolean;
}

export function launchBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function nativeChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle'> {
  return { titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default' };
}

export function mainWindowOptions(
  preload: string,
  { platform, shouldUseDarkColors }: WindowConfigContext,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 832,
    minWidth: COMPACT_WINDOW_MIN_WIDTH,
    minHeight: COMPACT_WINDOW_MIN_HEIGHT,
    backgroundColor: launchBackgroundColor(shouldUseDarkColors),
    title: 'Atrium',
    ...nativeChrome(platform),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  };
}

export function popoutWindowOptions(
  preload: string,
  { platform, shouldUseDarkColors }: WindowConfigContext,
): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 800,
    minWidth: COMPACT_WINDOW_MIN_WIDTH,
    minHeight: COMPACT_WINDOW_MIN_HEIGHT,
    backgroundColor: launchBackgroundColor(shouldUseDarkColors),
    title: 'Atrium',
    autoHideMenuBar: true,
    ...nativeChrome(platform),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  };
}
