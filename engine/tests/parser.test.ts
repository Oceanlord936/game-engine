import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.ts";

function label(source: string) {
  const { labels, errors } = parse(source);
  expect(errors).toEqual([]);
  expect(labels).toHaveLength(1);
  return labels[0];
}

describe("parse", () => {
  it("requires a label wrapper at top level", () => {
    const { labels, errors } = parse("Alice: hi");
    expect(labels).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Expected a "label" declaration/);
  });

  it("reads a bare line as narrator text", () => {
    const l = label(['label a {', "The rain hadn't stopped.", "}"].join("\n"));
    expect(l.body).toEqual([{ kind: "narrator", text: "The rain hadn't stopped.", line: 2 }]);
  });

  it("reads Name: text as a speaker line", () => {
    const l = label(["label a {", "Alice: You're late.", "}"].join("\n"));
    expect(l.body).toEqual([{ kind: "speaker", speaker: "Alice", text: "You're late.", line: 2 }]);
  });

  it("does not misread a colon in narration as a speaker line", () => {
    const l = label(["label a {", "The clock read 3:00 sharp.", "}"].join("\n"));
    expect(l.body).toEqual([{ kind: "narrator", text: "The clock read 3:00 sharp.", line: 2 }]);
  });

  it("skips blank lines and // comments", () => {
    const l = label(["label a {", "", "// a comment", "", "Alice: hi", "}"].join("\n"));
    expect(l.body).toEqual([{ kind: "speaker", speaker: "Alice", text: "hi", line: 5 }]);
  });

  it("parses assignment statements with =, +=, -=", () => {
    const l = label(["label a {", "trust = 1;", "trust += 1;", "trust -= 1;", "}"].join("\n"));
    expect(l.body).toEqual([
      { kind: "assign", name: "trust", op: "=", value: "1", line: 2 },
      { kind: "assign", name: "trust", op: "+=", value: "1", line: 3 },
      { kind: "assign", name: "trust", op: "-=", value: "1", line: 4 },
    ]);
  });

  it("parses call statements with zero, one, and multiple args", () => {
    const l = label(["label a {", "hide();", "bg(rainy_street);", "show(alice, neutral);", "}"].join("\n"));
    expect(l.body).toEqual([
      { kind: "call", name: "hide", args: [], line: 2 },
      { kind: "call", name: "bg", args: ["rainy_street"], line: 3 },
      { kind: "call", name: "show", args: ["alice", "neutral"], line: 4 },
    ]);
  });

  it("parses an if statement with no else", () => {
    const l = label(["label a {", "if (trust > 3) {", "Alice: hi", "}", "}"].join("\n"));
    expect(l.body).toEqual([
      {
        kind: "if",
        condition: "trust > 3",
        then: [{ kind: "speaker", speaker: "Alice", text: "hi", line: 3 }],
        else: [],
        line: 2,
      },
    ]);
  });

  it("parses an if/else statement", () => {
    const l = label(
      ["label a {", "if (trust > 3) {", "Alice: hi", "} else {", "Alice: bye", "}", "}"].join("\n"),
    );
    expect(l.body).toEqual([
      {
        kind: "if",
        condition: "trust > 3",
        then: [{ kind: "speaker", speaker: "Alice", text: "hi", line: 3 }],
        else: [{ kind: "speaker", speaker: "Alice", text: "bye", line: 5 }],
        line: 2,
      },
    ]);
  });

  it("parses nested if statements", () => {
    const l = label(
      ["label a {", "if (trust > 3) {", "if (met_alice == 1) {", "Alice: hi", "}", "}", "}"].join("\n"),
    );
    const outer = l.body[0] as { kind: "if"; then: unknown[] };
    expect(outer.kind).toBe("if");
    expect(outer.then).toHaveLength(1);
  });

  it("parses a condition as a raw string, unvalidated (&& / || is condition.ts's grammar, not this parser's)", () => {
    const l = label(["label a {", "if (trust > 3 && curiosity > 1) {", "Alice: hi", "}", "}"].join("\n"));
    const stmt = l.body[0] as { kind: "if"; condition: string };
    expect(stmt.condition).toBe("trust > 3 && curiosity > 1");
  });

  it("desugars else-if into a nested if inside the else branch", () => {
    const l = label(
      [
        "label a {",
        "if (trust > 5) {",
        "Alice: friend",
        "} else if (secret_found == 1) {",
        "Alice: mystery",
        "} else {",
        "Alice: distant",
        "}",
        "}",
      ].join("\n"),
    );
    expect(l.body).toEqual([
      {
        kind: "if",
        condition: "trust > 5",
        then: [{ kind: "speaker", speaker: "Alice", text: "friend", line: 3 }],
        line: 2,
        else: [
          {
            kind: "if",
            condition: "secret_found == 1",
            then: [{ kind: "speaker", speaker: "Alice", text: "mystery", line: 5 }],
            else: [{ kind: "speaker", speaker: "Alice", text: "distant", line: 7 }],
            line: 4,
          },
        ],
      },
    ]);
  });

  it("chains multiple else-if branches", () => {
    const l = label(
      [
        "label a {",
        "if (a > 1) {",
        "Alice: one",
        "} else if (b > 1) {",
        "Alice: two",
        "} else if (c > 1) {",
        "Alice: three",
        "}",
        "}",
      ].join("\n"),
    );
    const outer = l.body[0] as { kind: "if"; else: Array<{ kind: "if"; else: unknown[] }> };
    expect(outer.else).toHaveLength(1);
    expect(outer.else[0].kind).toBe("if");
    expect(outer.else[0].else).toHaveLength(1); // chains to the second else-if
    const secondElseIf = outer.else[0].else[0] as { kind: "if"; else: unknown[] };
    expect(secondElseIf.else).toEqual([]); // no final else
  });

  it("parses a choice block with jump-form and inline-form options", () => {
    const l = label(
      [
        "label a {",
        "choice {",
        '"Apologize" {',
        "Alice: fine",
        "}",
        '"Deflect" -> deflect_branch;',
        "}",
        "}",
      ].join("\n"),
    );
    expect(l.body).toEqual([
      {
        kind: "choice",
        line: 2,
        options: [
          { text: "Apologize", body: [{ kind: "speaker", speaker: "Alice", text: "fine", line: 4 }], line: 3 },
          { text: "Deflect", target: "deflect_branch", line: 6 },
        ],
      },
    ]);
  });

  it("reports an error for a choice block with no options", () => {
    const { errors } = parse(["label a {", "choice {", "}", "}"].join("\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/no options/);
  });

  it("reports an error for an unterminated block", () => {
    const { errors } = parse(["label a {", "if (trust > 3) {", "Alice: hi"].join("\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Unterminated block/);
  });

  it("round-trips the full sample story without errors", () => {
    const source = [
      "// comments look like real code now",
      "label chapter1_start {",
      "  The rain hadn't stopped in three days.",
      '  Alice: You\'re late again, ${trust > 3 ? "old friend" : "stranger"}.',
      "  You: Traffic. What did I miss?",
      "",
      "  trust += 1;",
      "",
      "  if (trust > 3) {",
      "    Alice: Nothing much, actually.",
      "    bg(sunny_street);",
      "  } else {",
      "    Alice: Everything, apparently.",
      "    bg(rainy_street);",
      "  }",
      "",
      "  show(alice, neutral);",
      "",
      "  choice {",
      '    "Apologize" {',
      "      Alice: ...I guess that's fine.",
      "      trust += 1;",
      "    }",
      '    "Deflect" -> deflect_branch;',
      "  }",
      "",
      "  jump(chapter1_start);",
      "}",
      "",
      "label deflect_branch {",
      "  Alice: Typical.",
      "  jump(chapter1_start);",
      "}",
    ].join("\n");

    const { labels, errors } = parse(source);
    expect(errors).toEqual([]);
    expect(labels.map((l) => l.name)).toEqual(["chapter1_start", "deflect_branch"]);
  });
});
