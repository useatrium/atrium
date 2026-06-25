// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMarkdown } from '../src/sessions/Markdown';

afterEach(cleanup);

describe('SessionMarkdown', () => {
  it('renders GFM blocks, safe external links, and highlighted fences', () => {
    render(
      <SessionMarkdown
        text={[
          '## Plan',
          '',
          '- [x] Ship **markdown**',
          '- [ ] Keep tables',
          '',
          '| Lang | File |',
          '| --- | --- |',
          '| TypeScript | `SessionPane.tsx` |',
          '',
          '> streamed text',
          '',
          '```ts',
          'const shipped = true;',
          '```',
          '',
          'https://example.com/docs',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByText('Ship')).toBeTruthy();
    expect((screen.getByRole('checkbox', { checked: true }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('streamed text')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'https://example.com/docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    const code = screen.getByText('const');
    expect(code.closest('code')?.className).toContain('hljs');
    expect(code.closest('pre')?.className).toContain('overflow-x-auto');
  });

  it('keeps incomplete fences renderable during streaming', () => {
    render(<SessionMarkdown text={'Before\n```ts\nconst streaming ='} />);

    expect(screen.getByText(/Before/)).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toContain('const streaming =');
  });
});
