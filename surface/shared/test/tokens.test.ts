import { describe, expect, it } from 'vitest';
import { mobilePalette, webPalette } from '../src/tokens';

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, received ${hex}`);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('palette tokens', () => {
  it('pins mobile dark faint text to the AA-safe web token', () => {
    const textFaint = mobilePalette.schemeTokens.dark.textFaint;

    expect(textFaint).toBe(webPalette.dark['fg-faint']);
    expect(textFaint).toBe('#85858e');
    expect(contrastRatio(textFaint, mobilePalette.schemeTokens.dark.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
