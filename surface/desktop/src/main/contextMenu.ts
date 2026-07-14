import { BrowserWindow, Menu, clipboard, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import {
  buildContextMenuTemplate,
  type ContextMenuAction,
  type ContextMenuTemplateItem,
} from './contextMenuTemplate.js';

const installedWebContents = new WeakSet<WebContents>();

function runContextMenuAction(webContents: WebContents, action: ContextMenuAction): void {
  switch (action.type) {
    case 'replace-misspelling':
      webContents.replaceMisspelling(action.suggestion);
      break;
    case 'add-to-dictionary':
      webContents.session.addWordToSpellCheckerDictionary(action.word);
      break;
    case 'open-link': {
      const protocol = new URL(action.url).protocol;
      if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(action.url);
      break;
    }
    case 'copy-link':
      clipboard.writeText(action.url);
      break;
    case 'save-image':
      webContents.downloadURL(action.url);
      break;
    case 'copy-image':
      webContents.copyImageAt(action.x, action.y);
      break;
    case 'inspect-element':
      webContents.inspectElement(action.x, action.y);
      break;
  }
}

function bindActions(webContents: WebContents, template: ContextMenuTemplateItem[]): MenuItemConstructorOptions[] {
  return template.map(({ action, ...item }) =>
    action
      ? {
          ...item,
          click: () => runContextMenuAction(webContents, action),
        }
      : item,
  );
}

export function installContextMenu(webContents: WebContents, { isDev }: { isDev: boolean }): void {
  if (installedWebContents.has(webContents)) return;
  installedWebContents.add(webContents);

  if (!webContents.session.isSpellCheckerEnabled()) {
    webContents.session.setSpellCheckerEnabled(true);
  }

  webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, { isDev });
    if (template.length === 0) return;

    Menu.buildFromTemplate(bindActions(webContents, template)).popup({
      window: BrowserWindow.fromWebContents(webContents) ?? undefined,
    });
  });
}
