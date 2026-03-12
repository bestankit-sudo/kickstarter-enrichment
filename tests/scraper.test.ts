import { describe, expect, it } from "vitest";
import { __testables__ } from "../src/enrichment/website-scraper.js";

describe("website scraper helpers", () => {
  it("filters share links and picks first valid social", () => {
    const html = `
      <a href="https://facebook.com/sharer.php?u=foo">share</a>
      <a href="https://facebook.com/mybrand">brand</a>
    `;
    const picked = __testables__.pickFirstSocial(html, /https?:\/\/(www\.)?facebook\.com\/[^/"'\s?#]+/gi);
    expect(picked).toBe("https://facebook.com/mybrand");
  });

  it("extracts preferred email and excludes bad domains", () => {
    const html = `
      mailto:test@gmail.com
      hello@brand.com
      support@brand.com
    `;
    expect(__testables__.extractBusinessEmail(html, "brand.com")).toBe("hello@brand.com");
  });

  it("returns null when no valid email exists", () => {
    expect(__testables__.extractBusinessEmail("contact us at team@gmail.com", "brand.com")).toBeNull();
  });

  it("handles huge html input without throwing", () => {
    const huge = "a".repeat(6 * 1024 * 1024);
    expect(() => __testables__.extractBusinessEmail(huge, "brand.com")).not.toThrow();
  });
});
