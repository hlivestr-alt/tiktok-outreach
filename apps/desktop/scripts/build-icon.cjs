const sharp = require("sharp");
const { copyFile, mkdir } = require("node:fs/promises");
const { join } = require("node:path");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="92" fill="#111111"/>
  <rect x="34" y="34" width="444" height="444" rx="66" fill="none" stroke="#343434" stroke-width="4"/>
  <path d="M122 156h268v48H280v152h-48V204H122z" fill="#F5F5F5"/>
  <circle cx="367" cy="335" r="23" fill="#A1A1AA"/>
</svg>`;

async function main() {
  const root = join(__dirname, "..");
  await Promise.all([mkdir(join(root, "build"), { recursive: true }), mkdir(join(root, "resources"), { recursive: true }), mkdir(join(root, "dist"), { recursive: true })]);
  await Promise.all([
    sharp(Buffer.from(svg)).png().resize(512, 512).toFile(join(root, "build", "icon.png")),
    sharp(Buffer.from(svg)).png().resize(256, 256).toFile(join(root, "resources", "icon.png")),
    copyFile(join(root, "src", "startup-error.html"), join(root, "dist", "startup-error.html"))
  ]);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
