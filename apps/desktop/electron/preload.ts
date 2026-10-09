// The only bridge between the window and the main process: five narrow calls, nothing else.

import { contextBridge, ipcRenderer } from 'electron'

type LogEvent = { level: 'info' | 'warn'; message: string }

contextBridge.exposeInMainWorld('liftoff', {
  invoke: (name: string, args?: Record<string, unknown>) => ipcRenderer.invoke('liftoff:invoke', name, args),
  pickFolder: () => ipcRenderer.invoke('liftoff:pick-folder'),
  openFile: (filterName: string, extensions: string[]) => ipcRenderer.invoke('liftoff:open-file', filterName, extensions),
  saveFile: (defaultPath: string, filterName: string, extensions: string[]) => ipcRenderer.invoke('liftoff:save-file', defaultPath, filterName, extensions),
  onLog: (cb: (e: LogEvent) => void) => {
    const listener = (_e: unknown, payload: LogEvent) => cb(payload)
    ipcRenderer.on('liftoff:log', listener)
    return () => ipcRenderer.removeListener('liftoff:log', listener)
  },
})
