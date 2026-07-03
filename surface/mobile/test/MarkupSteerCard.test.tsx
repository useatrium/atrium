// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SteerRow } from '../src/components/work/SteerRow';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

const responsePreamble =
  'I marked up your message ("Draft answer", entry @agent:42) instead of replying in prose. The markup uses CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==} (a highlight binds the following comment to that span). Treat edits as requested changes and comments as my reactions/questions. This is my response to what you wrote - not a request to edit a file.';

describe('MarkupSteerCard (mobile)', () => {
  it('renders a parsed markup steer card with visible changes and notes', () => {
    const steer =
      `${responsePreamble}\n\n` +
      '```markdown\n' +
      'Keep {--old--} {++new++} {~~rough~>clear~~} {==claim==}{>>Needs source.<<}.\n\n' +
      '{>>Standalone note<<}\n' +
      '```\n\n' +
      'Note from me: Please keep the voice direct.';

    renderWithTheme(<SteerRow text={steer} />);

    expect(screen.getByTestId('markup-steer-card')).toBeTruthy();
    expect(screen.getByText('Marked up "Draft answer"')).toBeTruthy();
    expect(screen.getByText('Response')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.getByText('new')).toBeTruthy();
    expect(screen.getByText('rough')).toBeTruthy();
    expect(screen.getByText('clear')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText(/Needs source\./)).toBeTruthy();
    expect(screen.getByText('Standalone note')).toBeTruthy();
    expect(screen.getByText('Please keep the voice direct.')).toBeTruthy();
  });

  it('renders loose CriticMarkup without card chrome', () => {
    renderWithTheme(<SteerRow text="Please {--drop--} {++add++} this." />);

    expect(screen.queryByTestId('markup-steer-card')).toBeNull();
    expect(screen.getByText('drop')).toBeTruthy();
    expect(screen.getByText('add')).toBeTruthy();
  });

  it('leaves plain steers unchanged', () => {
    renderWithTheme(<SteerRow text="fix the parser" />);

    expect(screen.queryByTestId('markup-steer-card')).toBeNull();
    expect(screen.getByTestId('steer-row').textContent).toBe('fix the parser');
  });
});
