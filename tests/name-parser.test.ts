import { describe, expect, it } from "vitest";
import { parseFounderName, parseFounderNames } from "../src/utils/name-parser.js";

describe("parseFounderName", () => {
  it("parses documented cases", () => {
    expect(parseFounderName("John Smith")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(parseFounderName("Priya")).toEqual({ firstName: "Priya", lastName: "" });
    expect(parseFounderName("Dr. Jane Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
    expect(parseFounderName("John Smith, Jane Doe")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(parseFounderName("FrescoPod Team")).toBeNull();
    expect(parseFounderName("  ")).toBeNull();
    expect(parseFounderName("John Paul Smith")).toEqual({ firstName: "John", lastName: "Paul Smith" });
  });

  it("handles unicode and whitespace", () => {
    expect(parseFounderName("  María   José  ")).toEqual({ firstName: "María", lastName: "José" });
    expect(parseFounderName("\tÉlodie\nDurand  ")).toEqual({ firstName: "Élodie", lastName: "Durand" });
  });
});

describe("parseFounderNames", () => {
  it("splits multiple founders into separate people", () => {
    expect(parseFounderNames("John Smith, Jane Doe")).toEqual([
      { firstName: "John", lastName: "Smith" },
      { firstName: "Jane", lastName: "Doe" },
    ]);

    expect(parseFounderNames("John Smith; Jane Doe & Priya Singh")).toEqual([
      { firstName: "John", lastName: "Smith" },
      { firstName: "Jane", lastName: "Doe" },
      { firstName: "Priya", lastName: "Singh" },
    ]);
  });

  it("deduplicates repeated names", () => {
    expect(parseFounderNames("John Smith, John Smith")).toEqual([{ firstName: "John", lastName: "Smith" }]);
  });
});
