import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Electron ships NO default context menu, and the app never installed one — so
// right-clicking the composer in the packaged app did nothing at all: no
// cut/copy/paste, no spellcheck, no "Copy Link Address". contextMenuTemplate.ts
// is unit-tested as a pure function; what those unit tests CANNOT show is that
// the handler is actually bound to a real window's webContents. That is what
// this spec proves: it fires a genuine 'context-menu' event on the live window
// and captures the template the app would have popped up.

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

const e2eDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(e2eDir, '..');
const builtMainEntry = resolve(desktopRoot, 'out/main/index.js');
const builtRendererRoot = resolve(desktopRoot, '../web/dist');

async function assertBuilt(path: string, hint: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(`Not found at ${path}. Run "${hint}" first.`);
}

/**
 * Swap Menu.buildFromTemplate for a recorder, dispatch a real 'context-menu'
 * event at the main window's webContents, and return the labels/roles the app
 * built. The electron module object is shared with the app's own import, so the
 * patch is seen by the installed handler.
 */
async function capturedMenuFor(
  app: ElectronApp,
  params: Record<string, unknown>,
): Promise<{ label?: string; role?: string; type?: string }[]> {
  return app.evaluate(async ({ BrowserWindow, Menu }, contextMenuParams) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('main window not found');

    const original = Menu.buildFromTemplate;
    let captured: { label?: string; role?: string; type?: string }[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test-only shim over Electron's Menu factory.
    (Menu as any).buildFromTemplate = (template: any[]) => {
      captured = template.map((item) => ({ label: item.label, role: item.role, type: item.type }));
      return { popup: () => {} };
    };

    try {
      const base = {
        x: 10,
        y: 20,
        linkURL: '',
        linkText: '',
        srcURL: '',
        mediaType: 'none',
        isEditable: false,
        selectionText: '',
        misspelledWord: '',
        dictionarySuggestions: [],
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      };
      window.webContents.emit('context-menu', {}, { ...base, ...contextMenuParams });
      return captured;
    } finally {
      Menu.buildFromTemplate = original;
    }
  }, params);
}

test('the desktop window installs a native context menu', async () => {
  const testInfo = test.info();
  await assertBuilt(builtMainEntry, 'pnpm --filter @atrium/desktop build');

  const userDataDir = testInfo.outputPath('user-data');
  await mkdir(userDataDir, { recursive: true });

  const env = { ...process.env };
  delete env.ATRIUM_RENDERER_URL;

  let app: ElectronApp | null = null;
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, builtMainEntry],
      env: {
        ...env,
        ATRIUM_WEB_DIST: builtRendererRoot,
        ATRIUM_SERVER_URL: 'http://127.0.0.1:9',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });
    await app.firstWindow({ timeout: 30_000 });

    // The composer: an editable field. Before this change, right-clicking it
    // produced literally nothing.
    const editable = await capturedMenuFor(app, { isEditable: true });
    const editableRoles = editable.map((item) => item.role);
    expect(editableRoles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']));

    // A misspelled word offers its suggestions first, then Add to Dictionary.
    const misspelled = await capturedMenuFor(app, {
      isEditable: true,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'ten'],
    });
    const misspelledLabels = misspelled.map((item) => item.label);
    expect(misspelledLabels[0]).toBe('the');
    expect(misspelledLabels).toContain('Add to Dictionary');

    // A link keeps the two things the web hijack used to steal.
    const link = await capturedMenuFor(app, { linkURL: 'https://example.com/x' });
    const linkLabels = link.map((item) => item.label);
    expect(linkLabels).toContain('Copy Link Address');
    expect(linkLabels).toContain('Open Link in Browser');

    // Non-http schemes must never reach shell.openExternal.
    const badScheme = await capturedMenuFor(app, { linkURL: 'file:///etc/passwd' });
    const badLabels = badScheme.map((item) => item.label);
    expect(badLabels).toContain('Copy Link Address');
    expect(badLabels).not.toContain('Open Link in Browser');

    // An image offers Save/Copy.
    const image = await capturedMenuFor(app, {
      mediaType: 'image',
      srcURL: 'https://example.com/cat.png',
    });
    const imageLabels = image.map((item) => item.label);
    expect(imageLabels).toContain('Save Image As…');
    expect(imageLabels).toContain('Copy Image');
  } finally {
    await app?.close();
  }
});
