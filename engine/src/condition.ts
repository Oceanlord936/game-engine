// ---------------------------------------------------------------------------
// The condition expression grammar — used identically inside `if (...)` and
// `${... ? "a" : "b"}`. Neither the story parser nor the compiler know this
// grammar exists: both just carry the condition around as a raw string,
// and it's parsed here, lazily, whenever it's actually evaluated. That
// mirrors how assignment values and interpolation are already handled —
// nothing in this codebase validates expression-shaped text until the
// moment it runs.
//
//   condition   := or_expr
//   or_expr     := and_expr ("||" and_expr)*
//   and_expr    := comparison ("&&" comparison)*
//   comparison  := identifier comparator value
//   comparator  := ">" | "<" | ">=" | "<=" | "==" | "!="
//   value       := number | '"' ... '"'
//
// Standard precedence — `&&` binds tighter than `||`, same as every
// C-family language — via the classic recursive-descent technique of one
// grammar rule per precedence level. No parentheses for sub-grouping
// (`(a || b) && c`) — nothing needs it yet, and the tokenizer below simply
// doesn't recognize `(`/`)` as tokens, so writing one is a clear parse
// error rather than silently wrong behavior.
// ---------------------------------------------------------------------------

export type Comparator = ">" | "<" | ">=" | "<=" | "==" | "!=";

export type CondExpr =
  | { kind: "compare"; name: string; op: Comparator; value: string | number }
  | { kind: "and"; left: CondExpr; right: CondExpr }
  | { kind: "or"; left: CondExpr; right: CondExpr };

export interface ParsedCondition {
  expr: CondExpr;
  /** Whatever's left after greedily parsing one condition — e.g. the ` ? "a" : "b"` a ternary leaves behind. Empty when the whole input was consumed. */
  rest: string;
}

const COMPARATORS: readonly Comparator[] = [">=", "<=", "==", "!=", ">", "<"];
// Sticky (/y): a match must start exactly at lastIndex, so a failed match
// means "no valid token here" rather than "search further ahead" — that's
// what lets consumption stop cleanly at whatever a caller appends after a
// condition (a ternary's `?`), instead of skipping past it.
const TOKEN_RE = /\s*(&&|\|\||>=|<=|==|!=|>|<|"[^"]*"|-?\d+(?:\.\d+)?|[A-Za-z_]\w*)/y;

class ConditionParser {
  private pos = 0;
  private readonly text: string;

  // Not a TS parameter property (`constructor(private readonly text...)`)
  // on purpose — that shorthand requires generating an assignment, not
  // just erasing types, which `node --experimental-strip-types` (how
  // play.ts and the other CLI scripts run) can't do. This explicit form
  // is pure type-erasure-compatible.
  constructor(text: string) {
    this.text = text;
  }

  get position(): number {
    return this.pos;
  }

  parseOr(): CondExpr {
    let left = this.parseAnd();
    while (this.consumeIf("||")) {
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): CondExpr {
    let left = this.parseComparison();
    while (this.consumeIf("&&")) {
      left = { kind: "and", left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): CondExpr {
    const name = this.consume();
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Expected a variable name, got "${name}"`);
    const op = this.consume();
    if (!(COMPARATORS as string[]).includes(op)) {
      throw new Error(`Expected a comparator (>, <, >=, <=, ==, !=), got "${op}"`);
    }
    const rawValue = this.consume();
    return { kind: "compare", name, op: op as Comparator, value: parseLiteral(rawValue) };
  }

  private matchToken(): { token: string; length: number } | null {
    TOKEN_RE.lastIndex = this.pos;
    const m = TOKEN_RE.exec(this.text);
    return m ? { token: m[1], length: m[0].length } : null;
  }

  private consumeIf(expected: string): boolean {
    const m = this.matchToken();
    if (!m || m.token !== expected) return false;
    this.pos += m.length;
    return true;
  }

  private consume(): string {
    const m = this.matchToken();
    if (!m) throw new Error(`Expected a token near "${this.text.slice(this.pos).trim().slice(0, 20)}"`);
    this.pos += m.length;
    return m.token;
  }
}

function parseLiteral(token: string): string | number {
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith('"')) return token.slice(1, -1);
  throw new Error(`Expected a number or a "quoted string", got "${token}"`);
}

/** Greedily parses one condition expression from the start of `text`; whatever follows is returned as `rest`, unparsed. Throws if `text` doesn't start with a valid condition at all. */
export function parseCondition(text: string): ParsedCondition {
  const parser = new ConditionParser(text);
  const expr = parser.parseOr();
  return { expr, rest: text.slice(parser.position) };
}

/** Same as parseCondition, but returns null instead of throwing — for callers where "this isn't a condition" is a normal outcome (e.g. `${trust}` is a bare variable reference, not a ternary). */
export function tryParseCondition(text: string): ParsedCondition | null {
  try {
    return parseCondition(text);
  } catch {
    return null;
  }
}

export function evalExpr(expr: CondExpr, vars: ReadonlyMap<string, string | number>): boolean {
  switch (expr.kind) {
    case "and":
      return evalExpr(expr.left, vars) && evalExpr(expr.right, vars);
    case "or":
      return evalExpr(expr.left, vars) || evalExpr(expr.right, vars);
    case "compare":
      return evalComparison(expr.name, expr.op, expr.value, vars);
  }
}

function evalComparison(
  name: string,
  op: Comparator,
  right: string | number,
  vars: ReadonlyMap<string, string | number>,
): boolean {
  const left = vars.get(name) ?? 0;

  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case ">": return left > right;
      case "<": return left < right;
      case ">=": return left >= right;
      case "<=": return left <= right;
      case "==": return left === right;
      case "!=": return left !== right;
    }
  }
  const leftStr = String(left);
  const rightStr = String(right);
  if (op === "==") return leftStr === rightStr;
  if (op === "!=") return leftStr !== rightStr;
  return false; // ordering comparisons need numeric operands
}

/** Parses and evaluates `text` as a complete condition — for the common case (an `if`'s condition) where there's nothing else expected after it. Throws on anything malformed, including trailing garbage. */
export function evalCondition(text: string, vars: ReadonlyMap<string, string | number>): boolean {
  const { expr, rest } = parseCondition(text);
  if (rest.trim() !== "") throw new Error(`Unexpected trailing text in condition: "${rest.trim()}"`);
  return evalExpr(expr, vars);
}
