import { describe, expect, it } from "vitest";
import { getSessionAuthFilePrefix, getSessionAuthFilePrefixes } from "./session-auth.js";

describe("session-auth path hashing", () => {
  it("keeps macOS /private temp aliases on the same primary prefix", () => {
    const publicVarPath = "/var/folders/test/workspace";
    const privateVarPath = "/private/var/folders/test/workspace";

    if (process.platform === "darwin") {
      expect(getSessionAuthFilePrefix(publicVarPath)).toBe(getSessionAuthFilePrefix(privateVarPath));
      expect([...getSessionAuthFilePrefixes(publicVarPath)].sort()).toEqual(
        [...getSessionAuthFilePrefixes(privateVarPath)].sort(),
      );
      return;
    }

    expect(getSessionAuthFilePrefix(publicVarPath)).not.toBe(getSessionAuthFilePrefix(privateVarPath));
  });
});
