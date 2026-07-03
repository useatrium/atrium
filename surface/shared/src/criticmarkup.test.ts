import { describe, expect, it } from 'vitest';
import { parseMarkupSteer } from './criticmarkup';

describe('parseMarkupSteer', () => {
  it('tolerates the server referenced-entries appendix after a composed markup steer', () => {
    const steer =
      'I marked up your message ("Draft", entry rec_123) instead of replying in prose. The markup uses CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==} (a highlight binds the following comment to that span). Treat edits as requested changes and comments as my reactions/questions. This is my response to what you wrote - not a request to edit a file.\n\n' +
      '```markdown\nHello {++there++}\n```\n\n' +
      '---\nReferenced entries:\n' +
      '- /e/evt_1 (Alice, message): "Original context"';

    expect(parseMarkupSteer(steer)).toMatchObject({
      intent: 'response',
      title: 'Draft',
      sourceEntryHandle: 'rec_123',
      doc: 'Hello {++there++}',
    });
  });
});
