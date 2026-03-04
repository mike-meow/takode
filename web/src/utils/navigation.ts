import { navigateToSession as navigateToSessionById } from "./routing.js";

function normalizeHashPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "#" || trimmed === "#/" || trimmed === "/") {
    return "";
  }

  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    return `#${trimmed}`;
  }

  return `#/${trimmed}`;
}

export function navigateTo(path: string, replace = false): void {
  const normalized = normalizeHashPath(path);

  if (replace) {
    if (normalized) {
      history.replaceState(null, "", normalized);
    } else {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }

  if (normalized) {
    window.location.hash = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  } else {
    window.location.hash = "";
  }
}

export function navigateToSession(sessionId: string, replace = false): void {
  navigateToSessionById(sessionId, replace);
}
