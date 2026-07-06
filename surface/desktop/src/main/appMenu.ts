import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuDeps {
  createMainWindow: () => void;
  quit: () => void;
  platform?: typeof process.platform;
}

export function buildAppMenu({
  createMainWindow,
  quit,
  platform = process.platform,
}: AppMenuDeps): Menu {
  const isMac = platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name || 'Atrium',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { type: 'separator' },
        { label: 'Quit Atrium', accelerator: 'Command+Q', click: quit },
      ],
    });
  }

  template.push(
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          click: createMainWindow,
        },
        {
          label: 'Close Window',
          accelerator: 'CommandOrControl+W',
          role: 'close',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CommandOrControl+R', role: 'reload' },
        {
          label: 'Force Reload',
          accelerator: 'CommandOrControl+Shift+R',
          role: 'forceReload',
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', role: 'resetZoom' },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [],
    },
  );

  return Menu.buildFromTemplate(template);
}
