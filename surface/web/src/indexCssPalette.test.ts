import { readFileSync } from 'node:fs';
import { webPalette } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): Record<string, string> {
  const selectorStart = css.indexOf(`${selector} {`);
  expect(selectorStart, `Missing CSS block for ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = css.indexOf('{', selectorStart) + 1;
  const bodyEnd = css.indexOf('}', bodyStart);
  expect(bodyEnd, `Unclosed CSS block for ${selector}`).toBeGreaterThan(bodyStart);

  return Object.fromEntries(
    [...css.slice(bodyStart, bodyEnd).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2]?.trim(),
    ]),
  );
}

function expectPaletteBlock(selector: string, expected: Readonly<Record<string, string>>): void {
  const actual = declarationsFor(selector);
  expect(Object.keys(actual).sort(), `${selector}: custom property names`).toEqual(Object.keys(expected).sort());

  for (const [name, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[name];
    expect(
      actualValue,
      `${selector} --${name}: expected ${expectedValue}, received ${actualValue ?? '<missing>'}`,
    ).toBe(expectedValue);
  }
}

function swatchColor(name: string): string | undefined {
  const declarations = declarationsFor(`.accent-swatch-${name}`);
  const selectorStart = css.indexOf(`.accent-swatch-${name} {`);
  const bodyStart = css.indexOf('{', selectorStart) + 1;
  const bodyEnd = css.indexOf('}', bodyStart);
  const match = /background-color\s*:\s*([^;]+);/.exec(css.slice(bodyStart, bodyEnd));

  expect(declarations, `.accent-swatch-${name} must not define custom properties`).toEqual({});
  return match?.[1]?.trim();
}

describe('index.css palette contract', () => {
  it('pins the dark and light semantic token blocks', () => {
    expectPaletteBlock(':root', webPalette.dark);
    expectPaletteBlock(':root[data-theme="light"]', webPalette.light);
  });

  it('pins every accent override block', () => {
    for (const accent of ['teal', 'amber', 'rose'] as const) {
      expectPaletteBlock(`:root[data-theme="dark"][data-accent="${accent}"]`, webPalette.accents[accent].dark);
      expectPaletteBlock(`:root[data-theme="light"][data-accent="${accent}"]`, webPalette.accents[accent].light);
    }
  });

  it('pins both high-contrast override blocks', () => {
    expectPaletteBlock(':root[data-theme="dark"][data-contrast="high"]', webPalette.highContrast.dark);
    expectPaletteBlock(':root[data-theme="light"][data-contrast="high"]', webPalette.highContrast.light);
  });

  it('pins accent swatches to the light-theme base accent colors', () => {
    const expected = {
      indigo: webPalette.light.accent,
      teal: webPalette.accents.teal.light.accent,
      amber: webPalette.accents.amber.light.accent,
      rose: webPalette.accents.rose.light.accent,
    };

    for (const [name, expectedValue] of Object.entries(expected)) {
      const actualValue = swatchColor(name);
      expect(
        actualValue,
        `.accent-swatch-${name} background-color: expected ${expectedValue}, received ${actualValue ?? '<missing>'}`,
      ).toBe(expectedValue);
    }
  });
});
