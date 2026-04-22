import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

/**
 * Extract the body of a named method using brace counting.
 * Searches for a method definition (`private/public/protected methodName(` or
 * just `methodName(` at the start of a line), then counts { / } to locate the
 * matching close brace. Immune to formatter-induced signature changes and
 * method reordering.
 */
function extractMethodBody(source: string, methodName: string): string {
  // Match the method definition, not call sites like `this.methodName(`
  const definitionPattern = new RegExp(`(?:(?:private|public|protected)\\s+|export\\s+function\\s+)${methodName}\\s*\\(`);
  const match = definitionPattern.exec(source);
  if (!match) return "";
  const idx = match.index;
  const braceStart = source.indexOf("{", idx);
  if (braceStart === -1) return "";
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0 && i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return source.slice(braceStart, i);
}

/** Extract all `case "xxx":` strings from a block of source code. */
function extractCaseValues(block: string): Set<string> {
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

/**
 * Extract the `type` literal from each constituent of the SDKMessage union.
 * Parses the union definition line to get member type names, then finds
 * each member's `type: 'xxx'` field. Handles union aliases (e.g.
 * `SDKResultMessage = SDKResultSuccess | SDKResultError`) by recursively
 * resolving them. This avoids the old approach of matching every
 * `type: 'xxx'` in the entire SDK file (which picked up transport types,
 * thinking config, etc.).
 */
function extractSDKMessageTypes(sdkSource: string): Set<string> {
  // Find the SDKMessage union: `export declare type SDKMessage = A | B | C;`
  const unionMatch = sdkSource.match(/export declare type SDKMessage\s*=\s*([^;]+);/);
  if (!unionMatch) return new Set();

  const memberNames = unionMatch[1].split("|").map((s) => s.trim());
  const types = new Set<string>();

  /** Try to extract the type literal from a named type, recursing through union aliases. */
  function resolveType(typeName: string): void {
    // Try direct object type: `export declare type Foo = { type: 'xxx'; ... }`
    // Use word boundary \b before `type` to avoid matching `subtype:`
    const objectPattern = new RegExp(`export declare type ${typeName}\\s*=\\s*\\{[^}]*\\btype:\\s*'([^']+)'`, "s");
    const objectMatch = sdkSource.match(objectPattern);
    if (objectMatch) {
      types.add(objectMatch[1]);
      return;
    }
    // Try union alias: `export declare type Foo = Bar | Baz;`
    const unionAliasPattern = new RegExp(`export declare type ${typeName}\\s*=\\s*([^;{]+);`);
    const aliasMatch = sdkSource.match(unionAliasPattern);
    if (aliasMatch) {
      for (const sub of aliasMatch[1].split("|").map((s) => s.trim())) {
        resolveType(sub);
      }
    }
  }

  for (const memberName of memberNames) {
    resolveType(memberName);
  }

  return types;
}

describe("Claude ws-bridge method drift vs upstream Agent SDK snapshot", () => {
  it("keeps handled CLI message types aligned with upstream (or explicit local allowlist)", () => {
    const bridge = readFile("server/bridge/claude-message-controller.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    // Extract case values from routeCLIMessage using brace-counted body extraction
    const routeBody = extractMethodBody(bridge, "routeCLIMessage");
    expect(routeBody.length).toBeGreaterThan(0);
    const handledFromCLI = extractCaseValues(routeBody);
    expect(handledFromCLI.size).toBeGreaterThan(0);

    const upstreamMessageTypes = extractSDKMessageTypes(sdk);
    expect(upstreamMessageTypes.size).toBeGreaterThan(0);

    // Messages we intentionally support in raw CLI transport but are not part of SDKMessage union.
    const localRawTransportTypes = new Set([
      "control_request",
      "control_response",
      "control_cancel_request",
      "keep_alive",
    ]);

    // Forward check: every type the bridge handles must exist in upstream OR the local allowlist
    for (const caseType of handledFromCLI) {
      expect(
        upstreamMessageTypes.has(caseType) || localRawTransportTypes.has(caseType),
        `Bridge handles CLI type "${caseType}" which is not in the upstream SDK snapshot or local allowlist`,
      ).toBe(true);
    }

    // Reverse check: every upstream SDKMessage type should be handled by the bridge
    // (or explicitly listed as intentionally unhandled)
    const intentionallyUnhandled = new Set([
      "user", // user messages are inbound from browser, not from CLI
    ]);
    for (const upstreamType of upstreamMessageTypes) {
      expect(
        handledFromCLI.has(upstreamType) || intentionallyUnhandled.has(upstreamType),
        `Upstream SDK message type "${upstreamType}" is not handled in routeCLIMessage. ` +
          `Add a case for it, or add it to intentionallyUnhandled with justification.`,
      ).toBe(true);
    }
  });

  it("keeps system subtypes handled by ws-bridge aligned with upstream", () => {
    const handler = readFile("server/bridge/claude-message-controller.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    const upstreamInit = sdk.includes("export declare type SDKSystemMessage = {") && sdk.includes("subtype: 'init';");
    const upstreamStatus =
      sdk.includes("export declare type SDKStatusMessage = {") && sdk.includes("subtype: 'status';");

    expect(upstreamInit).toBe(true);
    expect(upstreamStatus).toBe(true);

    expect(handler).toContain('if (msg.subtype === "init")');
    expect(handler).toContain('if (msg.subtype === "status")');
  });
});
