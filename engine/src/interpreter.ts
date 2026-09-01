import { parse } from "./parser.ts";
import { compile } from "./compiler.ts";
import { evalCondition, evalExpr, tryParseCondition } from "./condition.ts";
import type { ChoiceOption, Instruction } from "./types.ts";

export type EngineEvent =
  | { type: "text"; speaker?: string; text: string }
  | { type: "choice"; options: string[] }
  | { type: "handoff"; name: string; args: string[] }
  | { type: "end" };

/**
 * Everything needed to resume a story later: where execution was, what the
 * variables were, and whether a choice or handoff was on screen when it
 * saved. Doesn't include the instructions themselves — a save file is
 * meaningless without the story it was saved from, same as any game save.
 */
export interface SaveData {
  pc: number;
  vars: Array<[string, string | number]>;
  pendingOptions: ChoiceOption[] | null;
  pendingHandoff: { name: string; args: string } | null;
}

const SET_RE = /^(\w+)\s*(\+=|-=|=)\s*(.+)$/;
// ${...} — deliberately the same shape as a TypeScript template literal.
// Two forms live inside the braces: a bare variable name, or a ternary
// (condition.ts owns the "cond" grammar itself, including && / ||).
const INTERPOLATION_RE = /\$\{([^{}]+)\}/g;
const TERNARY_RE = /^"([^"]*)"\s*:\s*"([^"]*)"$/;

function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

// ---------------------------------------------------------------------------
// This is the "eval" half of the language — parser.ts + compiler.ts handle
// syntax, this is semantics. Everything the interpreter does splits into:
//
// STATEMENTS — executed for effect, in sequence, via next()'s switch:
//   label     -> no-op; already resolved into `labels` at construction time
//   line      -> effect: emit narrator text (after evaluating expressions in it)
//   speaker   -> effect: emit speaker text (same)
//   set       -> effect: mutate the `vars` environment (compiled from `x += 1;`)
//   jump      -> effect: control transfer (goto — compiled from `jump(x);`
//                and also how `choose()` moves to a chosen branch)
//   condjump  -> effect: control transfer taken only when `condition` is
//                false (compiled from `if (cond) { ... } else { ... }`,
//                including `else if` chains — those compile to ordinary
//                nested if/else, so this is the only if-related case here;
//                `cond` itself may be a full && / || expression, parsed
//                and evaluated by condition.ts, not by this class)
//   choice    -> effect: *suspends* — see the execution-model note below
//   (any other call) -> effect: *suspends* — compiled from bg(x), battle(a,
//                b), a name that doesn't exist yet, anything. `set` and
//                `jump` are the only two calls this class has real code
//                for; everything else is unconditionally opaque, and being
//                opaque always means "hand off," never "run it anyway and
//                hope." This is deliberate: the interpreter must never
//                accumulate a hardcoded list of "which specific external
//                systems exist" (bg/show today, battle tomorrow, whatever
//                after that) — see visual-novel-plan.md's "story language"
//                section for why that boundary matters. A host that wants
//                bg/show to feel instant just resolves them immediately;
//                the interpreter can't tell the difference between that
//                and a five-minute battle, and isn't supposed to.
//
// EXPRESSIONS — evaluated for a value, only ever found inside ${...} in
// text, never standalone:
//   ${name}                    -> variable reference; evaluates to its
//                                  current value, or "" if never set
//   ${cond ? "a" : "b"}        -> ternary; evaluates to the string a or b
//
// EXECUTION MODEL — next() is a pull-based, pausable step function (closer
// to a generator/coroutine than "run to completion"), because a VN's next
// instruction sometimes depends on a human, or on an entire external
// system, not just computed state. Two kinds of statement suspend:
// `choice` sets `pendingOptions`, resolved by choose(); any opaque call
// sets `pendingHandoff`, resolved by resolveHandoff(). Both re-return the
// same event on every next() call until resolved — that's the language's
// only blocking behavior, just two flavors of it. This is also why the
// interpreter is a stateful class rather than a pure
// `eval(env, expr) -> value` function the way a batch OCaml interpreter
// would be: the caller needs to walk away and come back (e.g. render a
// frame, run a whole battle) without losing VM state.
//
// SAVE/LOAD — save()/load() snapshot and restore exactly that VM state
// (pc, vars, pendingOptions, pendingHandoff) as plain JSON, so "walk away
// and come back" can also mean "close the program entirely," not just
// yield to a caller.
// ---------------------------------------------------------------------------
export class Interpreter {
  private readonly instructions: Instruction[];
  private readonly labels: Map<string, number>;
  private pc = 0;
  private readonly vars = new Map<string, string | number>();
  private pendingOptions: ChoiceOption[] | null = null;
  private pendingHandoff: { name: string; args: string } | null = null;

  constructor(instructions: Instruction[]) {
    this.instructions = instructions;
    this.labels = new Map();
    this.instructions.forEach((instr, index) => {
      if (instr.type === "label") this.labels.set(instr.name, index);
    });
  }

  /** Parses + compiles a .vns source string and returns a ready-to-run Interpreter. */
  static fromSource(source: string): Interpreter {
    const program = parse(source);
    if (program.errors.length > 0) {
      const details = program.errors.map((e) => `line ${e.line}: ${e.message}`).join("; ");
      throw new Error(`Cannot run a story with parse errors: ${details}`);
    }
    return new Interpreter(compile(program).instructions);
  }

  get variables(): ReadonlyMap<string, string | number> {
    return this.vars;
  }

  /** Snapshots everything needed to resume later — position, variables, and any choice or handoff on screen. */
  save(): SaveData {
    return {
      pc: this.pc,
      vars: Array.from(this.vars.entries()),
      pendingOptions: this.pendingOptions,
      pendingHandoff: this.pendingHandoff,
    };
  }

  /** Restores a snapshot from save(). `data` is external input (e.g. read from disk), so its shape is checked. */
  load(data: SaveData): void {
    if (typeof data.pc !== "number" || data.pc < 0 || data.pc > this.instructions.length) {
      throw new Error(`Save data has an out-of-range position (pc=${data.pc})`);
    }
    this.pc = data.pc;
    this.vars.clear();
    for (const [name, value] of data.vars) this.vars.set(name, value);
    this.pendingOptions = data.pendingOptions;
    this.pendingHandoff = data.pendingHandoff;
  }

  /**
   * Advances to the next event. After a "choice" event, call choose();
   * after a "handoff" event, call resolveHandoff() — before calling next()
   * again either way, or the same event just gets returned again.
   */
  next(): EngineEvent {
    if (this.pendingOptions) {
      return { type: "choice", options: this.pendingOptions.map((o) => o.text) };
    }
    if (this.pendingHandoff) {
      return { type: "handoff", name: this.pendingHandoff.name, args: splitArgs(this.pendingHandoff.args) };
    }

    while (this.pc < this.instructions.length) {
      const instr = this.instructions[this.pc];
      this.pc++;

      switch (instr.type) {
        case "label":
          continue;
        case "condjump":
          if (!evalCondition(instr.condition, this.vars)) this.jumpTo(instr.target);
          continue;
        case "line":
          return { type: "text", text: this.interpolate(instr.text) };
        case "speaker":
          return { type: "text", speaker: instr.speaker, text: this.interpolate(instr.text) };
        case "command":
          if (instr.name === "set") {
            this.runSet(instr.args);
            continue;
          }
          if (instr.name === "jump") {
            this.jumpTo(instr.args.trim());
            continue;
          }
          // Anything else — bg(x), battle(a, b), a name that doesn't exist
          // yet. This class has no idea what any of them mean, on purpose;
          // see the STATEMENTS note above for why that's load-bearing.
          this.pendingHandoff = { name: instr.name, args: instr.args };
          return { type: "handoff", name: instr.name, args: splitArgs(instr.args) };
        case "choice":
          this.pendingOptions = instr.options;
          return { type: "choice", options: instr.options.map((o) => o.text) };
      }
    }
    return { type: "end" };
  }

  choose(index: number): void {
    if (!this.pendingOptions) throw new Error("choose() called without a pending choice");
    const option = this.pendingOptions[index];
    if (!option) throw new Error(`Choice index ${index} out of range (0..${this.pendingOptions.length - 1})`);
    this.pendingOptions = null;
    this.jumpTo(option.target);
  }

  /** Resolves a pending handoff, merging `resultVars` (if any) into story state before execution continues. */
  resolveHandoff(resultVars: Record<string, string | number> = {}): void {
    if (!this.pendingHandoff) throw new Error("resolveHandoff() called without a pending handoff");
    for (const [name, value] of Object.entries(resultVars)) this.vars.set(name, value);
    this.pendingHandoff = null;
  }

  private jumpTo(label: string): void {
    const target = this.labels.get(label);
    if (target === undefined) throw new Error(`Unknown label "${label}"`);
    this.pc = target;
  }

  private runSet(args: string): void {
    const match = args.match(SET_RE);
    if (!match) throw new Error(`Malformed assignment "${args}"`);
    const [, name, op, rawValue] = match;
    const value = this.parseValue(rawValue.trim());
    if (op === "=") {
      this.vars.set(name, value);
      return;
    }
    const current = this.vars.get(name);
    const currentNum = typeof current === "number" ? current : 0;
    const valueNum = typeof value === "number" ? value : 0;
    this.vars.set(name, op === "+=" ? currentNum + valueNum : currentNum - valueNum);
  }

  private parseValue(raw: string): string | number {
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw.replace(/^["']|["']$/g, "");
  }

  private interpolate(text: string): string {
    return text.replace(INTERPOLATION_RE, (_match, inner: string) => {
      // Try reading `inner` as a condition first — if some of it is left
      // over and that leftover starts with "?", this was a ternary. A
      // bare variable reference like `${trust}` isn't a valid condition
      // at all (no comparator), so tryParseCondition returns null and we
      // fall through to the plain variable-lookup case below.
      const parsed = tryParseCondition(inner);
      const afterCond = parsed?.rest.trim();
      if (parsed && afterCond?.startsWith("?")) {
        const branches = afterCond.slice(1).trim().match(TERNARY_RE);
        if (!branches) return ""; // malformed ternary — fail soft rather than crash mid-story
        const [, trueText, falseText] = branches;
        return evalExpr(parsed.expr, this.vars) ? trueText : falseText;
      }

      const value = this.vars.get(inner.trim());
      return value === undefined ? "" : String(value);
    });
  }
}
