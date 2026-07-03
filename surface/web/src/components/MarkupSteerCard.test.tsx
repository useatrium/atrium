// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkupSteerCard } from './MarkupSteerCard';

const responsePreamble =
  'I marked up your message ("Draft answer", entry @agent:42) instead of replying in prose. The markup uses CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==} (a highlight binds the following comment to that span). Treat edits as requested changes and comments as my reactions/questions. This is my response to what you wrote - not a request to edit a file.';

function responseSteer(doc: string, suffix = '') {
  return `${responsePreamble}\n\n\`\`\`markdown\n${doc}\n\`\`\`${suffix}`;
}

function reviseSteer(doc: string, suffix = '') {
  return (
    'I marked up `docs/long.md` (my v9, on top of your v8) with changes and comments in CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==}. The file in your workspace already has my markup. Please apply the edits, address the comments, and produce a clean next revision of `docs/long.md` (remove all CriticMarkup syntax in your revision).\n\n' +
    `\`\`\`\`markdown\n${doc}\n\`\`\`\`${suffix}`
  );
}

afterEach(() => cleanup());

describe('MarkupSteerCard', () => {
  it('renders a parsed steer card while hiding the wire preamble until raw is opened', () => {
    const text = responseSteer(
      'Keep {--old--} and {++new++}. Replace {~~before~>after~~}. {==flagged==}{>>explain this<<}\n{>>standalone note<<}',
      '\n\nNote from me: Please keep the voice direct.',
    );
    const { container } = render(<MarkupSteerCard text={text} />);

    expect(screen.getByText('Marked up "Draft answer"')).toBeTruthy();
    expect(screen.getByText('markup')).toBeTruthy();
    expect(screen.queryByText(/instead of replying in prose/)).toBeNull();

    expect(screen.getByText('old').className).toContain('atrium-critic-view-del');
    expect(screen.getByText('new').className).toContain('atrium-critic-view-ins');
    expect(screen.getByText('before').className).toContain('atrium-critic-view-del');
    expect(screen.getByText('after').className).toContain('atrium-critic-view-ins');
    expect(screen.getByText('flagged').className).toContain('atrium-critic-view-highlight');
    expect(screen.getByText('explain this')).toBeTruthy();
    expect(screen.getByText('standalone note')).toBeTruthy();
    expect(screen.getByText('Note')).toBeTruthy();
    expect(screen.getByText('Please keep the voice direct.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'view raw' }));
    expect(container.querySelector('pre')?.textContent).toBe(text);
  });

  it('renders fallback CriticMarkup text without card chrome', () => {
    render(<MarkupSteerCard text="Plain {--old--}{++new++} text." />);

    expect(screen.queryByText('markup')).toBeNull();
    expect(screen.getByText('old').className).toContain('atrium-critic-view-del');
    expect(screen.getByText('new').className).toContain('atrium-critic-view-ins');
    expect(screen.getByRole('button', { name: 'view raw' })).toBeTruthy();
  });

  it('keeps a plain steer as the existing pre-wrap body', () => {
    const { container } = render(<MarkupSteerCard text="Just a normal steer." />);

    expect(screen.queryByRole('button', { name: 'view raw' })).toBeNull();
    expect(container.firstElementChild?.className).toBe('whitespace-pre-wrap text-sm leading-relaxed text-fg-body');
    expect(container.textContent).toBe('Just a normal steer.');
  });

  it('shows the truncated footer for hunk-mode steers', () => {
    const text = reviseSteer(
      'context\n{++change++}\n⋯\nmore context',
      '\n\nFull document: docs/long.md (already synced into your workspace; my markup is v9, diff against v8).',
    );
    render(<MarkupSteerCard text={text} />);

    expect(screen.getAllByText('docs/long.md')).toHaveLength(2);
    expect(screen.getByText(/full document in Files/)).toBeTruthy();
    expect(screen.getByLabelText('omitted content')).toBeTruthy();
  });
});
