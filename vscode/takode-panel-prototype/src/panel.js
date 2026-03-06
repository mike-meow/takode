"use strict";

const DEFAULT_BASE_URL = "http://localhost:5174";

function normalizeBaseUrl(value) {
  let raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    raw = DEFAULT_BASE_URL;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Takode URL must use http:// or https://");
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]") {
    url.hostname = "localhost";
  }
  if (!url.pathname) {
    url.pathname = "/";
  }
  return url.toString();
}

function getHealthUrl(baseUrl) {
  return new URL("/api/health", baseUrl).toString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPanelHtml({ baseUrl, cspSource, nonce }) {
  const healthUrl = getHealthUrl(baseUrl);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data: http: https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; connect-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Takode</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: var(--vscode-font-family);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #0d1117;
        overflow: hidden;
      }

      body {
        position: relative;
      }

      .frame {
        border: 0;
        width: 100%;
        height: 100%;
        display: block;
        background: #0d1117;
      }

      .overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background:
          radial-gradient(circle at top, rgba(56, 139, 253, 0.12), transparent 45%),
          rgba(13, 17, 23, 0.88);
        color: #e6edf3;
        z-index: 2;
      }

      .overlay.hidden {
        display: none;
      }

      .card {
        width: min(520px, calc(100vw - 32px));
        padding: 20px;
        border: 1px solid rgba(240, 246, 252, 0.12);
        border-radius: 14px;
        background: rgba(22, 27, 34, 0.96);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      }

      .card h1 {
        margin: 0 0 10px;
        font-size: 16px;
        font-weight: 600;
      }

      .card p {
        margin: 0 0 12px;
        line-height: 1.45;
        color: #9da7b3;
      }

      .spinner {
        width: 26px;
        height: 26px;
        border-radius: 999px;
        border: 2px solid rgba(230, 237, 243, 0.2);
        border-top-color: #58a6ff;
        animation: spin 0.9s linear infinite;
        margin-right: 12px;
      }

      .row {
        display: flex;
        align-items: center;
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 16px;
      }

      button {
        border: 1px solid rgba(240, 246, 252, 0.12);
        border-radius: 10px;
        background: #212830;
        color: #e6edf3;
        padding: 9px 12px;
        font: inherit;
        cursor: pointer;
      }

      button:hover {
        background: #2a3441;
      }

      code {
        display: inline-block;
        max-width: 100%;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(240, 246, 252, 0.08);
        overflow-wrap: anywhere;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <iframe
      id="takode-frame"
      class="frame"
      title="Takode"
      allow="clipboard-read; clipboard-write"
      referrerpolicy="no-referrer"
    ></iframe>

    <div id="loading" class="overlay">
      <div class="card row">
        <div class="spinner" aria-hidden="true"></div>
        <div>
          <h1>Connecting to Takode</h1>
          <p>Loading <code id="loading-url"></code> inside this panel.</p>
        </div>
      </div>
    </div>

    <div id="error" class="overlay hidden">
      <div class="card">
        <h1>Takode is not reachable</h1>
        <p>This prototype expects the existing Takode web app to be running locally.</p>
        <p>Configured URL: <code id="error-url"></code></p>
        <div class="actions">
          <button id="retry-button" type="button">Retry</button>
          <button id="open-button" type="button">Open in Browser</button>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const baseUrl = ${JSON.stringify(baseUrl)};
      const healthUrl = ${JSON.stringify(healthUrl)};
      const frame = document.getElementById("takode-frame");
      const loading = document.getElementById("loading");
      const error = document.getElementById("error");
      const loadingUrl = document.getElementById("loading-url");
      const errorUrl = document.getElementById("error-url");
      const retryButton = document.getElementById("retry-button");
      const openButton = document.getElementById("open-button");
      let frameHasLoaded = false;
      let lastHealthOk = false;
      let latestSelectionPayload = null;

      loadingUrl.textContent = baseUrl;
      errorUrl.textContent = baseUrl;
      vscode.setState({ baseUrl });

      function updateOverlay() {
        loading.classList.toggle("hidden", frameHasLoaded || !lastHealthOk);
        error.classList.toggle("hidden", lastHealthOk);
      }

      function debug(text, data) {
        vscode.postMessage({
          type: "debug",
          text,
          data: typeof data === "undefined" ? null : data,
        });
      }

      function requestLatestSelectionContext() {
        debug("requestLatestSelectionContext");
        vscode.postMessage({ type: "readyForSelectionContext" });
      }

      function pushSelectionContextToFrame() {
        if (!frame.contentWindow) {
          debug("pushSelectionContextToFrame skipped: no contentWindow");
          return;
        }
        debug("pushSelectionContextToFrame", { payload: latestSelectionPayload });
        frame.contentWindow.postMessage({
          source: "takode-vscode-prototype",
          type: "takode:vscode-context",
          payload: latestSelectionPayload,
        }, "*");
      }

      async function ping() {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(healthUrl + "?t=" + Date.now(), {
            cache: "no-store",
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          lastHealthOk = response.ok;
        } catch (_error) {
          lastHealthOk = false;
        }
        debug("ping", { ok: lastHealthOk });
        updateOverlay();
      }

      function loadFrame() {
        frameHasLoaded = false;
        loading.classList.remove("hidden");
        error.classList.add("hidden");
        frame.src = baseUrl;
        debug("loadFrame", { baseUrl });
        void ping();
      }

      frame.addEventListener("load", () => {
        frameHasLoaded = true;
        debug("frame load");
        updateOverlay();
        pushSelectionContextToFrame();
        setTimeout(pushSelectionContextToFrame, 250);
        setTimeout(pushSelectionContextToFrame, 1000);
        requestLatestSelectionContext();
      });

      retryButton.addEventListener("click", () => {
        loadFrame();
      });

      openButton.addEventListener("click", () => {
        vscode.postMessage({ type: "openExternal", url: baseUrl });
      });

      window.addEventListener("message", (event) => {
        if (!event.data) {
          return;
        }

        if (
          event.source === frame.contentWindow &&
          event.data.source === "takode-vscode-prototype" &&
          event.data.type === "takode:vscode-ready"
        ) {
          debug("inner frame ready");
          requestLatestSelectionContext();
          pushSelectionContextToFrame();
          return;
        }

        if (event.data.type === "reload") {
          debug("received reload");
          loadFrame();
          return;
        }

        if (event.data.type === "selectionContext") {
          latestSelectionPayload = event.data.payload ?? null;
          debug("received selectionContext", { payload: latestSelectionPayload });
          pushSelectionContextToFrame();
        }
      });

      loadFrame();
      requestLatestSelectionContext();
      setInterval(() => void ping(), 10000);
    </script>
  </body>
</html>`;
}

module.exports = {
  DEFAULT_BASE_URL,
  buildPanelHtml,
  getHealthUrl,
  normalizeBaseUrl,
};
