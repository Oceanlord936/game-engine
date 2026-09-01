import type { Choice, If, Program, Statement } from "./ast.ts";
import type { CompileResult, Instruction } from "./types.ts";

/** Counter for synthetic label names (__if0_end, __choice1_opt0, ...), threaded through the whole compile. */
interface Counter {
  n: number;
}

export function compile(program: Program): CompileResult {
  const instructions: Instruction[] = [];
  const counter: Counter = { n: 0 };

  for (const label of program.labels) {
    instructions.push({ type: "label", name: label.name, line: label.line });
    compileStatements(label.body, instructions, counter);
  }

  return { instructions };
}

function compileStatements(statements: Statement[], out: Instruction[], counter: Counter): void {
  for (const stmt of statements) compileStatement(stmt, out, counter);
}

function compileStatement(stmt: Statement, out: Instruction[], counter: Counter): void {
  switch (stmt.kind) {
    case "narrator":
      out.push({ type: "line", text: stmt.text, line: stmt.line });
      return;
    case "speaker":
      out.push({ type: "speaker", speaker: stmt.speaker, text: stmt.text, line: stmt.line });
      return;
    case "assign":
      // Lowered into the "name op value" string form the interpreter's
      // runSet() parses — assignment syntax is new, the runtime logic
      // behind it isn't.
      out.push({ type: "command", name: "set", args: `${stmt.name} ${stmt.op} ${stmt.value}`, line: stmt.line });
      return;
    case "call":
      // The compiler doesn't distinguish call names at all — jump(...),
      // bg(...), a name that doesn't exist yet, all compile identically.
      // Which of those the interpreter runs internally (just "jump") vs.
      // hands off externally (everything else) is decided at runtime, not
      // here — see interpreter.ts's STATEMENTS note.
      out.push({ type: "command", name: stmt.name, args: stmt.args.join(" "), line: stmt.line });
      return;
    case "if":
      compileIf(stmt, out, counter);
      return;
    case "choice":
      compileChoice(stmt, out, counter);
      return;
  }
}

/**
 * if/else lowering — the textbook technique: a condition becomes a
 * "jump to the else/end if false" instruction, and the branches become
 * plain sequential code with a jump to skip over the other branch:
 *
 *   condjump !cond -> else       condjump !cond -> end
 *   ...then...                   ...then...
 *   jump end                     label end
 *   label else                   ...(no else)
 *   ...else...
 *   label end
 *
 * This function has no idea `else if` exists — the parser already desugars
 * `else if (cond) { ... }` into `else: [{ kind: "if", condition: cond, ... }]`,
 * so an elseif chain just means this function calls itself recursively via
 * the `compileStatements(stmt.else, ...)` call below, same as any other
 * nested if would.
 */
function compileIf(stmt: If, out: Instruction[], counter: Counter): void {
  const id = counter.n++;
  const elseLabel = `__if${id}_else`;
  const endLabel = `__if${id}_end`;
  const hasElse = stmt.else.length > 0;

  out.push({ type: "condjump", condition: stmt.condition, target: hasElse ? elseLabel : endLabel, line: stmt.line });
  compileStatements(stmt.then, out, counter);

  if (hasElse) {
    out.push({ type: "command", name: "jump", args: endLabel, line: stmt.line });
    out.push({ type: "label", name: elseLabel, line: stmt.line });
    compileStatements(stmt.else, out, counter);
  }

  out.push({ type: "label", name: endLabel, line: stmt.line });
}

/**
 * choice lowering — jump-form options (`"text" -> target;`) already point
 * at a real label, nothing to generate. Inline-form options (`"text" { ... }`)
 * get a synthetic label holding the compiled body, appended right after the
 * choice instruction, each falling through to a shared end label so picking
 * an inline reaction naturally continues the story afterward.
 */
function compileChoice(stmt: Choice, out: Instruction[], counter: Counter): void {
  const id = counter.n++;
  const endLabel = `__choice${id}_end`;
  const inlineBlocks: { label: string; body: Statement[] }[] = [];

  const options = stmt.options.map((opt, index) => {
    if (opt.target) return { text: opt.text, target: opt.target };
    const optionLabel = `__choice${id}_opt${index}`;
    inlineBlocks.push({ label: optionLabel, body: opt.body ?? [] });
    return { text: opt.text, target: optionLabel };
  });

  out.push({ type: "choice", options, line: stmt.line });

  for (const block of inlineBlocks) {
    out.push({ type: "label", name: block.label, line: stmt.line });
    compileStatements(block.body, out, counter);
    out.push({ type: "command", name: "jump", args: endLabel, line: stmt.line });
  }

  out.push({ type: "label", name: endLabel, line: stmt.line });
}
