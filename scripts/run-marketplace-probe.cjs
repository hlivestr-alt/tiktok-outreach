const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repository = resolve(__dirname, "..");

function parseDotEnv(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(match[1], value);
  }
  return values;
}

function digest(value) {
  return value ? createHash("sha256").update(value).digest("hex") : "MISSING";
}

let repositoryEnv;
try {
  repositoryEnv = parseDotEnv(readFileSync(resolve(repository, ".env"), "utf8"));
} catch {
  console.error("Marketplace probe refused to start: repository .env is unavailable.");
  process.exit(1);
}

let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
} catch {
  // The probe remains usable, but records an unknown source revision.
}

const childEnvironment = {
  ...process.env,
  PROBE_EXPECTED_APP_KEY_SHA256: digest(repositoryEnv.get("TIKTOK_APP_KEY")),
  PROBE_EXPECTED_APP_SECRET_SHA256: digest(repositoryEnv.get("TIKTOK_APP_SECRET")),
  PROBE_EXPECTED_TOKEN_KEY_SHA256: digest(repositoryEnv.get("TIKTOK_TOKEN_ENCRYPTION_KEY")),
  PROBE_EXPECTED_API_BASE_SHA256: digest(repositoryEnv.get("TIKTOK_API_BASE_URL") || "https://open-api.tiktokglobalshop.com"),
  PROBE_SOURCE_GIT_SHA: gitSha
};

const completed = spawnSync(
  "docker",
  ["compose", "run", "--quiet-build", "--build", "--rm", "--no-deps", "marketplace-probe", ...process.argv.slice(2)],
  { cwd: repository, env: childEnvironment, stdio: "inherit", shell: false }
);

if (completed.error) {
  console.error("Marketplace probe could not launch its isolated Compose container.");
  process.exit(1);
}
process.exit(completed.status ?? 1);
