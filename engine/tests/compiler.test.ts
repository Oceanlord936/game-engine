import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.ts";
import { compile } from "../src/compiler.ts";

function compileSource(source: string) {
  const program = parse(source);
  expect(program.errors).toEqual([]);
  return compile(program).instructions;
}

describe("compile", () => {
  it("lowers a label into a label instruction followed by its body", () => {
    const instructions = compileSource(["label a {", "Alice: hi", "}"].join("\n"));
    expect(instructions).toEqual([
      { type: "label", name: "a", line: 1 },
      { type: "speaker", speaker: "Alice", text: "hi", line: 2 },
    ]);
  });

  it("lowers assignment to a set command", () => {
    const instructions = compileSource(["label a {", "trust += 1;", "}"].join("\n"));
    expect(instructions[1]).toEqual({ type: "command", name: "set", args: "trust += 1", line: 2 });
  });

  it("lowers a call to a command with space-joined args", () => {
    const instructions = compileSource(["label a {", "show(alice, neutral);", "}"].join("\n"));
    expect(instructions[1]).toEqual({ type: "command", name: "show", args: "alice neutral", line: 2 });
  });

  it("lowers if-without-else to a single conditional jump to the end label", () => {
    const instructions = compileSource(["label a {", "if (trust > 3) {", "Alice: hi", "}", "}"].join("\n"));
    expect(instructions).toEqual([
      { type: "label", name: "a", line: 1 },
      { type: "condjump", condition: "trust > 3", target: "__if0_end", line: 2 },
      { type: "speaker", speaker: "Alice", text: "hi", line: 3 },
      { type: "label", name: "__if0_end", line: 2 },
    ]);
  });

  it("lowers if/else to a conditional jump, a skip-jump, and both bodies", () => {
    const instructions = compileSource(
      ["label a {", "if (trust > 3) {", "Alice: hi", "} else {", "Alice: bye", "}", "}"].join("\n"),
    );
    expect(instructions).toEqual([
      { type: "label", name: "a", line: 1 },
      { type: "condjump", condition: "trust > 3", target: "__if0_else", line: 2 },
      { type: "speaker", speaker: "Alice", text: "hi", line: 3 },
      { type: "command", name: "jump", args: "__if0_end", line: 2 },
      { type: "label", name: "__if0_else", line: 2 },
      { type: "speaker", speaker: "Alice", text: "bye", line: 5 },
      { type: "label", name: "__if0_end", line: 2 },
    ]);
  });

  it("lowers else-if to nested condjumps — no compiler code needed beyond plain if/else", () => {
    const instructions = compileSource(
      ["label a {", "if (a > 1) {", "Alice: one", "} else if (b > 1) {", "Alice: two", "}", "}"].join("\n"),
    );
    expect(instructions).toEqual([
      { type: "label", name: "a", line: 1 },
      { type: "condjump", condition: "a > 1", target: "__if0_else", line: 2 },
      { type: "speaker", speaker: "Alice", text: "one", line: 3 },
      { type: "command", name: "jump", args: "__if0_end", line: 2 },
      { type: "label", name: "__if0_else", line: 2 },
      { type: "condjump", condition: "b > 1", target: "__if1_end", line: 4 },
      { type: "speaker", speaker: "Alice", text: "two", line: 5 },
      { type: "label", name: "__if1_end", line: 4 },
      { type: "label", name: "__if0_end", line: 2 },
    ]);
  });

  it("gives jump-form choice options their explicit target, untouched", () => {
    const instructions = compileSource(
      ["label a {", "choice {", '"Deflect" -> deflect_branch;', "}", "}"].join("\n"),
    );
    const choiceInstr = instructions[1];
    expect(choiceInstr).toEqual({
      type: "choice",
      options: [{ text: "Deflect", target: "deflect_branch" }],
      line: 2,
    });
  });

  it("compiles inline-form choice options to a synthetic label that falls through to a shared end label", () => {
    const instructions = compileSource(
      ["label a {", "choice {", '"Apologize" {', "Alice: fine", "}", "}", "jump(a);", "}"].join("\n"),
    );
    expect(instructions).toEqual([
      { type: "label", name: "a", line: 1 },
      { type: "choice", options: [{ text: "Apologize", target: "__choice0_opt0" }], line: 2 },
      { type: "label", name: "__choice0_opt0", line: 2 },
      { type: "speaker", speaker: "Alice", text: "fine", line: 4 },
      { type: "command", name: "jump", args: "__choice0_end", line: 2 },
      { type: "label", name: "__choice0_end", line: 2 },
      { type: "command", name: "jump", args: "a", line: 7 },
    ]);
  });
});
