import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shell = readFileSync(join(process.cwd(), "apps/web/components/app-shell.tsx"), "utf8");
const titlebar = readFileSync(join(process.cwd(), "apps/web/components/desktop-titlebar.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "apps/web/app/globals.css"), "utf8");

describe("desktop-aware application shell", () => {
  it("renders desktop chrome only when the preload bridge exists", () => {
    expect(titlebar).toContain("window.outreachDesktop");
    expect(titlebar).toContain("if (!desktop) return null");
  });
  it("keeps one primary vertical content scroller and fixed shell regions", () => {
    expect(shell).toContain('className="content-scroller"');
    expect(css).toContain(".content-scroller{min-height:0;overflow-y:auto;overflow-x:hidden");
    expect(css).toContain("html,body{margin:0;width:100%;height:100%;overflow:hidden");
  });
  it("uses drag only on the titlebar and no-drag on controls", () => {
    expect(css).toContain(".desktop-titlebar{");
    expect(css).toContain("-webkit-app-region:drag");
    expect(css).toContain("button,a,input,select,textarea,[role=\"button\"]{-webkit-app-region:no-drag}");
    expect(css).toContain(".window-controls{height:34px;display:flex;margin-left:auto;-webkit-app-region:no-drag}");
  });
  it("supports system, light and dark through shared tokens", () => {
    expect(shell).toContain('["system", "light", "dark"]');
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="dark"]');
  });
});
