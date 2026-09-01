# TikTok Outreach desktop shell

This package wraps the existing Next.js UI in a secure Electron window. It does not host or rewrite the NestJS API, PostgreSQL, Redis, workers, crawler, or outbound behavior.

## Development

From the repository root:

```text
pnpm desktop:dev
```

The command reserves the Electron-only development port from `desktop-dev.json` (currently `http://127.0.0.1:3010`), starts Next.js on that exact port, and opens Electron only after that same origin's health route responds. It fails clearly instead of allowing Next.js to select a different port. The existing API/services must already be available.

The browser/Docker frontend remains on `http://127.0.0.1:3000`. Electron development does not attach to that port. The desktop package also verifies Electron's downloaded binary before launch and repairs a missing executable pointer without touching unrelated dependencies.

For development, browser API calls stay on the dedicated `3010` origin and Next.js proxies `/api/v1` to the existing local API at `http://127.0.0.1:4000`. Set `OUTREACH_API_URL` only when that local API endpoint is intentionally different; backend services and contracts are unchanged.

## Build and package

```text
pnpm desktop:build
pnpm desktop:package
```

`desktop:build` compiles the main/preload processes and creates the neutral TO icon assets. `desktop:package` creates an unpacked Windows application under `apps/desktop/release/win-unpacked`. Installer creation is available through `pnpm --filter @affiliate/desktop dist`; no signing or publishing is configured.

Production packages remain desktop clients for the existing local service. The default URL is `http://127.0.0.1:3000`; deployment may set `OUTREACH_UI_URL` without changing renderer API behavior.
