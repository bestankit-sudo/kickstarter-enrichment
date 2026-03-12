import { describe, expect, it } from "vitest";
import { extractDomain, normalizeKickstarterUrl } from "../src/utils/url.js";

describe("normalizeKickstarterUrl", () => {
  it("normalizes canonical cases", () => {
    expect(normalizeKickstarterUrl("https://www.kickstarter.com/projects/foo/bar?ref=discovery")).toBe(
      "kickstarter.com/projects/foo/bar",
    );
    expect(normalizeKickstarterUrl("https://kickstarter.com/projects/foo/bar/")).toBe(
      "kickstarter.com/projects/foo/bar",
    );
    expect(normalizeKickstarterUrl("HTTPS://WWW.KICKSTARTER.COM/Projects/Foo/Bar#comments")).toBe(
      "kickstarter.com/projects/foo/bar",
    );
    expect(normalizeKickstarterUrl("https://www.kickstarter.com/projects/123/my-project?ref=nav")).toBe(
      "kickstarter.com/projects/123/my-project",
    );
  });
});

describe("extractDomain", () => {
  it("extracts hostnames", () => {
    expect(extractDomain("https://www.example.com/path")).toBe("example.com");
    expect(extractDomain("https://127.0.0.1/test")).toBe("127.0.0.1");
  });

  it("returns null for invalid URLs", () => {
    expect(extractDomain("example.com/no-protocol")).toBeNull();
    expect(extractDomain("not-a-url")).toBeNull();
  });
});
