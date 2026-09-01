import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_CHANNELS } from "./channels";

const source = readFileSync(join(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
const preload = readFileSync(join(process.cwd(), "apps/desktop/src/preload.ts"), "utf8");
const desktopPackage = readFileSync(join(process.cwd(), "apps/desktop/package.json"), "utf8");
const devLauncher = readFileSync(join(process.cwd(), "apps/desktop/scripts/dev.cjs"), "utf8");
const devConfig = JSON.parse(readFileSync(join(process.cwd(), "apps/desktop/desktop-dev.json"), "utf8"));

describe("Electron desktop shell", () => {
  it("creates a secure frameless window with minimum dimensions", () => {
    expect(source).toContain("frame: false");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("minWidth: 1100");
  });
  it("exposes only named desktop actions through the preload bridge", () => {
    expect(preload).toContain('contextBridge.exposeInMainWorld("outreachDesktop"');
    expect(preload).not.toContain("require(");
    expect(Object.keys(DESKTOP_CHANNELS)).toEqual(["minimize", "toggleMaximize", "close", "isMaximized", "maximizedChanged", "retry", "diagnostics"]);
    for (const channel of Object.values(DESKTOP_CHANNELS)) expect(source + preload).toContain(channel.split(":")[1] ?? channel);
  });
  it("handles minimize, maximize/restore, close and safe startup fallback", () => {
    expect(source).toContain(".minimize()");
    expect(source).toContain("window.isMaximized() ? window.unmaximize() : window.maximize()");
    expect(source).toContain(".close()");
    expect(source).toContain('loadFile(join(__dirname, "startup-error.html")');
    const errorPage = readFileSync(join(process.cwd(), "apps/desktop/src/startup-error.html"), "utf8");
    expect(errorPage).toContain("prefers-color-scheme:light");
    expect(errorPage).toContain("Content-Security-Policy");
  });
  it("uses an isolated deterministic frontend port for desktop development", () => {
    expect(devConfig).toMatchObject({ host: "127.0.0.1", port: 3010, healthPath: "/api/health" });
    expect(desktopPackage).toContain("node scripts/dev.cjs");
    expect(devLauncher).toContain('"--port", String(config.port)');
    expect(devLauncher).toContain("OUTREACH_UI_URL: uiUrl");
    expect(devLauncher).toContain("NEXT_PUBLIC_API_URL: `${uiUrl}/api/v1`");
    expect(devLauncher).toContain('OUTREACH_API_URL ?? "http://127.0.0.1:4000"');
    expect(devLauncher).toContain("Dedicated desktop port");
    expect(devLauncher).not.toContain("127.0.0.1:3000");
  });
  it("assigns Outreach its own desktop identity and user-data directory", () => {
    expect(source).toContain('const APP_NAME = "TikTok Outreach"');
    expect(source).toContain('app.setPath("userData"');
    expect(source).toContain("app.setAppUserModelId(APP_ID)");
  });
});
