import { getDefaultModelForBackend } from "../../shared/backend-defaults.js";
import type { SessionBackend } from "./sessions-helpers.js";

type SessionCreateModelLauncher = {
  getSession: (sessionId: string) => { backendType?: SessionBackend; model?: string } | undefined;
  resolveSessionId: (raw: string) => string | null;
};

type ResolveSessionCreateModelOptions = {
  backend: SessionBackend;
  createdBy?: unknown;
  getClaudeUserDefaultModel: () => Promise<string>;
  launcher: SessionCreateModelLauncher;
  requestedModel?: unknown;
};

export async function resolveSessionCreateModel({
  backend,
  createdBy,
  getClaudeUserDefaultModel,
  launcher,
  requestedModel,
}: ResolveSessionCreateModelOptions): Promise<string | undefined> {
  const explicitModel = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (explicitModel) return explicitModel;

  const creatorId =
    typeof createdBy === "string" && createdBy.trim() ? launcher.resolveSessionId(createdBy.trim()) : null;
  const creator = creatorId ? launcher.getSession(creatorId) : null;
  const creatorModel = typeof creator?.model === "string" ? creator.model.trim() : "";
  if (creatorModel && creator?.backendType === backend) {
    return creatorModel;
  }

  if (backend === "codex") {
    return getDefaultModelForBackend("codex");
  }

  if (backend === "claude" || backend === "claude-sdk") {
    return (await getClaudeUserDefaultModel()) || undefined;
  }

  return undefined;
}
