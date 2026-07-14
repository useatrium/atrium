import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export type ContextMenuAction =
  | { type: 'replace-misspelling'; suggestion: string }
  | { type: 'add-to-dictionary'; word: string }
  | { type: 'open-link'; url: string }
  | { type: 'copy-link'; url: string }
  | { type: 'save-image'; url: string }
  | { type: 'copy-image'; x: number; y: number }
  | { type: 'inspect-element'; x: number; y: number };

export type ContextMenuTemplateItem = MenuItemConstructorOptions & {
  action?: ContextMenuAction;
};

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Build a context-menu description without depending on a BrowserWindow or WebContents. */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  { isDev }: { isDev: boolean },
): ContextMenuTemplateItem[] {
  const template: ContextMenuTemplateItem[] = [];

  const appendGroup = (items: ContextMenuTemplateItem[]) => {
    if (items.length === 0) return;
    if (template.length > 0) template.push({ type: 'separator' });
    template.push(...items);
  };

  if (params.isEditable) {
    const spellingItems: ContextMenuTemplateItem[] = params.dictionarySuggestions.map((suggestion) => ({
      label: suggestion,
      action: { type: 'replace-misspelling', suggestion },
    }));
    if (params.misspelledWord) {
      spellingItems.push({
        label: 'Add to Dictionary',
        action: { type: 'add-to-dictionary', word: params.misspelledWord },
      });
    }
    appendGroup(spellingItems);

    appendGroup([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText.length > 0) {
    appendGroup([{ role: 'copy', enabled: params.editFlags.canCopy }]);
  }

  if (params.linkURL) {
    const linkItems: ContextMenuTemplateItem[] = [];
    if (isHttpUrl(params.linkURL)) {
      linkItems.push({ label: 'Open Link in Browser', action: { type: 'open-link', url: params.linkURL } });
    }
    linkItems.push({ label: 'Copy Link Address', action: { type: 'copy-link', url: params.linkURL } });
    appendGroup(linkItems);
  }

  if (params.mediaType === 'image') {
    appendGroup([
      { label: 'Save Image As…', action: { type: 'save-image', url: params.srcURL } },
      { label: 'Copy Image', action: { type: 'copy-image', x: params.x, y: params.y } },
    ]);
  }

  if (isDev) {
    appendGroup([{ label: 'Inspect Element', action: { type: 'inspect-element', x: params.x, y: params.y } }]);
  }

  return template;
}
