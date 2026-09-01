import { describe, it, expect } from "vitest";
import { evalCondition, parseCondition, tryParseCondition, evalExpr } from "../src/condition.ts";

function vars(entries: Record<string, string | number>): Map<string, string | number> {
  return new Map(Object.entries(entries));
}

describe("evalCondition", () => {
  it("evaluates a single comparison, same as before && / || existed", () => {
    expect(evalCondition("trust > 3", vars({ trust: 5 }))).toBe(true);
    expect(evalCondition("trust > 3", vars({ trust: 1 }))).toBe(false);
  });

  it("defaults an unset variable to 0", () => {
    expect(evalCondition("trust > 3", vars({}))).toBe(false);
    expect(evalCondition("trust == 0", vars({}))).toBe(true);
  });

  it("compares strings with == and !=", () => {
    expect(evalCondition('name == "Alice"', vars({ name: "Alice" }))).toBe(true);
    expect(evalCondition('name != "Alice"', vars({ name: "Bob" }))).toBe(true);
  });

  it("combines two comparisons with &&", () => {
    expect(evalCondition("trust > 3 && curiosity > 1", vars({ trust: 5, curiosity: 2 }))).toBe(true);
    expect(evalCondition("trust > 3 && curiosity > 1", vars({ trust: 5, curiosity: 0 }))).toBe(false);
  });

  it("combines two comparisons with ||", () => {
    expect(evalCondition("trust > 5 || secret_found == 1", vars({ trust: 1, secret_found: 1 }))).toBe(true);
    expect(evalCondition("trust > 5 || secret_found == 1", vars({ trust: 1, secret_found: 0 }))).toBe(false);
  });

  it("gives && higher precedence than ||, like every C-family language", () => {
    // a(false) || b(true) && c(false)  =>  a || (b && c)  =>  false || false  =>  false
    expect(
      evalCondition("a > 5 || b > 0 && c > 5", vars({ a: 0, b: 1, c: 0 })),
    ).toBe(false);
    // if && bound looser, this would parse as (a || b) && c => true && false => false too,
    // so use a case where the two groupings actually disagree:
    // a(true) || b(false) && c(false) => a || (b && c) => true || false => true
    // vs (a || b) && c => true && false => false
    expect(
      evalCondition("a > 0 || b > 5 && c > 5", vars({ a: 1, b: 0, c: 0 })),
    ).toBe(true);
  });

  it("parses a chain of the same operator left-associatively", () => {
    const { expr } = parseCondition("a > 1 && b > 1 && c > 1");
    expect(expr).toEqual({
      kind: "and",
      left: {
        kind: "and",
        left: { kind: "compare", name: "a", op: ">", value: 1 },
        right: { kind: "compare", name: "b", op: ">", value: 1 },
      },
      right: { kind: "compare", name: "c", op: ">", value: 1 },
    });
  });

  it("throws on a malformed condition (missing comparator)", () => {
    expect(() => evalCondition("trust", vars({ trust: 1 }))).toThrow(/Expected a token|Expected a comparator/);
  });

  it("throws on trailing garbage after a complete condition", () => {
    expect(() => evalCondition("trust > 3 extra", vars({ trust: 5 }))).toThrow(/trailing text/);
  });
});

describe("tryParseCondition", () => {
  it("returns null for a bare variable reference (no comparator)", () => {
    expect(tryParseCondition("trust")).toBeNull();
  });

  it("returns the parsed condition plus whatever text follows it", () => {
    const result = tryParseCondition('trust > 3 ? "a" : "b"');
    expect(result).not.toBeNull();
    expect(result!.rest.trim()).toBe('? "a" : "b"');
    expect(evalExpr(result!.expr, vars({ trust: 5 }))).toBe(true);
  });

  it("consumes a full && / || expression before stopping at the ternary marker", () => {
    const result = tryParseCondition('trust > 3 && curiosity > 1 ? "a" : "b"');
    expect(result).not.toBeNull();
    expect(result!.rest.trim()).toBe('? "a" : "b"');
  });
});
