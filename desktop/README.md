# Takode Desktop (macOS)

A Tauri v2 desktop wrapper that produces a self-contained `.app` bundle for macOS.
The app bundles the Bun runtime and the pre-built web app, launches the Hono server
as a sidecar process, and opens a native WebKit webview pointed at `localhost:3456`.

## Prerequisites (build-time only)

The resulting `.app` is self-contained — these are only needed to **build**:

- **Rust** — install via [rustup.rs](https://rustup.rs)
- **Xcode Command Line Tools** — `xcode-select --install`
- **Bun** — [bun.sh](https://bun.sh)
- **Tauri CLI v2** — `cargo install tauri-cli@^2`

## Build

```bash
cd desktop
chmod +x build.sh
./build.sh
```

The `.app` bundle will be produced at:

```
desktop/src-tauri/target/release/bundle/macos/Takode.app
```

## Run

```bash
open desktop/src-tauri/target/release/bundle/macos/Takode.app
```

Or double-click the `.app` in Finder.

## Architecture

```
Takode.app
├── bun (bundled sidecar binary)
├── web/ (pre-built Hono server + React SPA + node_modules)
└── Tauri native shell (Rust)
    └── on launch: spawns `bun run start` in web/
    └── webview → http://localhost:3456
    └── on quit: kills bun process
```

## Notes

- **Ad-hoc signed** — not notarized. macOS may show a Gatekeeper warning on first launch;
  right-click → Open to bypass.
- **arm64 only** — the bundled `bun` binary matches your build machine architecture.
  Cross-compilation is not currently supported.
- **Port 3456** must be free on the user's machine.
- **Zero changes to `web/`** — the web stack is bundled as-is.
