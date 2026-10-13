// The desktop app's main process: one window, and the commands (commands.ts) the screens call.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import * as path from 'node:path'
import { asLiftoffError } from '../../../packages/liftoff/src/core/errors.ts'
import { commands, type Host } from './commands.ts'
import { Updater, type UpdateMode } from './updates.ts'

// Kept from the earlier desktop build, so recent projects carry over.
const configDir = path.join(app.getPath('appData'), 'app.liftoff.desktop')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'LiftOff',
    icon: path.join(import.meta.dirname, '..', 'electron', 'icon.png'),
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win.removeMenu()
  win.once('ready-to-show', () => win.show())
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  const devUrl = process.env.LIFTOFF_DEV_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(import.meta.dirname, '..', 'dist', 'index.html'))
  return win
}

app.whenReady().then(() => {
  const win = createWindow()
  const host: Host = {
    configDir,
    log: (level, message) => {
      if (!win.isDestroyed()) win.webContents.send('liftoff:log', { level, message })
    },
  }

  // Errors cross to the window as a plain report, so the screens get the code and the message.
  ipcMain.handle('liftoff:invoke', async (_e, name: string, args: Record<string, unknown>) => {
    const command = commands[name]
    if (!command) return { ok: false, error: { code: 'LIFTOFF_CONFIG', exit_code: 2, message: `unknown command ${name}` } }
    try {
      return { ok: true, value: (await command(args ?? {}, host)) ?? null }
    } catch (e) {
      return { ok: false, error: asLiftoffError(e).report() }
    }
  })

  const updater = new Updater(configDir, (info) => {
    if (!win.isDestroyed()) win.webContents.send('liftoff:update', info)
  })
  updater.start()
  ipcMain.handle('liftoff:update', (_e, action: unknown, mode: unknown) => {
    if (action === 'mode' && (mode === 'notify' || mode === 'auto' || mode === 'off')) return updater.setMode(mode as UpdateMode)
    if (action === 'check') return updater.check()
    if (action === 'download') return updater.download()
    if (action === 'install') return updater.install()
    if (action === 'page') return updater.openPage()
    return updater.info()
  })

  ipcMain.handle('liftoff:set-theme', (_e, theme: unknown) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
  })
  ipcMain.handle('liftoff:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('liftoff:open-file', async (_e, filterName: string, extensions: string[]) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: filterName, extensions }] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('liftoff:save-file', async (_e, defaultPath: string, filterName: string, extensions: string[]) => {
    const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: filterName, extensions }] })
    return r.canceled ? null : (r.filePath ?? null)
  })
})

app.on('window-all-closed', () => app.quit())
