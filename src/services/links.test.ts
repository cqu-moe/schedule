import { describe, it, expect } from "vitest";
import { LINK_FORMATS } from "../db/schema";
import { parseFormats, linkAllows } from "./links";

describe("parseFormats", () => {
  it("accepts a valid subset and returns it", () => {
    expect(parseFormats(["ics", "web"])).toEqual(["ics", "web"]);
  });

  it("deduplicates repeated formats", () => {
    expect(parseFormats(["ics", "ics", "web"])).toEqual(["ics", "web"]);
  });

  it("throws on a non-array input", () => {
    expect(() => parseFormats("ics")).toThrow("INVALID_FORMATS");
    expect(() => parseFormats(null)).toThrow("INVALID_FORMATS");
    expect(() => parseFormats({ formats: ["ics"] })).toThrow("INVALID_FORMATS");
  });

  it("throws on an empty array", () => {
    expect(() => parseFormats([])).toThrow("INVALID_FORMATS");
  });

  it("throws when any element is not a known format", () => {
    expect(() => parseFormats(["ics", "bogus"])).toThrow("INVALID_FORMATS");
    expect(() => parseFormats(["bogus"])).toThrow("INVALID_FORMATS");
  });
});

describe("linkAllows", () => {
  it("returns true when the JSON array contains the format", () => {
    expect(linkAllows(JSON.stringify(["ics", "web"]), "ics")).toBe(true);
    expect(linkAllows(JSON.stringify([...LINK_FORMATS]), "csv")).toBe(true);
  });

  it("returns false when the JSON array does not contain the format", () => {
    expect(linkAllows(JSON.stringify(["web"]), "ics")).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    expect(linkAllows("not json{{{", "ics")).toBe(false);
    expect(linkAllows("", "ics")).toBe(false);
  });
});
