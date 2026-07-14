import type { ContextMenuParams } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildContextMenuTemplate } from './contextMenuTemplate.js';

function contextMenuParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    frame: null,
    linkURL: '',
    linkText: '',
    pageURL: 'app://atrium/index.html',
    frameURL: 'app://atrium/index.html',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: 'default', url: '' },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: 'UTF-8',
    formControlType: 'none',
    spellcheckEnabled: true,
    menuSourceType: 'mouse',
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: true,
    },
    ...overrides,
  };
}

describe('buildContextMenuTemplate', () => {
  it('adds editing roles for editable content', () => {
    const template = buildContextMenuTemplate(contextMenuParams({ isEditable: true }), { isDev: false });

    expect(template.map((item) => item.role).filter(Boolean)).toEqual([
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
    ]);
  });

  it('puts spelling suggestions before editing commands', () => {
    const template = buildContextMenuTemplate(
      contextMenuParams({
        isEditable: true,
        misspelledWord: 'mispelt',
        dictionarySuggestions: ['misspelt', 'misdealt'],
      }),
      { isDev: false },
    );

    expect(template.slice(0, 3).map((item) => item.label)).toEqual(['misspelt', 'misdealt', 'Add to Dictionary']);
    expect(template[3]).toEqual({ type: 'separator' });
  });

  it('adds Copy Link Address for links', () => {
    const template = buildContextMenuTemplate(contextMenuParams({ linkURL: 'https://example.com' }), { isDev: false });

    expect(template.map((item) => item.label)).toContain('Copy Link Address');
  });

  it('does not open non-http links in the browser', () => {
    const template = buildContextMenuTemplate(contextMenuParams({ linkURL: 'file:///etc/passwd' }), { isDev: false });

    expect(template.map((item) => item.label)).toEqual(['Copy Link Address']);
  });

  it('omits Inspect Element in production', () => {
    const template = buildContextMenuTemplate(contextMenuParams({ selectionText: 'hello' }), { isDev: false });

    expect(template.map((item) => item.label)).not.toContain('Inspect Element');
  });
});
