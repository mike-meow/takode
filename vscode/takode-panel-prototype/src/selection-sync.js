"use strict";

const REQUEST_TIMEOUT_MS = 4000;

function normalizeBaseUrlForApi(baseUrl) {
  const url = new URL(String(baseUrl));
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildApiUrl(baseUrl, suffix) {
  const url = new URL(normalizeBaseUrlForApi(baseUrl));
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${suffix}`;
  return url.toString();
}

function getSelectionApiUrl(baseUrl) {
  return buildApiUrl(baseUrl, "/api/vscode/selection");
}

function getVsCodeWindowsApiUrl(baseUrl) {
  return buildApiUrl(baseUrl, "/api/vscode/windows");
}

function getVsCodeWindowCommandsApiUrl(baseUrl, sourceId) {
  return buildApiUrl(baseUrl, `/api/vscode/windows/${encodeURIComponent(sourceId)}/commands`);
}

function getVsCodeCommandResultApiUrl(baseUrl, sourceId, commandId) {
  return buildApiUrl(
    baseUrl,
    `/api/vscode/windows/${encodeURIComponent(sourceId)}/commands/${encodeURIComponent(commandId)}/result`,
  );
}

function dedupeApiUrls(baseUrls, buildUrl) {
  const out = [];
  const seen = new Set();
  for (const baseUrl of baseUrls || []) {
    if (typeof baseUrl !== "string" || !baseUrl) {
      continue;
    }
    const apiUrl = buildUrl(baseUrl);
    if (seen.has(apiUrl)) continue;
    seen.add(apiUrl);
    out.push({ baseUrl, apiUrl });
  }
  return out;
}

function buildSelectionSyncPayload(selection, sourceInfo, updatedAt = Date.now()) {
  return {
    selection: selection
      ? {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        endLine: selection.endLine,
        lineCount: selection.lineCount,
      }
      : null,
    updatedAt,
    sourceId: sourceInfo.sourceId,
    sourceType: sourceInfo.sourceType,
    ...(sourceInfo.sourceLabel ? { sourceLabel: sourceInfo.sourceLabel } : {}),
  };
}

function buildWindowStatePayload(windowState, sourceInfo, updatedAt = Date.now()) {
  return {
    sourceId: sourceInfo.sourceId,
    sourceType: sourceInfo.sourceType,
    ...(sourceInfo.sourceLabel ? { sourceLabel: sourceInfo.sourceLabel } : {}),
    workspaceRoots: Array.isArray(windowState.workspaceRoots)
      ? windowState.workspaceRoots.filter((root) => typeof root === "string" && root)
      : [],
    updatedAt,
    lastActivityAt: Number.isFinite(windowState.lastActivityAt) ? windowState.lastActivityAt : updatedAt,
  };
}

function getSelectionFingerprint(selection, sourceInfo, urls) {
  return JSON.stringify({
    selection: selection
      ? {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        endLine: selection.endLine,
        lineCount: selection.lineCount,
      }
      : null,
    sourceId: sourceInfo.sourceId,
    sourceType: sourceInfo.sourceType,
    sourceLabel: sourceInfo.sourceLabel || null,
    urls: urls.map(({ apiUrl }) => apiUrl),
  });
}

function getWindowFingerprint(windowState, sourceInfo, urls) {
  return JSON.stringify({
    sourceId: sourceInfo.sourceId,
    sourceType: sourceInfo.sourceType,
    sourceLabel: sourceInfo.sourceLabel || null,
    workspaceRoots: Array.isArray(windowState.workspaceRoots) ? [...windowState.workspaceRoots] : [],
    urls: urls.map(({ apiUrl }) => apiUrl),
  });
}

async function postJson(fetchImpl, apiUrl, payload) {
  return fetchImpl(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function selectionStateMatches(selectionState, selection, sourceInfo) {
  if (selectionState == null) {
    return selection === null;
  }
  if (!selectionState || typeof selectionState !== "object") {
    return false;
  }

  const serverSourceLabel = typeof selectionState.sourceLabel === "string" ? selectionState.sourceLabel : null;
  if (
    selectionState.sourceId !== sourceInfo.sourceId
    || selectionState.sourceType !== sourceInfo.sourceType
    || serverSourceLabel !== (sourceInfo.sourceLabel || null)
  ) {
    return false;
  }

  if (selection === null) {
    return selectionState.selection === null;
  }

  const serverSelection = selectionState.selection;
  if (!serverSelection || typeof serverSelection !== "object") {
    return false;
  }

  return (
    serverSelection.absolutePath === selection.absolutePath
    && serverSelection.startLine === selection.startLine
    && serverSelection.endLine === selection.endLine
    && serverSelection.lineCount === selection.lineCount
  );
}

async function shouldRepublishSelection(fetchImpl, urls, selection, sourceInfo, logDebug) {
  for (const { apiUrl } of urls) {
    try {
      const response = await fetchImpl(apiUrl, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logDebug("selectionSync revalidate failed", { apiUrl, status: response.status });
        return true;
      }
      const body = await response.json().catch(() => ({}));
      if (!selectionStateMatches(body?.state, selection, sourceInfo)) {
        logDebug("selectionSync revalidate missing state", { apiUrl });
        return true;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      logDebug("selectionSync revalidate error", { apiUrl, error: text });
      return true;
    }
  }
  return false;
}

function createSelectionSyncManager({
  fetchImpl = fetch,
  getBaseUrls,
  getSourceInfo,
  getWorkspaceRoots = () => [],
  openFile = async () => {},
  logDebug = () => {},
}) {
  let lastSelectionFingerprint = null;
  let lastWindowFingerprint = null;

  async function publishSelection(selection, options = {}) {
    const sourceInfo = getSourceInfo();
    const urls = dedupeApiUrls(getBaseUrls(), getSelectionApiUrl);
    const fingerprint = getSelectionFingerprint(selection, sourceInfo, urls);
    const isUnchanged = !options.force && fingerprint === lastSelectionFingerprint;
    if (isUnchanged) {
      if (!options.revalidate) {
        return false;
      }
      const needsRepublish = await shouldRepublishSelection(fetchImpl, urls, selection, sourceInfo, logDebug);
      if (!needsRepublish) {
        return false;
      }
    }

    if (urls.length === 0) {
      logDebug("selectionSync skipped: no configured base URLs");
      return false;
    }

    const payload = buildSelectionSyncPayload(selection, sourceInfo, Date.now());
    let successCount = 0;
    await Promise.all(urls.map(async ({ apiUrl }) => {
      try {
        const response = await postJson(fetchImpl, apiUrl, payload);
        if (!response.ok) {
          logDebug("selectionSync publish failed", { apiUrl, status: response.status });
          return;
        }
        successCount += 1;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logDebug("selectionSync publish error", { apiUrl, error: text });
      }
    }));

    if (successCount > 0) {
      lastSelectionFingerprint = fingerprint;
    }

    return successCount > 0;
  }

  async function publishWindow(options = {}) {
    const sourceInfo = getSourceInfo();
    const urls = dedupeApiUrls(getBaseUrls(), getVsCodeWindowsApiUrl);
    const windowState = {
      workspaceRoots: getWorkspaceRoots(),
      lastActivityAt: Number.isFinite(options.lastActivityAt) ? options.lastActivityAt : Date.now(),
    };
    const fingerprint = getWindowFingerprint(windowState, sourceInfo, urls);
    if (!options.force && fingerprint === lastWindowFingerprint) {
      return false;
    }

    if (urls.length === 0) {
      logDebug("windowSync skipped: no configured base URLs");
      return false;
    }

    const payload = buildWindowStatePayload(windowState, sourceInfo, Date.now());
    let successCount = 0;
    await Promise.all(urls.map(async ({ apiUrl }) => {
      try {
        const response = await postJson(fetchImpl, apiUrl, payload);
        if (!response.ok) {
          logDebug("windowSync publish failed", { apiUrl, status: response.status });
          return;
        }
        successCount += 1;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logDebug("windowSync publish error", { apiUrl, error: text });
      }
    }));

    if (successCount > 0) {
      lastWindowFingerprint = fingerprint;
    }

    return successCount > 0;
  }

  async function pollCommands() {
    const sourceInfo = getSourceInfo();
    const urls = dedupeApiUrls(
      getBaseUrls(),
      (baseUrl) => getVsCodeWindowCommandsApiUrl(baseUrl, sourceInfo.sourceId),
    );
    for (const { baseUrl, apiUrl } of urls) {
      try {
        const response = await fetchImpl(apiUrl, {
          method: "GET",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          logDebug("windowSync poll failed", { apiUrl, status: response.status });
          continue;
        }
        const body = await response.json().catch(() => ({ commands: [] }));
        const commands = Array.isArray(body?.commands) ? body.commands : [];
        for (const command of commands) {
          const resultUrl = getVsCodeCommandResultApiUrl(baseUrl, sourceInfo.sourceId, command.commandId);
          try {
            await openFile(command.target);
            await postJson(fetchImpl, resultUrl, { ok: true });
            await publishWindow({ force: true, lastActivityAt: Date.now() });
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            await postJson(fetchImpl, resultUrl, { ok: false, error: text });
            await publishWindow({ force: true, lastActivityAt: Date.now() });
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logDebug("windowSync poll error", { apiUrl, error: text });
      }
    }
  }

  return {
    publishSelection,
    publishWindow,
    pollCommands,
    buildSelectionSyncPayload: (selection) => buildSelectionSyncPayload(selection, getSourceInfo(), Date.now()),
    buildWindowStatePayload: (windowState) => buildWindowStatePayload(windowState, getSourceInfo(), Date.now()),
  };
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  getSelectionApiUrl,
  getVsCodeWindowsApiUrl,
  getVsCodeWindowCommandsApiUrl,
  getVsCodeCommandResultApiUrl,
  buildSelectionSyncPayload,
  buildWindowStatePayload,
  createSelectionSyncManager,
};
