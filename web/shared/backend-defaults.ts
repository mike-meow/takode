import type { BackendType } from "../server/session-types.js";
import { assertNever } from "../server/session-types.js";

export type BackendFamily = "claude" | "codex";

export const DEFAULT_MODEL_BY_BACKEND_FAMILY: Record<BackendFamily, string> = {
  claude: "",
  codex: "gpt-5.4",
};

export function getBackendFamily(backend: BackendType): BackendFamily {
  switch (backend) {
    case "claude":
    case "claude-sdk":
      return "claude";
    case "codex":
      return "codex";
    default:
      return assertNever(backend);
  }
}

export function getDefaultModelForBackendFamily(family: BackendFamily): string {
  return DEFAULT_MODEL_BY_BACKEND_FAMILY[family];
}

export function getDefaultModelForBackend(backend: BackendType): string {
  return getDefaultModelForBackendFamily(getBackendFamily(backend));
}
