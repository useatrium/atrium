import { readFileSync } from 'node:fs';
import { syntaxTheme } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./Markdown.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): Record<string, string> {
  const selectorStart = css.indexOf(`${selector} {`);
  expect(selectorStart, `Missing CSS block for ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = css.indexOf('{', selectorStart) + 1;
  const bodyEnd = css.indexOf('}', bodyStart);
  expect(bodyEnd, `Unclosed CSS block for ${selector}`).toBeGreaterThan(bodyStart);

  return Object.fromEntries(
    [...css.slice(bodyStart, bodyEnd).matchAll(/--syntax-([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2]?.trim(),
    ]),
  );
}

function cssName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function expectThemeBlock(selector: string, expected: Readonly<Record<string, string>>): void {
  const actual = declarationsFor(selector);
  const expectedCss = Object.fromEntries(Object.entries(expected).map(([name, value]) => [cssName(name), value]));
  expect(actual).toEqual(expectedCss);
}

describe('Markdown.css syntax theme contract', () => {
  it('pins the default dark variables to the shared theme', () => {
    expectThemeBlock('.atrium-session-markdown', syntaxTheme.dark);
  });

  it('pins the light variables to the shared theme', () => {
    expectThemeBlock(':root[data-theme="light"] .atrium-session-markdown', syntaxTheme.light);
  });
});
