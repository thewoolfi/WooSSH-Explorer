import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';

/**
 * Actions the menu delegates to the renderer. The renderer already implements all
 * of them behind keyboard shortcuts, so the menu simply reuses those paths.
 */
export type MenuAction =
  | 'new-connection'
  | 'close-tab'
  | 'reconnect'
  | 'disconnect'
  | 'open-home'
  | 'open-root'
  | 'new-terminal'
  | 'new-folder'
  | 'upload'
  | 'refresh'
  | 'focus-filter'
  | 'edit-path'
  | 'command-palette'
  | 'toggle-theme'
  | 'toggle-dotfiles'
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'open-transfers'
  | 'server-stats'
  | 'known-hosts'
  | 'diagnostics'
  | 'clear-transfers';

export interface MenuContext {
  send: (action: MenuAction) => void;
  downloadDir: string;
  stateDir: string;
  /** Rotating log file, mirrored from the server's own path. */
  logFilePath: string;
  /** Where the log lives, so "Open Log File" still does something before the first line. */
  logDir: string;
  version: string;
}

const isMac = process.platform === 'darwin';

export function buildMenu(context: MenuContext): Menu {
  const action = (label: string, menuAction: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => context.send(menuAction),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '&File',
      submenu: [
        action('New Connection…', 'new-connection', 'CmdOrCtrl+N'),
        action('New Terminal', 'new-terminal', 'CmdOrCtrl+T'),
        { type: 'separator' },
        action('New Folder…', 'new-folder', 'CmdOrCtrl+Shift+N'),
        action('Upload Files…', 'upload', 'CmdOrCtrl+U'),
        { type: 'separator' },
        action('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        action('Command Palette…', 'command-palette', 'CmdOrCtrl+K'),
      ],
    },
    {
      label: '&View',
      submenu: [
        action('Refresh Folder', 'refresh', 'F5'),
        action('Focus Filter', 'focus-filter', 'CmdOrCtrl+F'),
        action('Edit Path…', 'edit-path', 'CmdOrCtrl+L'),
        { type: 'separator' },
        action('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        action('Toggle Inspector', 'toggle-inspector', 'CmdOrCtrl+I'),
        action('Show Hidden Files', 'toggle-dotfiles', 'CmdOrCtrl+H'),
        { type: 'separator' },
        action('Toggle Light / Dark Theme', 'toggle-theme', 'CmdOrCtrl+Shift+L'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Connection',
      submenu: [
        action('Go to Home Directory', 'open-home', 'CmdOrCtrl+1'),
        action('Go to Root', 'open-root', 'CmdOrCtrl+2'),
        { type: 'separator' },
        action('Reconnect', 'reconnect'),
        action('Disconnect', 'disconnect'),
      ],
    },
    {
      label: '&Tools',
      submenu: [
        action('Server Status', 'server-stats', 'CmdOrCtrl+Shift+S'),
        action('Known Hosts', 'known-hosts', 'CmdOrCtrl+Shift+K'),
        action('Diagnostics…', 'diagnostics', 'CmdOrCtrl+Shift+D'),
        { type: 'separator' },
        action('Open Transfer Queue', 'open-transfers', 'CmdOrCtrl+J'),
        action('Clear Finished Transfers', 'clear-transfers'),
        { type: 'separator' },
        {
          label: 'Open Downloads Folder',
          click: () => void shell.openPath(context.downloadDir),
        },
        {
          label: 'Open Configuration Folder',
          click: () => void shell.openPath(context.stateDir),
        },
        // The windowed build has no console: without this, a bug report has nothing to attach.
        {
          label: 'Open Log File',
          click: () => {
            const file = context.logFilePath;
            void shell.openPath(existsSync(file) ? file : context.logDir);
          },
        },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: `WooSSH Explorer ${context.version}`,
          click: () => context.send('command-palette'),
        },
        {
          label: 'SSH config and known_hosts are read from your home directory',
          enabled: false,
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** Sends a menu action to whichever window currently has focus. */
export function sendToFocused(window: BrowserWindow | null, action: MenuAction): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('desktop:menu', action);
  if (window.isMinimized()) window.restore();
  window.focus();
}
