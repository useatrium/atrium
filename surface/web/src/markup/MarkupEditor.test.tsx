// @vitest-environment jsdom

import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MarkupEditor, type MarkupEditorHandle } from './MarkupEditor';

describe('MarkupEditor', () => {
  it('exposes the frozen imperative handle contract', () => {
    const ref = createRef<MarkupEditorHandle>();
    render(<MarkupEditor ref={ref} initialMarkdown={'# Title\n\nBody.'} />);

    expect(ref.current?.serialize()).toBe('# Title\n\nBody.');
    expect(ref.current?.hasMarkup()).toBe(false);
  });

  it('does not report dirty on a plain initial document', () => {
    const onDirtyChange = vi.fn();
    render(<MarkupEditor initialMarkdown="Plain text." onDirtyChange={onDirtyChange} />);

    expect(onDirtyChange).not.toHaveBeenCalled();
  });
});
