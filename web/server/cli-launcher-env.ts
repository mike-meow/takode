export const NON_INTERACTIVE_GIT_EDITOR_ENV_KEYS = ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR"] as const;

export function stripInheritedTelemetryEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const stripped: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("OTEL_")) continue;
    stripped[key] = value;
  }
  return stripped;
}

export function withNonInteractiveGitEditorEnv(env: Record<string, string>): Record<string, string>;
export function withNonInteractiveGitEditorEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function withNonInteractiveGitEditorEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
}
