import type { BrowserIncomingMessage, McpServerConfig, McpServerDetail, SessionState } from "./session-types.js";
import type { JsonRpcTransport } from "./codex-jsonrpc-transport.js";
import type { CodexMcpServerStatus, CodexMcpStatusListResponse } from "./codex-adapter-utils.js";
import { toSafeText } from "./codex-adapter-utils.js";

type EmitFn = (msg: BrowserIncomingMessage) => void;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isMcpServerEnabled(value: unknown): boolean {
  const cfg = asRecord(value);
  if (!cfg) return true;
  return cfg.enabled !== false;
}

function toMcpServerConfig(value: unknown): McpServerConfig {
  const cfg = asRecord(value) || {};
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === "string") : undefined;
  const env = asRecord(cfg.env) as Record<string, string> | null;

  let type: McpServerConfig["type"] = "sdk";
  if (cfg.type === "stdio" || cfg.type === "sse" || cfg.type === "http" || cfg.type === "sdk") {
    type = cfg.type;
  } else if (typeof cfg.command === "string") {
    type = "stdio";
  } else if (typeof cfg.url === "string") {
    type = "http";
  }

  return {
    type,
    command: typeof cfg.command === "string" ? cfg.command : undefined,
    args,
    env: env || undefined,
    url: typeof cfg.url === "string" ? cfg.url : undefined,
  };
}

function fromMcpServerConfig(config: McpServerConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof config.command === "string") out.command = config.command;
  if (Array.isArray(config.args)) out.args = config.args;
  if (config.env) out.env = config.env;
  if (typeof config.url === "string") out.url = config.url;
  return out;
}

function mapMcpTools(
  tools: Record<string, { name?: string; annotations?: unknown }> | undefined,
): McpServerDetail["tools"] {
  if (!tools) return [];
  return Object.entries(tools).map(([key, tool]) => {
    const ann = asRecord(tool.annotations);
    const annotations = ann
      ? {
          readOnly: (ann.readOnly ?? ann.readOnlyHint) === true,
          destructive: (ann.destructive ?? ann.destructiveHint) === true,
          openWorld: (ann.openWorld ?? ann.openWorldHint) === true,
        }
      : undefined;

    return {
      name: typeof tool.name === "string" ? tool.name : key,
      annotations,
    };
  });
}

export class CodexMcpManager {
  private mcpStartupStatusByName = new Map<string, McpServerDetail>();
  private mcpServersByName = new Map<string, McpServerDetail>();

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly emit: EmitFn,
    private readonly sessionId: string,
  ) {}

  handleStartupStatusUpdated(params: Record<string, unknown>): void {
    const name = toSafeText(params.name).trim();
    if (!name) return;

    const rawStatus = toSafeText(params.status).trim();
    const status: McpServerDetail["status"] =
      rawStatus === "ready" ? "connected" : rawStatus === "failed" ? "failed" : "connecting";
    const error = toSafeText(params.error).trim() || undefined;

    const server: McpServerDetail = {
      name,
      status,
      ...(error ? { error } : {}),
      config: { type: "unknown" },
      scope: "session",
      tools: [],
    };

    this.mcpStartupStatusByName.set(name, server);
    const existing = this.mcpServersByName.get(name);
    this.mcpServersByName.set(name, {
      ...existing,
      ...server,
      config: existing?.config ?? server.config,
      scope: existing?.scope ?? server.scope,
      tools: existing?.tools ?? server.tools,
      error,
    });

    const servers = Array.from(this.mcpServersByName.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.emit({ type: "mcp_status", servers });
    this.emit({
      type: "session_update",
      session: {
        mcp_servers: servers.map((entry) => ({ name: entry.name, status: entry.status })),
      } satisfies Partial<SessionState>,
    });

    if (status === "failed") {
      console.warn(`[codex-adapter] MCP server "${name}" startup failed for session ${this.sessionId}: ${error ?? ""}`);
    }
  }

  async handleGetStatus(): Promise<void> {
    try {
      const statusEntries = await this.listAllMcpServerStatuses();
      const configMap = await this.readMcpServersConfig();

      const names = new Set<string>([
        ...statusEntries.map((s) => s.name),
        ...Object.keys(configMap),
        ...this.mcpStartupStatusByName.keys(),
      ]);

      const statusByName = new Map(statusEntries.map((s) => [s.name, s]));
      const servers: McpServerDetail[] = Array.from(names)
        .sort()
        .map((name) => {
          const status = statusByName.get(name);
          const startupStatus = this.mcpStartupStatusByName.get(name);
          const config = toMcpServerConfig(configMap[name]);
          const enabled = isMcpServerEnabled(configMap[name]);
          const serverStatus: McpServerDetail["status"] = !enabled
            ? "disabled"
            : status?.authStatus === "notLoggedIn"
              ? "failed"
              : (startupStatus?.status ?? "connected");

          return {
            name,
            status: serverStatus,
            error: status?.authStatus === "notLoggedIn" ? "MCP server requires login" : startupStatus?.error,
            config,
            scope: "user",
            tools: mapMcpTools(status?.tools),
          };
        });

      this.mcpServersByName = new Map(servers.map((server) => [server.name, server]));
      this.emit({ type: "mcp_status", servers });
    } catch (err) {
      this.emit({ type: "error", message: `Failed to get MCP status: ${err}` });
    }
  }

  async handleToggle(serverName: string, enabled: boolean): Promise<void> {
    try {
      if (serverName.includes(".")) {
        throw new Error("Server names containing '.' are not supported for toggle");
      }
      await this.transport.call("config/value/write", {
        keyPath: `mcp_servers.${serverName}.enabled`,
        value: enabled,
        mergeStrategy: "upsert",
      });
      await this.reloadMcpServers();
      await this.handleGetStatus();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("invalid transport")) {
        try {
          await this.transport.call("config/value/write", {
            keyPath: `mcp_servers.${serverName}`,
            value: null,
            mergeStrategy: "replace",
          });
          await this.reloadMcpServers();
          await this.handleGetStatus();
          return;
        } catch {}
      }
      this.emit({ type: "error", message: `Failed to toggle MCP server "${serverName}": ${err}` });
    }
  }

  async handleReconnect(): Promise<void> {
    try {
      await this.reloadMcpServers();
      await this.handleGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to reload MCP servers: ${err}` });
    }
  }

  async handleSetServers(servers: Record<string, McpServerConfig>): Promise<void> {
    try {
      const edits: Array<{ keyPath: string; value: Record<string, unknown>; mergeStrategy: "upsert" }> = [];
      for (const [name, config] of Object.entries(servers)) {
        if (name.includes(".")) {
          throw new Error(`Server names containing '.' are not supported: ${name}`);
        }
        edits.push({
          keyPath: `mcp_servers.${name}`,
          value: fromMcpServerConfig(config),
          mergeStrategy: "upsert",
        });
      }
      if (edits.length > 0) {
        await this.transport.call("config/batchWrite", { edits });
      }
      await this.reloadMcpServers();
      await this.handleGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to configure MCP servers: ${err}` });
    }
  }

  private async listAllMcpServerStatuses(): Promise<CodexMcpServerStatus[]> {
    const out: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    let page = 0;

    while (page < 50) {
      const response = (await this.transport.call("mcpServerStatus/list", {
        cursor,
        limit: 100,
      })) as CodexMcpStatusListResponse;
      if (Array.isArray(response.data)) {
        out.push(...response.data);
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
      page++;
    }

    return out;
  }

  private async readMcpServersConfig(): Promise<Record<string, unknown>> {
    const response = (await this.transport.call("config/read", {})) as {
      config?: Record<string, unknown>;
    };
    const config = asRecord(response?.config) || {};
    return asRecord(config.mcp_servers) || {};
  }

  private async reloadMcpServers(): Promise<void> {
    await this.transport.call("config/mcpServer/reload", {});
  }
}
