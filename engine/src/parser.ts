import type { Choice, ChoiceOption, If, LabelDecl, ParseError, Program, Statement } from "./ast.ts";

// ---------------------------------------------------------------------------
// .vns grammar — deliberately shaped like a subset of Java/TypeScript:
// braces for blocks, semicolons for statements, `if`/`else`, function-call
// syntax for calls, and `${...}` interpolation exactly like a TS template
// literal. Prose (dialogue/narration) is the one place that stays
// lightweight — no semicolons, no quotes — since that's the text you'll
// actually be writing most of the time.
//
//   program        := (comment | label_decl)*
//   comment        := "//" rest-of-line
//
//   label_decl     := "label" identifier "{" statement* "}"
//
//   statement      := narrator_line | speaker_line | assign_stmt
//                    | call_stmt | if_stmt | choice_stmt
//
//   narrator_line  := text                              ; bare prose, no ";"
//   speaker_line   := identifier ":" text                ; identifier = no spaces —
//                                                         ; keeps "3:00" in narration
//                                                         ; from reading as a speaker
//
//   assign_stmt    := identifier ("=" | "+=" | "-=") value ";"
//   call_stmt      := identifier "(" (arg ("," arg)*)? ")" ";"
//                                                         ; e.g. jump(x); bg(x); show(a, b);
//                                                         ; "jump" is the one call name the
//                                                         ; interpreter has real code for —
//                                                         ; everything else always suspends and
//                                                         ; hands off to whatever's running the
//                                                         ; interpreter (see interpreter.ts)
//
//   if_stmt        := "if" "(" condition ")" "{" statement* "}"
//                      ("else" "if" "(" condition ")" "{" statement* "}")*
//                      ("else" "{" statement* "}")?
//                                                         ; condition can be a full && / ||
//                                                         ; expression — see condition.ts, this
//                                                         ; parser only ever captures it as a raw
//                                                         ; string between the outer parens
//                                                         ; `else if` is pure sugar: it parses to
//                                                         ; the exact same nested-if shape as
//                                                         ; `else { if (...) { ... } }`, so the
//                                                         ; compiler needs no knowledge of it at all
//
//   choice_stmt    := "choice" "{" choice_option+ "}"
//   choice_option  := string ("->" identifier ";" | "{" statement* "}")
//                                                         ; every option needs a destination:
//                                                         ; either jump to a label, or an inline
//                                                         ; reaction written right there
//
// Expressions only ever appear inside text, written like a TS template
// literal — the parser leaves them as raw substrings; the interpreter
// evaluates them against live variable state:
//
//   interpolation  := "${" identifier "}"
//   ternary        := "${" condition "?" string ":" string "}"
// ---------------------------------------------------------------------------

const LABEL_HEADER_RE = /^label\s+([A-Za-z_]\w*)\s*\{$/;
const IF_HEADER_RE = /^if\s*\((.+)\)\s*\{$/;
const ELSE_HEADER_RE = /^\}\s*else\s*\{$/;
const ELSE_IF_HEADER_RE = /^\}\s*else\s+if\s*\((.+)\)\s*\{$/;
const CHOICE_HEADER_RE = /^choice\s*\{$/;
const CHOICE_OPTION_JUMP_RE = /^"(.*)"\s*->\s*([A-Za-z_]\w*)\s*;$/;
const CHOICE_OPTION_INLINE_HEADER_RE = /^"(.*)"\s*\{$/;
const CALL_RE = /^([A-Za-z_]\w*)\s*\((.*)\)\s*;$/;
const ASSIGN_RE = /^([A-Za-z_]\w*)\s*(\+=|-=|=)\s*(.+);$/;
const SPEAKER_RE = /^([A-Za-z_]\w*):\s+(.+)$/;

export function parse(source: string): Program {
  const lines = source.split(/\r?\n/);
  const errors: ParseError[] = [];
  const labels: LabelDecl[] = [];

  let i = 0;
  while (i < lines.length) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();

    if (trimmed === "" || trimmed.startsWith("//")) {
      i++;
      continue;
    }

    const labelMatch = trimmed.match(LABEL_HEADER_RE);
    if (labelMatch) {
      try {
        const closeIdx = findSimpleBlockClose(lines, i + 1);
        const body = parseStatements(lines.slice(i + 1, closeIdx), i + 2, errors);
        labels.push({ name: labelMatch[1], body, line: lineNumber });
        i = closeIdx + 1;
      } catch (err) {
        errors.push({ line: lineNumber, message: (err as Error).message });
        break; // an unterminated block means the rest of the file can't be trusted
      }
      continue;
    }

    errors.push({ line: lineNumber, message: `Expected a "label" declaration at top level, found: "${trimmed}"` });
    i++;
  }

  return { labels, errors };
}

/** Parses a flat run of lines (already sliced to one block's contents) into statements. */
function parseStatements(lines: string[], firstLineNumber: number, errors: ParseError[]): Statement[] {
  const statements: Statement[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineNumber = firstLineNumber + i;
    const trimmed = lines[i].trim();

    if (trimmed === "" || trimmed.startsWith("//")) {
      i++;
      continue;
    }

    const ifMatch = trimmed.match(IF_HEADER_RE);
    if (ifMatch) {
      try {
        const { stmt, nextIdx } = parseIf(lines, i, firstLineNumber, ifMatch[1], errors);
        statements.push(stmt);
        i = nextIdx;
      } catch (err) {
        errors.push({ line: lineNumber, message: (err as Error).message });
        i = lines.length; // bail out of this block, same reasoning as the top-level case
      }
      continue;
    }

    if (CHOICE_HEADER_RE.test(trimmed)) {
      try {
        const { stmt, nextIdx } = parseChoice(lines, i, firstLineNumber, errors);
        statements.push(stmt);
        i = nextIdx;
      } catch (err) {
        errors.push({ line: lineNumber, message: (err as Error).message });
        i = lines.length;
      }
      continue;
    }

    const callMatch = trimmed.match(CALL_RE);
    if (callMatch) {
      const args = callMatch[2].trim() === "" ? [] : callMatch[2].split(",").map((a) => a.trim());
      statements.push({ kind: "call", name: callMatch[1], args, line: lineNumber });
      i++;
      continue;
    }

    const assignMatch = trimmed.match(ASSIGN_RE);
    if (assignMatch) {
      statements.push({
        kind: "assign",
        name: assignMatch[1],
        op: assignMatch[2] as "=" | "+=" | "-=",
        value: assignMatch[3].trim(),
        line: lineNumber,
      });
      i++;
      continue;
    }

    const speakerMatch = trimmed.match(SPEAKER_RE);
    if (speakerMatch) {
      statements.push({ kind: "speaker", speaker: speakerMatch[1], text: speakerMatch[2], line: lineNumber });
      i++;
      continue;
    }

    statements.push({ kind: "narrator", text: trimmed, line: lineNumber });
    i++;
  }

  return statements;
}

function parseIf(
  lines: string[],
  headerIdx: number,
  firstLineNumber: number,
  condition: string,
  errors: ParseError[],
): { stmt: If; nextIdx: number } {
  const lineNumber = firstLineNumber + headerIdx;
  const thenCloseIdx = findBlockCloseOrElse(lines, headerIdx + 1);
  const thenBody = parseStatements(
    lines.slice(headerIdx + 1, thenCloseIdx),
    firstLineNumber + headerIdx + 1,
    errors,
  );
  const closingLine = lines[thenCloseIdx].trim();

  if (closingLine === "}") {
    return { stmt: { kind: "if", condition, then: thenBody, else: [], line: lineNumber }, nextIdx: thenCloseIdx + 1 };
  }
  if (ELSE_HEADER_RE.test(closingLine)) {
    const elseCloseIdx = findSimpleBlockClose(lines, thenCloseIdx + 1);
    const elseBody = parseStatements(
      lines.slice(thenCloseIdx + 1, elseCloseIdx),
      firstLineNumber + thenCloseIdx + 1,
      errors,
    );
    return {
      stmt: { kind: "if", condition, then: thenBody, else: elseBody, line: lineNumber },
      nextIdx: elseCloseIdx + 1,
    };
  }
  const elseIfMatch = closingLine.match(ELSE_IF_HEADER_RE);
  if (elseIfMatch) {
    // "else if" is just another `if` header sitting where this block's
    // close would be — recursing here produces exactly the nested-if AST
    // `else { if (...) { ... } }` would, so the compiler and interpreter
    // need no separate concept of "elseif" at all.
    const nested = parseIf(lines, thenCloseIdx, firstLineNumber, elseIfMatch[1], errors);
    return {
      stmt: { kind: "if", condition, then: thenBody, else: [nested.stmt], line: lineNumber },
      nextIdx: nested.nextIdx,
    };
  }
  throw new Error(`Expected "}", "} else {", or "} else if (...) {" to close if-block opened at line ${lineNumber}`);
}

function parseChoice(
  lines: string[],
  headerIdx: number,
  firstLineNumber: number,
  errors: ParseError[],
): { stmt: Choice; nextIdx: number } {
  const lineNumber = firstLineNumber + headerIdx;
  const bodyEndIdx = findSimpleBlockClose(lines, headerIdx + 1);
  const options: ChoiceOption[] = [];

  let i = headerIdx + 1;
  while (i < bodyEndIdx) {
    const optLineNumber = firstLineNumber + i;
    const trimmed = lines[i].trim();

    if (trimmed === "" || trimmed.startsWith("//")) {
      i++;
      continue;
    }

    const jumpMatch = trimmed.match(CHOICE_OPTION_JUMP_RE);
    if (jumpMatch) {
      options.push({ text: jumpMatch[1], target: jumpMatch[2], line: optLineNumber });
      i++;
      continue;
    }

    const inlineMatch = trimmed.match(CHOICE_OPTION_INLINE_HEADER_RE);
    if (inlineMatch) {
      const closeIdx = findSimpleBlockClose(lines, i + 1);
      const body = parseStatements(lines.slice(i + 1, closeIdx), firstLineNumber + i + 1, errors);
      options.push({ text: inlineMatch[1], body, line: optLineNumber });
      i = closeIdx + 1;
      continue;
    }

    errors.push({
      line: optLineNumber,
      message: `Malformed choice option: "${trimmed}" (expected \`"text" -> target;\` or \`"text" { ... }\`)`,
    });
    i++;
  }

  if (options.length === 0) {
    errors.push({ line: lineNumber, message: "choice has no options" });
  }

  return { stmt: { kind: "choice", options, line: lineNumber }, nextIdx: bodyEndIdx + 1 };
}

/**
 * Finds the line that closes the block starting at `startIdx` (the first
 * line *inside* the braces). Depth-counts every `{`/`}` character per line,
 * which stays correct even though `${var}` interpolation inside prose also
 * contains braces — each interpolation opens and closes on the same line,
 * so it always nets to zero and never throws off the real block boundary.
 */
function findBlockCloseOrElse(lines: string[], startIdx: number): number {
  let depth = 1;
  for (let i = startIdx; i < lines.length; i++) {
    // "} else {" and "} else if (...) {" both close and reopen on the same
    // line, so the generic char-count below nets to zero (or worse, for
    // the elseif case, potentially unbalanced if the condition itself
    // contains stray braces) and would never reliably trigger on them —
    // check explicitly, but only when depth is exactly 1 (i.e. this would
    // close *this* block, not some nested if's own else deeper inside).
    const trimmed = lines[i].trim();
    if (depth === 1 && (ELSE_HEADER_RE.test(trimmed) || ELSE_IF_HEADER_RE.test(trimmed))) return i;
    depth += countChar(lines[i], "{") - countChar(lines[i], "}");
    if (depth <= 0) return i;
  }
  throw new Error(`Unterminated block starting at line ${startIdx} (missing closing "}")`);
}

function findSimpleBlockClose(lines: string[], startIdx: number): number {
  const idx = findBlockCloseOrElse(lines, startIdx);
  if (lines[idx].trim() !== "}") {
    throw new Error(`Expected "}" alone on its own line at line ${startIdx + (idx - startIdx) + 1}`);
  }
  return idx;
}

function countChar(line: string, ch: string): number {
  let count = 0;
  for (const c of line) if (c === ch) count++;
  return count;
}
