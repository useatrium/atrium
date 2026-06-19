// Shared helpers for mobile component tests (RNW + Testing Library under vitest).
// Import renderWithTheme to mount a component inside the app's ThemeProvider.
import { vi } from 'vitest';
import { AccessibilityInfo } from 'react-native';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ThemeProvider } from '../src/lib/theme';

// react-native-web's AccessibilityInfo.addEventListener returns undefined, but
// ThemeProvider's effect cleanup calls sub.remove() (real RN returns an
// EmitterSubscription). Hand it a no-op subscription so unmount is clean. Patch
// once, defensively (the method may be absent in some RNW builds).
const a11y = AccessibilityInfo as unknown as {
  addEventListener?: unknown;
  __themeTestPatched?: boolean;
};
if (typeof a11y.addEventListener === 'function' && !a11y.__themeTestPatched) {
  vi.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} } as never);
  a11y.__themeTestPatched = true;
}

export function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}
