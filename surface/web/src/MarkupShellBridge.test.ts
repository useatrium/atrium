import { describe, expect, it, vi } from 'vitest';
import { parseMarkupShellMessage, postMarkupShellMessage } from './MarkupShellBridge';

describe('MarkupShellBridge', () => {
  it('parses frozen init and serialize request messages', () => {
    expect(
      parseMarkupShellMessage(JSON.stringify({ type: 'markup-init', markdown: '# Draft', commentAuthor: 'gary' })),
    ).toEqual({ type: 'markup-init', markdown: '# Draft', commentAuthor: 'gary' });
    expect(parseMarkupShellMessage({ type: 'markup-request-serialize' })).toEqual({
      type: 'markup-request-serialize',
    });
  });

  it('ignores malformed messages', () => {
    expect(parseMarkupShellMessage('{')).toBeNull();
    expect(parseMarkupShellMessage({ type: 'markup-init' })).toBeNull();
    expect(parseMarkupShellMessage({ type: 'other', markdown: 'x' })).toBeNull();
  });

  it('posts JSON over the React Native WebView bridge', () => {
    const postMessage = vi.fn();
    postMarkupShellMessage({ postMessage }, { type: 'markup-dirty', dirty: true });

    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'markup-dirty', dirty: true }));
  });
});
