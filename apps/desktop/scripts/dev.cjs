const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const desktopDirectory = join(__dirname, "..");
const repositoryDirectory = join(desktopDirectory, "..", "..");
const webDirectory = join(repositoryDirectory, "apps", "web");
const config = JSON.parse(readFileSync(join(desktopDirectory, "desktop-dev.json"), "utf8"));
const uiUrl = `http://${config.host}:${config.port}`;
const healthUrl = `${uiUrl}${config.healthPath}`;
const nextCli = require.resolve("next/dist/bin/next", { paths: [webDirectory] });
const children = new Set();
let stopping = false;

function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      const detail = error && error.code === "EADDRINUSE"
        ? `Dedicated desktop port ${config.port} is already occupied. Stop that process or change apps/desktop/desktop-dev.json; Electron will not fall back to another port.`
        : `Unable to reserve ${uiUrl}: ${error.message}`;
      reject(new Error(detail));
    });
    server.listen({ host: config.host, port: config.port, exclusive: true }, () => server.close(resolve));
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repositoryDirectory, stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitForFrontend(frontend) {
  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (frontend.exitCode !== null) throw new Error(`Next.js exited before ${healthUrl} became ready (code ${frontend.exitCode}).`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out after ${config.startupTimeoutMs}ms waiting for ${healthUrl}.`);
}

function stopChildTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  if (children.size === 0) process.exit(exitCode);
  for (const child of children) stopChildTree(child);
  setTimeout(() => process.exit(exitCode), 200);
}

async function main() {
  await assertPortAvailable();
  console.log(`[desktop] Starting the dedicated Next.js frontend at ${uiUrl}`);
  const frontend = start(process.execPath, [nextCli, "dev", "--hostname", config.host, "--port", String(config.port)], {
    cwd: webDirectory,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: `${uiUrl}/api/v1`,
      OUTREACH_QA_PROXY_TARGET: process.env.OUTREACH_API_URL ?? "http://127.0.0.1:4000"
    }
  });
  frontend.once("exit", (code) => { if (!stopping) shutdown(code ?? 1); });
  await waitForFrontend(frontend);
  console.log(`[desktop] Frontend health check passed at ${healthUrl}; launching Electron.`);
  const electronPath = require("electron");
  const electron = start(electronPath, [desktopDirectory], {
    env: { ...process.env, OUTREACH_UI_URL: uiUrl },
    windowsHide: false
  });
  electron.once("exit", (code) => shutdown(code ?? 0));
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
main().catch((error) => {
  console.error(`[desktop] ${error instanceof Error ? error.message : error}`);
  shutdown(1);
});
