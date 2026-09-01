import { contextBridge, ipcRenderer } from "electron";

const DESKTOP_CHANNELS = {
  minimize: "desktop:minimize", toggleMaximize: "desktop:toggle-maximize", close: "desktop:close",
  isMaximized: "desktop:is-maximized", maximizedChanged: "desktop:maximized-changed",
  retry: "desktop:retry", diagnostics: "desktop:diagnostics"
} as const;

contextBridge.exposeInMainWorld("outreachDesktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke(DESKTOP_CHANNELS.minimize),
  toggleMaximize: () => ipcRenderer.invoke(DESKTOP_CHANNELS.toggleMaximize),
  close: () => ipcRenderer.invoke(DESKTOP_CHANNELS.close),
  isMaximized: () => ipcRenderer.invoke(DESKTOP_CHANNELS.isMaximized),
  retry: () => ipcRenderer.invoke(DESKTOP_CHANNELS.retry),
  diagnostics: () => ipcRenderer.invoke(DESKTOP_CHANNELS.diagnostics),
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
    ipcRenderer.on(DESKTOP_CHANNELS.maximizedChanged, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.maximizedChanged, handler);
  }
});
