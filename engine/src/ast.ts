// ---------------------------------------------------------------------------
// The nested AST — what the parser produces, one level up from the flat,
// jump-based instructions the interpreter actually runs (see types.ts).
// A separate compile step (compiler.ts) lowers this tree into that flat
// form, the same way a real compiler lowers if/else and loops into gotos.
// ---------------------------------------------------------------------------

export interface Pos {
  line: number;
}

export interface NarratorLine extends Pos {
  kind: "narrator";
  text: string;
}

export interface SpeakerLine extends Pos {
  kind: "speaker";
  speaker: string;
  text: string;
}

export interface Assign extends Pos {
  kind: "assign";
  name: string;
  op: "=" | "+=" | "-=";
  value: string;
}

/** Any `name(args);` statement — jump(x), bg(x), show(a, b), hide(a), ... */
export interface Call extends Pos {
  kind: "call";
  name: string;
  args: string[];
}

export interface If extends Pos {
  kind: "if";
  /** Raw text between the parens — may be a full && / || expression; see condition.ts. */
  condition: string;
  then: Statement[];
  /** A single nested `If` here means this was `else if`, not a real second branch — see parser.ts's parseIf. */
  else: Statement[];
}

export interface ChoiceOption extends Pos {
  text: string;
  /** jump-form: `"text" -> target;` */
  target?: string;
  /** inline-form: `"text" { ...statements... }` */
  body?: Statement[];
}

export interface Choice extends Pos {
  kind: "choice";
  options: ChoiceOption[];
}

export type Statement = NarratorLine | SpeakerLine | Assign | Call | If | Choice;

export interface LabelDecl extends Pos {
  name: string;
  body: Statement[];
}

export interface ParseError {
  line: number;
  message: string;
}

export interface Program {
  labels: LabelDecl[];
  errors: ParseError[];
}
