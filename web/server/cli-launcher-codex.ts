import {
  mkdir,
  access,
  copyFile,
  cp,
  readFile,
  realpath,
  writeFile,
  unlink,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { getLegacyCodexHome, resolveCompanionCodexHome, resolveCompanionCodexSessionHome } from "./codex-home.js";
import { resolveBinary, getEnrichedPath, captureUserShellEnv, captureUserShellPath } from "./path-resolver.js";
import { sessionTag } from "./session-tag.js";

const shellEnvPolicySection = "shell_environment_policy";
const shellEnvPolicyHeader = `[${shellEnvPolicySection}]`;
const codexFeaturesHeader = "[features]";
const codexMultiAgentFeature = "multi_agent";
const dotslashShebang = "#!/usr/bin/env dotslash";
const codexBootstrapCacheMarker = 'CACHE_DIR = os.path.expanduser("~/.cache/codex")';
const nodeShebangRe = /^#!.*\bnode(?:\s|$)/;

type HostCodexBinaryKind = "native" | "dotslash" | "bootstrap";

export class MissingCodexBinaryError extends Error {}

interface CodexLaunchInfo {
  cwd: string;
  cliSessionId?: string;
}

interface CodexLaunchOptions {
  codexBinary?: string;
  permissionMode?: string;
  askPermission?: boolean;
  codexSandbox?: "workspace-write" | "danger-full-access";
  codexInternetAccess?: boolean;
  codexReasoningEffort?: string;
  codexHome?: string;
  containerId?: string;
  env?: Record<string, string>;
  resumeCliSessionId?: string;
}

export interface CodexSpawnSpec {
  spawnCmd: string[];
  spawnEnv: Record<string, string | undefined>;
  spawnCwd: string | undefined;
  sandboxMode: "workspace-write" | "danger-full-access";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mapCodexApprovalPolicy(permissionMode?: string, askPermission?: boolean): "never" | "untrusted" {
  const effectiveAskPermission =
    typeof askPermission === "boolean" ? askPermission : permissionMode !== "bypassPermissions";
  if (!effectiveAskPermission) return "never";
  return permissionMode === "bypassPermissions" ? "never" : "untrusted";
}

function resolveCodexSandbox(
  permissionMode?: string,
  requested?: "workspace-write" | "danger-full-access",
): "workspace-write" | "danger-full-access" {
  if (requested) return requested;
  return permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write";
}

function mergeUniqueStrings(existing: string[], additions: string[]): string[] {
  const merged = [...existing];
  for (const value of additions) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

function extractQuotedStrings(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out.push(match[1].replace(/\\"/g, '"'));
  }
  return out;
}

function renderIncludeOnlyArray(vars: string[]): string[] {
  return ["include_only = [", ...vars.map((v) => `    "${v}",`), "]"];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergePathStrings(paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const pathValue of paths) {
    for (const entry of (pathValue || "").split(":")) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(":");
}

function upsertShellEnvironmentIncludeOnly(configToml: string, requiredVars: string[]): string {
  if (requiredVars.length === 0) return configToml;
  const normalizedRequired = Array.from(new Set(requiredVars)).sort();
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === shellEnvPolicyHeader.toLowerCase());
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(shellEnvPolicyHeader);
    out.push(...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let includeStart = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/^\s*include_only\s*=\s*\[/.test(lines[i])) {
      includeStart = i;
      break;
    }
  }

  if (includeStart === -1) {
    const out = [...lines];
    out.splice(sectionStart + 1, 0, ...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline ? "\n" : "");
  }

  let includeEnd = includeStart;
  while (includeEnd < sectionEnd) {
    if (lines[includeEnd].includes("]")) break;
    includeEnd++;
  }
  if (includeEnd >= sectionEnd) includeEnd = includeStart;

  const includeBlock = lines.slice(includeStart, includeEnd + 1).join("\n");
  const existingVars = extractQuotedStrings(includeBlock);
  const mergedVars = mergeUniqueStrings(existingVars, normalizedRequired);
  const replacement = renderIncludeOnlyArray(mergedVars);
  const out = [...lines];
  out.splice(includeStart, includeEnd - includeStart + 1, ...replacement);
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

function upsertBooleanSettingInSection(configToml: string, sectionHeader: string, key: string, value: boolean): string {
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === sectionHeader.toLowerCase());
  const renderedLine = `${key} = ${value ? "true" : "false"}`;
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(sectionHeader);
    out.push(renderedLine);
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const keyIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line),
  );

  const out = [...lines];
  if (keyIndex === -1) {
    out.splice(sectionStart + 1, 0, renderedLine);
  } else {
    out[keyIndex] = renderedLine;
  }
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

async function readFilePrefix(path: string, maxBytes = 4096): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function detectHostCodexBinaryKind(path: string): Promise<HostCodexBinaryKind> {
  const prefix = await readFilePrefix(path);
  if (prefix.startsWith(dotslashShebang)) return "dotslash";
  if (prefix.includes(codexBootstrapCacheMarker)) return "bootstrap";
  return "native";
}

async function shouldInvokeCodexWithSiblingNode(path: string): Promise<boolean> {
  const prefix = await readFilePrefix(path, 512);
  return nodeShebangRe.test(prefix);
}

function getLegacyDotslashCacheDirs(): string[] {
  const dirs = new Set<string>();
  const explicit = process.env.DOTSLASH_CACHE?.trim();
  if (explicit) dirs.add(resolve(explicit));
  if (process.platform === "darwin") {
    dirs.add(join(homedir(), "Library", "Caches", "dotslash"));
  }
  dirs.add(join(homedir(), ".cache", "dotslash"));
  return [...dirs];
}

async function findLatestCachedCodexArtifact(): Promise<string | null> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of getLegacyDotslashCacheDirs()) {
    const prefixes = await readdir(root).catch(() => []);
    for (const prefix of prefixes) {
      const prefixDir = join(root, prefix);
      const hashes = await readdir(prefixDir).catch(() => []);
      for (const hash of hashes) {
        const artifact = join(prefixDir, hash, "codex");
        try {
          const artifactStat = await stat(artifact);
          if (artifactStat.isFile()) {
            candidates.push({ path: artifact, mtimeMs: artifactStat.mtimeMs });
          }
        } catch {
          // Not a codex artifact directory.
        }
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

async function prepareDotslashCache(dotslashCache: string): Promise<void> {
  await mkdir(dotslashCache, { recursive: true });

  let existingEntries: string[] = [];
  try {
    existingEntries = await readdir(dotslashCache);
  } catch {
    existingEntries = [];
  }
  if (existingEntries.length > 0) return;

  for (const sourceRoot of getLegacyDotslashCacheDirs()) {
    if (resolve(sourceRoot) === resolve(dotslashCache)) continue;
    const sourceEntries = await readdir(sourceRoot).catch(() => []);
    if (sourceEntries.length === 0) continue;

    try {
      for (const entry of sourceEntries) {
        await cp(join(sourceRoot, entry), join(dotslashCache, entry), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
      return;
    } catch (error) {
      console.warn(`[cli-launcher] Failed to seed DotSlash cache from ${sourceRoot}:`, error);
    }
  }
}

async function findLegacyCodexRolloutPath(threadId: string): Promise<string | null> {
  const sessionsRoot = join(getLegacyCodexHome(), "sessions");
  const years = await readdir(sessionsRoot).catch(() => []);

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const year of years) {
    const yearPath = join(sessionsRoot, year);
    const months = await readdir(yearPath).catch(() => []);
    for (const month of months) {
      const monthPath = join(yearPath, month);
      const days = await readdir(monthPath).catch(() => []);
      for (const day of days) {
        const dayPath = join(monthPath, day);
        const entries = await readdir(dayPath).catch(() => []);
        for (const entry of entries) {
          if (!entry.endsWith(`${threadId}.jsonl`)) continue;
          const fullPath = join(dayPath, entry);
          const entryStat = await stat(fullPath).catch(() => null);
          if (!entryStat?.isFile()) continue;
          if (!newest || entryStat.mtimeMs > newest.mtimeMs) {
            newest = { path: fullPath, mtimeMs: entryStat.mtimeMs };
          }
        }
      }
    }
  }

  return newest?.path ?? null;
}

async function seedCodexResumeRollout(codexHome: string, threadId?: string): Promise<void> {
  if (!threadId) return;
  const rolloutPath = await findLegacyCodexRolloutPath(threadId);
  if (!rolloutPath) return;

  const sessionsRoot = join(getLegacyCodexHome(), "sessions");
  const relativeRolloutPath = relative(sessionsRoot, rolloutPath);
  if (!relativeRolloutPath || relativeRolloutPath.startsWith("..")) return;

  const destPath = join(codexHome, "sessions", relativeRolloutPath);
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(rolloutPath, destPath);
}

async function pruneBrokenSymlinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        await realpath(fullPath);
      } catch {
        await unlink(fullPath).catch(() => {});
      }
      continue;
    }
    if (entry.isDirectory()) {
      await pruneBrokenSymlinks(fullPath);
    }
  }
}

async function prepareCodexHome(codexHome: string, resumeCliSessionId?: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });

  const legacyHome = getLegacyCodexHome();
  if (resolve(legacyHome) === resolve(codexHome) || !(await fileExists(legacyHome))) {
    return;
  }

  const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
  for (const name of fileSeeds) {
    try {
      const src = join(legacyHome, name);
      const dest = join(codexHome, name);
      if (!(await fileExists(src))) continue;
      if (name === "auth.json" || !(await fileExists(dest))) {
        await copyFile(src, dest);
      }
    } catch (error) {
      console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, error);
    }
  }

  const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
  for (const name of dirSeeds) {
    try {
      const src = join(legacyHome, name);
      const dest = join(codexHome, name);
      let copied = false;
      if (!(await fileExists(dest)) && (await fileExists(src))) {
        await cp(src, dest, { recursive: true });
        copied = true;
      }
      if (name === "skills" && (copied || (await fileExists(dest)))) {
        await pruneBrokenSymlinks(dest);
      }
    } catch (error) {
      console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, error);
    }
  }

  try {
    await seedCodexResumeRollout(codexHome, resumeCliSessionId);
  } catch (error) {
    console.warn(`[cli-launcher] Failed to seed resume rollout for ${resumeCliSessionId}:`, error);
  }
}

async function ensureCodexSessionConfig(codexHome: string, envVars: string[]): Promise<void> {
  const configPath = join(codexHome, "config.toml");
  let current = "";
  try {
    current = await readFile(configPath, "utf-8");
  } catch {
    current = "";
  }

  let next = upsertBooleanSettingInSection(current, codexFeaturesHeader, codexMultiAgentFeature, true);
  next = upsertShellEnvironmentIncludeOnly(next, ["PATH", ...envVars]);
  if (next !== current) {
    await writeFile(configPath, next, "utf-8");
  }
}

async function resolveHostCodexLaunchBinary(
  sessionId: string,
  binary: string,
  codexHomeRoot: string,
): Promise<{ binary: string; dotslashCache?: string }> {
  const kind = await detectHostCodexBinaryKind(binary);
  if (kind === "native") return { binary };

  const cachedArtifact = await findLatestCachedCodexArtifact();
  if (cachedArtifact) {
    console.log(`[cli-launcher] Using cached Codex artifact for session ${sessionTag(sessionId)}: ${cachedArtifact}`);
    return { binary: cachedArtifact };
  }

  let selectedBinary = binary;
  if (kind === "bootstrap") {
    const cachedDotslashFile = join(homedir(), ".cache", "codex", "codex");
    if (await fileExists(cachedDotslashFile)) {
      selectedBinary = cachedDotslashFile;
    }
  }

  const selectedKind = selectedBinary === binary ? kind : await detectHostCodexBinaryKind(selectedBinary);
  if (selectedKind !== "dotslash") {
    return { binary: selectedBinary };
  }

  const dotslashCache = join(codexHomeRoot, "dotslash-cache");
  await prepareDotslashCache(dotslashCache);
  return { binary: selectedBinary, dotslashCache };
}

export async function prepareCodexSpawn(
  sessionId: string,
  info: CodexLaunchInfo,
  options: CodexLaunchOptions,
): Promise<CodexSpawnSpec> {
  const serverId = options.env?.COMPANION_SERVER_ID;
  const isContainerized = !!options.containerId;
  const codexHomeRoot = resolveCompanionCodexHome(options.codexHome);

  let binary = options.codexBinary || "codex";
  if (!isContainerized) {
    const resolved = resolveBinary(binary);
    if (!resolved) {
      throw new MissingCodexBinaryError(`Binary "${binary}" not found in PATH`);
    }
    binary = resolved;
  }

  let dotslashCache: string | undefined;
  if (!isContainerized) {
    const hostLaunchBinary = await resolveHostCodexLaunchBinary(sessionId, binary, codexHomeRoot);
    binary = hostLaunchBinary.binary;
    dotslashCache = hostLaunchBinary.dotslashCache;
  }

  const approvalPolicy = mapCodexApprovalPolicy(options.permissionMode, options.askPermission);
  const sandboxMode = resolveCodexSandbox(options.permissionMode, options.codexSandbox);
  const args: string[] = ["-a", approvalPolicy, "-s", sandboxMode, "app-server"];
  args.push("-c", `tools.webSearch=${options.codexInternetAccess === true ? "true" : "false"}`);
  if (options.codexReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${options.codexReasoningEffort}`);
  }

  const codexHome = resolveCompanionCodexSessionHome(sessionId, codexHomeRoot);
  const shellEnvVars = Object.keys(options.env || {}).filter(
    (name) => name.startsWith("COMPANION_") || name.startsWith("TAKODE_"),
  );

  if (!isContainerized) {
    await prepareCodexHome(codexHome, options.resumeCliSessionId || info.cliSessionId);
    await ensureCodexSessionConfig(codexHome, shellEnvVars);
  }

  if (isContainerized) {
    const dockerArgs = ["docker", "exec", "-i"];
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
    }
    dockerArgs.push("-e", "CLAUDECODE=");
    dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
    dockerArgs.push(options.containerId!);
    const innerCmd = [binary, ...args].map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    dockerArgs.push("bash", "-lc", innerCmd);

    return {
      spawnCmd: dockerArgs,
      spawnEnv: { ...process.env, PATH: getEnrichedPath({ serverId }) },
      spawnCwd: undefined,
      sandboxMode,
    };
  }

  const binaryDir = resolve(binary, "..");
  const siblingNode = join(binaryDir, "node");
  const companionBinDir = join(homedir(), ".companion", "bin");
  const localBinDir = join(homedir(), ".local", "bin");
  const bunBinDir = join(homedir(), ".bun", "bin");
  const enrichedPath = getEnrichedPath({ serverId });
  const userShellPath = captureUserShellPath();
  const spawnPath = mergePathStrings([binaryDir, companionBinDir, localBinDir, bunBinDir, userShellPath, enrichedPath]);

  let spawnCmd: string[];
  if ((await fileExists(siblingNode)) && (await shouldInvokeCodexWithSiblingNode(binary))) {
    let codexScript: string;
    try {
      codexScript = await realpath(binary);
    } catch {
      codexScript = binary;
    }
    spawnCmd = [siblingNode, codexScript, ...args];
  } else {
    spawnCmd = [binary, ...args];
  }

  const shellEnv = captureUserShellEnv(["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"]);

  return {
    spawnCmd,
    spawnEnv: {
      ...process.env,
      ...shellEnv,
      CLAUDECODE: undefined,
      MAI_CODEX_DEBUG_WRAPPER: "1",
      ...options.env,
      CODEX_HOME: codexHome,
      ...(dotslashCache ? { DOTSLASH_CACHE: dotslashCache } : {}),
      PATH: spawnPath,
    },
    spawnCwd: info.cwd,
    sandboxMode,
  };
}
