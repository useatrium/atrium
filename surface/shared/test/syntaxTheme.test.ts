import { describe, expect, it } from 'vitest';
import { createHljsStyle, syntaxTheme } from '../src/syntaxTheme';

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

describe('syntax theme', () => {
  it('pins the existing dark palette', () => {
    expect(syntaxTheme.dark).toEqual({
      comment: '#8f8f98',
      keyword: '#ff7b72',
      literal: '#79c0ff',
      string: '#a5d6ff',
      title: '#d2a8ff',
      builtIn: '#7ee787',
      attribute: '#f2cc60',
      addition: '#aff5b4',
      additionBackground: 'rgba(3, 58, 22, 0.45)',
      deletion: '#ffdcd7',
      deletionBackground: 'rgba(103, 6, 12, 0.45)',
    });
  });

  it('pins the GitHub-light-equivalent palette', () => {
    expect(syntaxTheme.light).toEqual({
      comment: '#656d76',
      keyword: '#cf222e',
      literal: '#0550ae',
      string: '#0a3069',
      title: '#8250df',
      builtIn: '#116329',
      attribute: '#953800',
      addition: '#116329',
      additionBackground: '#dafbe1',
      deletion: '#82071e',
      deletionBackground: '#ffebe9',
    });
  });

  it('keeps light syntax text AA-readable on both light code backgrounds', () => {
    const plainRoles = ['comment', 'keyword', 'literal', 'string', 'title', 'builtIn', 'attribute'] as const;
    for (const role of plainRoles) {
      for (const background of ['#fdfdff', '#ffffff', '#fafafa']) {
        expect(contrastRatio(syntaxTheme.light[role], background), `${role} on ${background}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
    expect(contrastRatio(syntaxTheme.light.addition, syntaxTheme.light.additionBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(syntaxTheme.light.deletion, syntaxTheme.light.deletionBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it('maps every hljs class used by web into the mobile style adapter', () => {
    const style = createHljsStyle(syntaxTheme.light, { backgroundColor: '#ffffff', color: '#3f3f46' });

    expect(style['hljs-selector-class']).toEqual({ color: syntaxTheme.light.attribute });
    expect(style['hljs-attr']).toEqual({ color: syntaxTheme.light.literal });
    expect(style['hljs-template-variable']).toEqual({ color: syntaxTheme.light.literal });
    expect(style['hljs-doctag']).toEqual({ color: syntaxTheme.light.string });
    expect(style['hljs-addition']).toEqual({
      color: syntaxTheme.light.addition,
      backgroundColor: syntaxTheme.light.additionBackground,
    });
    expect(style['hljs-deletion']).toEqual({
      color: syntaxTheme.light.deletion,
      backgroundColor: syntaxTheme.light.deletionBackground,
    });
  });
});
