import { Hono } from "hono";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { resolve, join, dirname, extname, relative } from "node:path";
import { homedir } from "node:os";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { ensureAssistantWorkspace, ASSISTANT_DIR } from "../assistant-workspace.js";
import { expandTilde } from "../path-resolver.js";
import { getRipgrepPath } from "../ripgrep.js";
import type { RouteContext } from "./context.js";

const execPromise = promisify(execCb);

export function createFilesystemRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { wsBridge, execAsync, execCaptureStdoutAsync } = ctx;

  // ─── Filesystem browsing ─────────────────────────────────────

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(expandTilde(rawPath));
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir = cwd !== home && (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  // ─── Editor filesystem APIs ─────────────────────────────────────

  /** Recursive directory tree for the editor file explorer */
  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return []; // Safety limit
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  /** Read a single file */
  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot read file" }, 404);
    }
  });

  api.get("/fs/image", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const absPath = resolve(path);
    const ext = extname(absPath).toLowerCase();
    const mimeByExt: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
      ".avif": "image/avif",
      ".tif": "image/tiff",
      ".tiff": "image/tiff",
      ".heic": "image/heic",
      ".heif": "image/heif",
    };
    const contentType = mimeByExt[ext];
    if (!contentType) {
      return c.json({ error: "file is not a supported image type" }, 400);
    }
    try {
      const content = await readFile(absPath);
      return c.body(content, 200, {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=30",
      });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot read image file" }, 404);
    }
  });

  /** Write a single file */
  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = resolve(filePath);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot write file" }, 500);
    }
  });

  /** Git diff for a single file (unified diff) */
  api.get("/fs/diff", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const base = c.req.query("base");
    if (!base) return c.json({ error: "base branch required" }, 400);
    const includeContents = c.req.query("includeContents") === "1";
    const absPath = resolve(filePath);
    try {
      const repoRoot = await execAsync("git rev-parse --show-toplevel", dirname(absPath));
      const relPath =
        (await execAsync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, repoRoot)) || absPath;

      let diff = "";
      try {
        // Compare directly to the selected base ref tip. Using merge-base here
        // makes cherry-picked commits appear as unsynced in the UI.
        diff = await execCaptureStdoutAsync(`git diff ${base} -- "${relPath}"`, repoRoot);
      } catch {
        // Base ref unavailable — leave diff empty
      }

      // For untracked files, base-branch diff is empty. Show full file as added.
      if (!diff.trim()) {
        const untracked = await execAsync(`git ls-files --others --exclude-standard -- "${relPath}"`, repoRoot);
        if (untracked) {
          diff = await execCaptureStdoutAsync(`git diff --no-index -- /dev/null "${absPath}"`, repoRoot);
        }
      }

      let oldText: string | undefined;
      let newText: string | undefined;

      if (includeContents) {
        const escapedRelPath = relPath.replace(/[\\`"$]/g, "\\$&");

        try {
          const baseContent = await execCaptureStdoutAsync(`git show ${base}:"${escapedRelPath}"`, repoRoot);
          if (Buffer.byteLength(baseContent, "utf-8") <= 1024 * 1024) {
            oldText = baseContent.replace(/\r\n/g, "\n");
          }
        } catch {
          // File may not exist on base branch (e.g. untracked/new file).
        }

        try {
          const fileInfo = await stat(absPath);
          // Avoid sending very large files into the browser diff renderer.
          if (fileInfo.size <= 1024 * 1024) {
            const currentContent = await readFile(absPath, "utf-8");
            newText = currentContent.replace(/\r\n/g, "\n");
          }
        } catch {
          // File may not exist in working tree (e.g. deleted file).
        }

        // If only one side is available for a mixed add+del patch, we cannot
        // reconstruct a trustworthy full-file diff view. Fall back to unified.
        const hasAdds = diff.split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++"));
        const hasDels = diff.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"));
        if ((oldText === undefined || newText === undefined) && hasAdds && hasDels) {
          oldText = undefined;
          newText = undefined;
        }
      }

      return c.json({
        path: absPath,
        diff,
        baseBranch: base,
        ...(includeContents ? { oldText, newText } : {}),
      });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /**
   * Bulk diff stats — returns per-file additions/deletions for a list of files
   * in a single `git diff --numstat` call. Much cheaper than fetching full diffs.
   */
  api.post("/fs/diff-stats", async (c) => {
    const body = await c.req.json<{ files: string[]; base?: string; repoRoot: string }>();
    if (!body?.files?.length || !body.repoRoot) {
      return c.json({ error: "files[] and repoRoot required" }, 400);
    }
    if (!body.base) {
      return c.json({ error: "base branch required" }, 400);
    }
    const repoRoot = resolve(body.repoRoot);
    try {
      // git diff --numstat returns: "additions\tdeletions\tfilepath" per line
      const rootPrefix = `${repoRoot}/`;
      const relFiles = body.files.map((f) => (f.startsWith(rootPrefix) ? f.slice(rootPrefix.length) : f));
      const fileArgs = relFiles.map((f) => `"${f}"`).join(" ");
      const raw = await execCaptureStdoutAsync(`git diff --numstat ${body.base} -- ${fileArgs}`, repoRoot);

      const stats: Record<string, { additions: number; deletions: number }> = {};
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const [add, del, file] = line.split("\t");
        if (file) {
          const absPath = `${repoRoot}/${file}`;
          stats[absPath] = {
            additions: add === "-" ? 0 : parseInt(add, 10) || 0,
            deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
          };
        }
      }
      return c.json({ stats, baseBranch: body.base });
    } catch {
      return c.json({ stats: {} });
    }
  });

  /**
   * List files changed between the working tree and a base ref.
   * Uses `git diff --name-status` to detect additions, modifications,
   * and deletions. Rename detection (-M) is intentionally omitted — it
   * requires git to compute content similarity scores, which triggers
   * full file reads over NFS and can block for 30+ seconds on large repos.
   * Renames appear as separate A + D entries; the UI handles this gracefully.
   *
   * Untracked file listing (git ls-files --others) is also omitted because
   * it walks the entire working tree — another expensive NFS scan. New files
   * are already tracked via tool-call observations (Write/Edit events) on
   * the frontend, so they appear in the file list without git.
   *
   * Returns an array of { path, status } where status is one of:
   *   A = added, M = modified, D = deleted
   */
  api.get("/fs/diff-files", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const base = c.req.query("base");
    if (!base) return c.json({ error: "base ref required" }, 400);

    const repoRoot = resolve(cwd);
    try {
      // --no-optional-locks avoids NFS lock contention on .git/index.lock
      // No -M flag: rename detection is too expensive on NFS (reads full file contents)
      const raw = await execCaptureStdoutAsync(`git --no-optional-locks diff --name-status ${base}`, repoRoot);

      const files: Array<{
        path: string;
        status: "A" | "M" | "D" | "R";
        oldPath?: string;
      }> = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const statusCode = parts[0];

        if (statusCode === "D") {
          files.push({ path: `${repoRoot}/${parts[1]}`, status: "D" });
        } else if (statusCode === "A") {
          files.push({ path: `${repoRoot}/${parts[1]}`, status: "A" });
        } else if (statusCode === "M") {
          files.push({ path: `${repoRoot}/${parts[1]}`, status: "M" });
        } else if (parts[1]) {
          files.push({ path: `${repoRoot}/${parts[1]}`, status: "M" });
        }
      }

      return c.json({ files, repoRoot, base });
    } catch {
      return c.json({ files: [], repoRoot, base });
    }
  });

  /** Find Claude config files for a project (CLAUDE.md + .claude/settings*.json) */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    // Resolve to absolute path to prevent path traversal
    const resolvedCwd = resolve(cwd);

    const candidates: Array<{ path: string; writable: boolean }> = [
      { path: join(resolvedCwd, "CLAUDE.md"), writable: true },
      { path: join(resolvedCwd, ".claude", "CLAUDE.md"), writable: true },
      { path: join(resolvedCwd, ".claude", "settings.json"), writable: false },
      { path: join(resolvedCwd, ".claude", "settings.local.json"), writable: false },
    ];

    const files: { path: string; content: string; writable: boolean }[] = [];
    for (const { path: p, writable } of candidates) {
      try {
        const content = await readFile(p, "utf-8");
        files.push({ path: p, content, writable });
      } catch {
        // file doesn't exist — skip
      }
    }

    return c.json({ cwd: resolvedCwd, files });
  });

  /** Create or update a CLAUDE.md file */
  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    // Only allow writing CLAUDE.md files
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    // Verify the resolved path ends with CLAUDE.md or .claude/CLAUDE.md
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      // Ensure parent directory exists
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot write file" }, 500);
    }
  });

  // ─── File search for @ mentions ─────────────────────────────────

  /**
   * Fast file search using ripgrep's --files mode + case-insensitive substring filter.
   * Respects .gitignore by default. Returns relative paths sorted by relevance:
   * filename matches first, then by path length (shorter = more likely what user wants).
   */
  api.get("/fs/search", async (c) => {
    const query = c.req.query("q")?.trim();
    const root = c.req.query("root");
    if (!root) return c.json({ error: "root required" }, 400);
    if (!query || query.length < 1) return c.json({ results: [] });

    const searchRoot = resolve(root);
    const rgPath = await getRipgrepPath();

    try {
      // rg --files lists all non-ignored files, piped through head to cap at 5000.
      // Then we filter by case-insensitive substring match on the relative path.
      // This is fast even on large repos: rg's file listing is ~10-50ms, filtering is trivial.
      const { stdout } = await execPromise(
        `"${rgPath}" --files --no-messages --hidden --glob '!.git' 2>/dev/null | head -5000`,
        { cwd: searchRoot, timeout: 5000 },
      );

      const queryLower = query.toLowerCase();
      const files = stdout.split("\n").filter(Boolean);
      const matches: Array<{ path: string; name: string; score: number }> = [];

      for (const relPath of files) {
        const lower = relPath.toLowerCase();
        if (!lower.includes(queryLower)) continue;

        // Score: prefer filename matches over directory-only matches,
        // then shorter paths over longer ones
        const name = relPath.split("/").pop() || relPath;
        const nameMatch = name.toLowerCase().includes(queryLower);
        const score = (nameMatch ? 0 : 1000) + relPath.length;

        matches.push({ path: relPath, name, score });
      }

      matches.sort((a, b) => a.score - b.score);

      const results = matches.slice(0, 15).map((m) => ({
        relativePath: m.path,
        absolutePath: join(searchRoot, m.path),
        fileName: m.name,
      }));

      return c.json({ results, root: searchRoot });
    } catch {
      // rg failed or timed out — return empty results gracefully
      return c.json({ results: [], root: searchRoot });
    }
  });

  /**
   * Resolve @ mentions: reads file contents (optionally a line range) for each mentioned path.
   * Used by the Composer to inject file context before sending a user message.
   */
  api.post("/fs/resolve-mentions", async (c) => {
    const body = await c.req
      .json<{ mentions: Array<{ path: string; startLine?: number; endLine?: number }> }>()
      .catch(() => null);
    if (!body?.mentions?.length) return c.json({ error: "mentions[] required" }, 400);

    const resolved = await Promise.all(
      body.mentions.map(async (m) => {
        const absPath = resolve(m.path);
        try {
          const info = await stat(absPath);
          if (info.size > 2 * 1024 * 1024) {
            return { path: absPath, error: "File too large (>2MB)" };
          }
          const full = await readFile(absPath, "utf-8");
          let content = full;
          if (m.startLine != null || m.endLine != null) {
            const lines = full.split("\n");
            const start = Math.max(0, (m.startLine ?? 1) - 1);
            const end = m.endLine ?? lines.length;
            content = lines.slice(start, end).join("\n");
          }
          return { path: absPath, content, totalLines: full.split("\n").length };
        } catch (e: unknown) {
          return { path: absPath, error: e instanceof Error ? e.message : "Cannot read file" };
        }
      }),
    );

    return c.json({ resolved });
  });

  return api;
}
