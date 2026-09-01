import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { DESKTOP_CHANNELS } from "./channels";

const UI_URL = process.env.OUTREACH_UI_URL ?? "http://127.0.0.1:3000";
const UI_ORIGIN = new URL(UI_URL).origin;
const APP_NAME = "TikTok Outreach";
const APP_ID = "com.local.tiktokoutreach";
let mainWindow: BrowserWindow | null = null;
let showingError = false;

app.setName(APP_NAME);
app.setPath("userData", join(app.getPath("appData"), APP_NAME));

function isAllowedSender(url: string) {
  if (url.startsWith("file:") && url.includes("startup-error.html")) return true;
  try { return new URL(url).origin === UI_ORIGIN; } catch { return false; }
}

function fromAllowedSender(event: Electron.IpcMainInvokeEvent) {
  if (!event.senderFrame || !isAllowedSender(event.senderFrame.url)) throw new Error("Untrusted desktop IPC sender");
  return BrowserWindow.fromWebContents(event.sender);
}

async function loadOutreach(window: BrowserWindow) {
  showingError = false;
  try { await window.loadURL(UI_URL); }
  catch { if (!window.isDestroyed()) await showStartupError(window); }
}

async function showStartupError(window: BrowserWindow) {
  if (showingError || window.isDestroyed()) return;
  showingError = true;
  await window.loadFile(join(__dirname, "startup-error.html"), { query: { target: UI_URL } });
}

export function createWindow() {
  const window = new BrowserWindow({
    width: 1366, height: 860, minWidth: 1100, minHeight: 680, frame: false, show: false,
    title: APP_NAME,
    backgroundColor: "#0A0A0A", icon: app.isPackaged ? join(process.resourcesPath, "resources", "icon.png") : join(__dirname, "..", "resources", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!isAllowedSender(url)) event.preventDefault(); });
  window.webContents.on("did-fail-load", (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 && validatedURL.startsWith(UI_ORIGIN)) void showStartupError(window);
  });
  window.on("maximize", () => window.webContents.send(DESKTOP_CHANNELS.maximizedChanged, true));
  window.on("unmaximize", () => window.webContents.send(DESKTOP_CHANNELS.maximizedChanged, false));
  window.once("ready-to-show", () => window.show());
  void loadOutreach(window);
  mainWindow = window;
  return window;
}

function registerIpc() {
  ipcMain.handle(DESKTOP_CHANNELS.minimize, (event) => { fromAllowedSender(event)?.minimize(); });
  ipcMain.handle(DESKTOP_CHANNELS.toggleMaximize, (event) => { const window = fromAllowedSender(event); if (!window) return false; window.isMaximized() ? window.unmaximize() : window.maximize(); return window.isMaximized(); });
  ipcMain.handle(DESKTOP_CHANNELS.close, (event) => { fromAllowedSender(event)?.close(); });
  ipcMain.handle(DESKTOP_CHANNELS.isMaximized, (event) => fromAllowedSender(event)?.isMaximized() ?? false);
  ipcMain.handle(DESKTOP_CHANNELS.retry, async (event) => { const window = fromAllowedSender(event); if (window) await loadOutreach(window); });
  ipcMain.handle(DESKTOP_CHANNELS.diagnostics, (event) => { fromAllowedSender(event); return { target: UI_URL, appVersion: app.getVersion(), platform: process.platform }; });
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  registerIpc(); createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
