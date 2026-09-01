const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");

const electronPackagePath = require.resolve("electron/package.json");
const electronDirectory = dirname(electronPackagePath);
const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
const platformExecutable = process.platform === "win32"
  ? "electron.exe"
  : process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : "electron";
const distDirectory = join(electronDirectory, "dist");
const executablePath = join(distDirectory, platformExecutable);
const versionPath = join(distDirectory, "version");
const pointerPath = join(electronDirectory, "path.txt");

function distributionIsComplete() {
  if (!existsSync(executablePath) || !existsSync(versionPath)) return false;
  return readFileSync(versionPath, "utf8").trim().replace(/^v/, "") === electronPackage.version;
}

async function ensureElectron() {
  if (distributionIsComplete()) {
    if (!existsSync(pointerPath) || readFileSync(pointerPath, "utf8") !== platformExecutable) {
      writeFileSync(pointerPath, platformExecutable);
      console.log(`[desktop] Repaired Electron executable pointer: ${platformExecutable}`);
    }
    return;
  }

  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    throw new Error("Electron's binary is missing, but ELECTRON_SKIP_BINARY_DOWNLOAD is set.");
  }

  const electronRequire = createRequire(electronPackagePath);
  const { downloadArtifact } = electronRequire("@electron/get");
  const extract = electronRequire("extract-zip");
  const archivePath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    checksums: JSON.parse(readFileSync(join(electronDirectory, "checksums.json"), "utf8"))
  });

  rmSync(distDirectory, { recursive: true, force: true });
  await extract(archivePath, { dir: distDirectory });
  if (!distributionIsComplete()) throw new Error("Electron archive extraction completed without a valid executable.");
  writeFileSync(pointerPath, platformExecutable);
  console.log(`[desktop] Installed Electron ${electronPackage.version} for ${process.platform}-${process.arch}.`);
}

ensureElectron().catch((error) => {
  console.error(`[desktop] Unable to prepare Electron: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
