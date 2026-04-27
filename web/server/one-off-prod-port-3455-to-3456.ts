import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Socket } from "node:net";

export interface OneOffProdPortMigrationOptions {
  companionHome?: string;
  sourcePort?: number;
  targetPort?: number;
  backupRoot?: string;
  apply?: boolean;
  now?: Date;
}

export interface OneOffProdPortMigrationPlan {
  companionHome: string;
  sourcePort: number;
  targetPort: number;
  backupDir: string;
  sourceServerId: string;
  targetServerId?: string;
  sourceSettingsPath: string;
  sourceSecretsPath: string;
  sourceSessionsDir: string;
  sourceSessionsFileCount: number;
  sourceTreeGroupsPath: string;
  targetSettingsPath: string;
  targetSecretsPath: string;
  targetSessionsDir: string;
  targetSessionsFileCount: number;
  targetLegacyTreeGroupsPath: string;
  targetLegacyTreeGroupsExists: boolean;
  sourceSessionAuthPaths: string[];
  targetSessionAuthPaths: string[];
  pushoverBaseUrlBefore?: string;
  pushoverBaseUrlAfter?: string;
  willPatchPushoverBaseUrl: boolean;
  notes: string[];
}

export interface OneOffProdPortMigrationResult {
  applied: boolean;
  plan: OneOffProdPortMigrationPlan;
  manifestPath?: string;
  rollbackScriptPath?: string;
  rewrittenSessionAuthCount: number;
}

export async function inspectOneOffProdPort3455To3456Migration(
  options: OneOffProdPortMigrationOptions = {},
): Promise<OneOffProdPortMigrationPlan> {
  const resolved = resolveOptions(options);
  const notes: string[] = [];

  const sourceSettingsPath = settingsPath(resolved.companionHome, resolved.sourcePort);
  const sourceSettings = await readRequiredSettings(sourceSettingsPath, "source");
  const sourceServerId = getRequiredServerId(sourceSettings, "source");

  const targetSettingsPath = settingsPath(resolved.companionHome, resolved.targetPort);
  const targetSettings = await readOptionalSettings(targetSettingsPath);
  const targetServerId = getOptionalServerId(targetSettings);

  const sourceSessionsDir = sessionsPath(resolved.companionHome, resolved.sourcePort);
  const sourceSessionsFileCount = await countFiles(sourceSessionsDir);
  if (sourceSessionsFileCount === 0) {
    throw new Error(`Expected source sessions under ${sourceSessionsDir}, but the directory is empty.`);
  }

  const targetSessionsDir = sessionsPath(resolved.companionHome, resolved.targetPort);
  const targetSessionsFileCount = await countFiles(targetSessionsDir);

  const sourceTreeGroupsPath = join(resolved.companionHome, "tree-groups", `${sourceServerId}.json`);
  if (!(await pathExists(sourceTreeGroupsPath))) {
    throw new Error(
      `Expected source tree-group state at ${sourceTreeGroupsPath}. Refusing to migrate without that continuity artifact.`,
    );
  }

  const targetLegacyTreeGroupsPath = join(resolved.companionHome, "tree-groups.json");
  const targetLegacyTreeGroupsExists = await pathExists(targetLegacyTreeGroupsPath);
  if (!targetLegacyTreeGroupsExists) {
    notes.push("No legacy target tree-groups.json was found. The script will skip that backup.");
  }

  const sourceSessionAuthPaths = await listSessionAuthPaths(resolved.companionHome, sourceServerId);
  if (sourceSessionAuthPaths.length === 0) {
    notes.push("No source session-auth files were found for the 3455 serverId.");
  }

  const targetSessionAuthPaths = targetServerId
    ? await listSessionAuthPaths(resolved.companionHome, targetServerId)
    : [];
  if (!targetServerId) {
    notes.push(
      "No target serverId was found in settings-3456.json, so there are no target session-auth files to back up.",
    );
  }

  const sourceSecretsPath = settingsSecretsPath(resolved.companionHome, resolved.sourcePort);
  if (!(await pathExists(sourceSecretsPath))) {
    notes.push(`No source secrets file was found at ${sourceSecretsPath}.`);
  }

  const targetSecretsPath = settingsSecretsPath(resolved.companionHome, resolved.targetPort);
  const pushoverBaseUrlBefore = getOptionalString(sourceSettings, "pushoverBaseUrl");
  const pushoverBaseUrlAfter = patchPushoverBaseUrl(pushoverBaseUrlBefore, resolved.sourcePort, resolved.targetPort);
  const willPatchPushoverBaseUrl = pushoverBaseUrlBefore !== pushoverBaseUrlAfter;
  if (!willPatchPushoverBaseUrl) {
    notes.push("Source pushoverBaseUrl did not need a 3455 -> 3456 rewrite.");
  }

  return {
    companionHome: resolved.companionHome,
    sourcePort: resolved.sourcePort,
    targetPort: resolved.targetPort,
    backupDir: join(
      resolved.backupRoot,
      `${resolved.sourcePort}-to-${resolved.targetPort}-${formatTimestamp(resolved.now)}`,
    ),
    sourceServerId,
    ...(targetServerId ? { targetServerId } : {}),
    sourceSettingsPath,
    sourceSecretsPath,
    sourceSessionsDir,
    sourceSessionsFileCount,
    sourceTreeGroupsPath,
    targetSettingsPath,
    targetSecretsPath,
    targetSessionsDir,
    targetSessionsFileCount,
    targetLegacyTreeGroupsPath,
    targetLegacyTreeGroupsExists,
    sourceSessionAuthPaths,
    targetSessionAuthPaths,
    ...(pushoverBaseUrlBefore ? { pushoverBaseUrlBefore } : {}),
    ...(pushoverBaseUrlAfter ? { pushoverBaseUrlAfter } : {}),
    willPatchPushoverBaseUrl,
    notes,
  };
}

export async function runOneOffProdPort3455To3456Migration(
  options: OneOffProdPortMigrationOptions = {},
): Promise<OneOffProdPortMigrationResult> {
  const resolved = resolveOptions(options);
  const plan = await inspectOneOffProdPort3455To3456Migration(options);
  if (!resolved.apply) {
    return { applied: false, plan, rewrittenSessionAuthCount: 0 };
  }

  await assertPortInactive(resolved.sourcePort);
  await assertPortInactive(resolved.targetPort);

  await mkdir(plan.backupDir, { recursive: true });
  await backupArtifacts(plan);

  const sourceSettings = await readRequiredSettings(plan.sourceSettingsPath, "source");
  const migratedSettings = {
    ...sourceSettings,
    ...(plan.willPatchPushoverBaseUrl ? { pushoverBaseUrl: plan.pushoverBaseUrlAfter ?? "" } : {}),
  };
  await writeJson(plan.targetSettingsPath, migratedSettings);

  if (await pathExists(plan.sourceSecretsPath)) {
    await copyPath(plan.sourceSecretsPath, plan.targetSecretsPath);
  } else {
    await removePathIfExists(plan.targetSecretsPath);
  }

  await replaceDirectory(plan.sourceSessionsDir, plan.targetSessionsDir);
  const rewrittenSessionAuthCount = await rewriteSessionAuthPorts(plan.sourceSessionAuthPaths, resolved.targetPort);

  const manifestPath = join(plan.backupDir, "migration-manifest.json");
  const rollbackScriptPath = join(plan.backupDir, "rollback.sh");
  await writeJson(manifestPath, {
    kind: "one-off-prod-port-migration",
    sourcePort: plan.sourcePort,
    targetPort: plan.targetPort,
    sourceServerId: plan.sourceServerId,
    targetServerId: plan.targetServerId ?? null,
    backupDir: plan.backupDir,
    rewrittenSessionAuthCount,
    generatedAt: resolved.now.toISOString(),
    plan,
  });
  await writeFile(rollbackScriptPath, buildRollbackScript(plan), { encoding: "utf-8", mode: 0o755 });

  return {
    applied: true,
    plan,
    manifestPath,
    rollbackScriptPath,
    rewrittenSessionAuthCount,
  };
}

type JsonRecord = Record<string, unknown>;

function resolveOptions(options: OneOffProdPortMigrationOptions): Required<OneOffProdPortMigrationOptions> {
  const companionHome = options.companionHome ?? join(homedir(), ".companion");
  const sourcePort = options.sourcePort ?? 3455;
  const targetPort = options.targetPort ?? 3456;
  return {
    companionHome,
    sourcePort,
    targetPort,
    backupRoot: options.backupRoot ?? join(companionHome, "port-migrations"),
    apply: options.apply ?? false,
    now: options.now ?? new Date(),
  };
}

function settingsPath(companionHome: string, port: number): string {
  return join(companionHome, `settings-${port}.json`);
}

function settingsSecretsPath(companionHome: string, port: number): string {
  return join(companionHome, `settings-secrets-${port}.json`);
}

function sessionsPath(companionHome: string, port: number): string {
  return join(companionHome, "sessions", String(port));
}

function getOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getRequiredServerId(settings: JsonRecord, label: string): string {
  const serverId = getOptionalString(settings, "serverId")?.trim();
  if (!serverId) {
    throw new Error(`Expected a non-empty serverId in the ${label} settings file.`);
  }
  return serverId;
}

function getOptionalServerId(settings: JsonRecord | null): string | undefined {
  return settings ? getOptionalString(settings, "serverId")?.trim() || undefined : undefined;
}

function patchPushoverBaseUrl(value: string | undefined, sourcePort: number, targetPort: number): string | undefined {
  if (!value) return value;
  const pattern = new RegExp(`^(https?://(?:localhost|127\\.0\\.0\\.1)):${sourcePort}(/.*)?$`);
  const match = value.match(pattern);
  if (!match) return value;
  return `${match[1]}:${targetPort}${match[2] ?? ""}`;
}

function formatTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[:]/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildRollbackScript(plan: OneOffProdPortMigrationPlan): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `BACKUP_DIR=${shellQuote(plan.backupDir)}`,
    `COMPANION_HOME=${shellQuote(plan.companionHome)}`,
    "",
    `echo "Rollback: restoring pre-migration 3456 state from ${plan.backupDir}"`,
    `echo "Stop any server listening on port ${plan.targetPort} before continuing."`,
    "",
    `mkdir -p "$COMPANION_HOME/sessions"`,
    `rm -rf "$COMPANION_HOME/sessions/${plan.targetPort}"`,
    `if [ -d "$BACKUP_DIR/target/sessions/${plan.targetPort}" ]; then`,
    `  cp -R "$BACKUP_DIR/target/sessions/${plan.targetPort}" "$COMPANION_HOME/sessions/${plan.targetPort}"`,
    "fi",
    `if [ -f "$BACKUP_DIR/target/settings-${plan.targetPort}.json" ]; then`,
    `  cp "$BACKUP_DIR/target/settings-${plan.targetPort}.json" "$COMPANION_HOME/settings-${plan.targetPort}.json"`,
    "fi",
    `if [ -f "$BACKUP_DIR/target/settings-secrets-${plan.targetPort}.json" ]; then`,
    `  cp "$BACKUP_DIR/target/settings-secrets-${plan.targetPort}.json" "$COMPANION_HOME/settings-secrets-${plan.targetPort}.json"`,
    "else",
    `  rm -f "$COMPANION_HOME/settings-secrets-${plan.targetPort}.json"`,
    "fi",
    `if [ -f "$BACKUP_DIR/target/tree-groups.json" ]; then`,
    `  cp "$BACKUP_DIR/target/tree-groups.json" "$COMPANION_HOME/tree-groups.json"`,
    "fi",
    `mkdir -p "$COMPANION_HOME/session-auth"`,
    `if [ -d "$BACKUP_DIR/target/session-auth" ]; then`,
    `  cp "$BACKUP_DIR"/target/session-auth/*.json "$COMPANION_HOME/session-auth/" 2>/dev/null || true`,
    "fi",
    `if [ -d "$BACKUP_DIR/source/session-auth" ]; then`,
    `  cp "$BACKUP_DIR"/source/session-auth/*.json "$COMPANION_HOME/session-auth/" 2>/dev/null || true`,
    "fi",
    "",
    `echo "Rollback restore complete."`,
    `echo "From the repo root, restart the old 3455 server with: cd web && PORT=${plan.sourcePort} bun run start"`,
  ];
  return `${lines.join("\n")}\n`;
}

async function readRequiredSettings(path: string, label: string): Promise<JsonRecord> {
  const settings = await readOptionalSettings(path);
  if (!settings) {
    throw new Error(`Expected the ${label} settings file at ${path}.`);
  }
  return settings;
}

async function readOptionalSettings(path: string): Promise<JsonRecord | null> {
  if (!(await pathExists(path))) return null;
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object settings at ${path}.`);
  }
  return parsed as JsonRecord;
}

async function countFiles(path: string): Promise<number> {
  if (!(await pathExists(path))) return 0;
  const pathStat = await stat(path);
  if (!pathStat.isDirectory()) return 1;
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await countFiles(join(path, entry.name));
  }
  return total;
}

async function listSessionAuthPaths(companionHome: string, serverId: string): Promise<string[]> {
  const sessionAuthDir = join(companionHome, "session-auth");
  if (!(await pathExists(sessionAuthDir))) return [];
  const entries = await readdir(sessionAuthDir);
  return entries
    .filter((entry) => entry.endsWith(`-${serverId}.json`))
    .sort()
    .map((entry) => join(sessionAuthDir, entry));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function backupArtifacts(plan: OneOffProdPortMigrationPlan): Promise<void> {
  await backupPath(plan.sourceSettingsPath, join(plan.backupDir, "source", `settings-${plan.sourcePort}.json`));
  await backupPath(plan.sourceSecretsPath, join(plan.backupDir, "source", `settings-secrets-${plan.sourcePort}.json`));
  await backupPath(plan.sourceSessionsDir, join(plan.backupDir, "source", "sessions", String(plan.sourcePort)));
  await backupPath(
    plan.sourceTreeGroupsPath,
    join(plan.backupDir, "source", "tree-groups", `${plan.sourceServerId}.json`),
  );
  await backupPaths(plan.sourceSessionAuthPaths, join(plan.backupDir, "source", "session-auth"));

  await backupPath(plan.targetSettingsPath, join(plan.backupDir, "target", `settings-${plan.targetPort}.json`));
  await backupPath(plan.targetSecretsPath, join(plan.backupDir, "target", `settings-secrets-${plan.targetPort}.json`));
  await backupPath(plan.targetSessionsDir, join(plan.backupDir, "target", "sessions", String(plan.targetPort)));
  if (plan.targetLegacyTreeGroupsExists) {
    await backupPath(plan.targetLegacyTreeGroupsPath, join(plan.backupDir, "target", "tree-groups.json"));
  }
  await backupPaths(plan.targetSessionAuthPaths, join(plan.backupDir, "target", "session-auth"));
}

async function backupPaths(sourcePaths: string[], backupDir: string): Promise<void> {
  for (const sourcePath of sourcePaths) {
    await backupPath(sourcePath, join(backupDir, basename(sourcePath)));
  }
}

async function backupPath(sourcePath: string, backupPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) return;
  await copyPath(sourcePath, backupPath);
}

async function copyPath(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

async function removePathIfExists(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  await rm(path, { recursive: true, force: true });
}

async function replaceDirectory(sourcePath: string, targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

async function rewriteSessionAuthPorts(paths: string[], targetPort: number): Promise<number> {
  let rewritten = 0;
  for (const path of paths) {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected session-auth JSON object at ${path}.`);
    }
    const next = { ...(parsed as JsonRecord), port: targetPort };
    await writeJson(path, next);
    rewritten += 1;
  }
  return rewritten;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  const serialized = JSON.stringify(data, null, 2);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, serialized, "utf-8");
  await rename(tempPath, path);
}

async function assertPortInactive(port: number): Promise<void> {
  const active = await isPortActive(port);
  if (active) {
    throw new Error(`Port ${port} is still listening. Stop the live server before applying the migration.`);
  }
}

async function isPortActive(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}
