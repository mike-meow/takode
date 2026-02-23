import { describe, it, expect, vi } from "vitest";

// Mock the session-names module so we can control getName without touching disk
vi.mock("./session-names.js", () => ({
  getName: vi.fn(),
}));

import { sessionTag } from "./session-tag.js";
import { getName } from "./session-names.js";

const mockedGetName = vi.mocked(getName);

describe("sessionTag", () => {
  it("returns just the 8-char short hash for unnamed sessions", () => {
    mockedGetName.mockReturnValue(undefined);
    expect(sessionTag("bcc31e64abcdef1234567890")).toBe("bcc31e64");
  });

  it('returns shortHash "name" for named sessions', () => {
    mockedGetName.mockReturnValue("Debug persistent NFS issues");
    expect(sessionTag("7316c239abcdef1234567890")).toBe(
      '7316c239 "Debug persistent NFS issues"',
    );
  });

  it("passes the full ID to getName (not the truncated one)", () => {
    mockedGetName.mockReturnValue(undefined);
    const fullId = "abcdef1234567890abcdef1234567890";
    sessionTag(fullId);
    expect(mockedGetName).toHaveBeenCalledWith(fullId);
  });

  it("handles an empty string ID gracefully", () => {
    // slice(0, 8) on "" returns "", getName returns undefined → just ""
    mockedGetName.mockReturnValue(undefined);
    expect(sessionTag("")).toBe("");
  });

  it("handles an ID shorter than 8 characters", () => {
    // slice(0, 8) on a 4-char string returns the full string
    mockedGetName.mockReturnValue(undefined);
    expect(sessionTag("abcd")).toBe("abcd");
  });

  it("handles a short ID with a name", () => {
    mockedGetName.mockReturnValue("My Session");
    expect(sessionTag("ab")).toBe('ab "My Session"');
  });

  it("treats getName returning empty string as falsy (no name)", () => {
    // Empty string is falsy, so sessionTag should omit the name portion
    mockedGetName.mockReturnValue("");
    expect(sessionTag("deadbeef12345678")).toBe("deadbeef");
  });
});
