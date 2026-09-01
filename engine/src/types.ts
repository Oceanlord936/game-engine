// ---------------------------------------------------------------------------
// The flat, jump-based instruction stream — the "bytecode" the interpreter
// actually executes. compiler.ts lowers the nested ast.ts tree down to this;
// nothing here knows about blocks or nesting, only sequence + jumps, same
// as a real compiler's output.
// ---------------------------------------------------------------------------

export interface SourcePos {
  line: number;
}

export interface LineInstruction extends SourcePos {
  type: "line";
  text: string;
}

export interface SpeakerInstruction extends SourcePos {
  type: "speaker";
  speaker: string;
  text: string;
}

export interface LabelInstruction extends SourcePos {
  type: "label";
  name: string;
}

export interface CommandInstruction extends SourcePos {
  type: "command";
  name: string;
  args: string;
}

/** Jumps to `target` when `condition` evaluates to false — how if/else (including else-if chains) gets lowered to gotos. */
export interface CondJumpInstruction extends SourcePos {
  type: "condjump";
  /** Raw text, possibly a full && / || expression — parsed and evaluated by condition.ts at runtime, not here. */
  condition: string;
  target: string;
}

export interface ChoiceOption {
  text: string;
  /** Always resolvable to a label — either the author's own target, or a synthetic one the compiler generated for an inline reaction. */
  target: string;
}

export interface ChoiceInstruction extends SourcePos {
  type: "choice";
  options: ChoiceOption[];
}

export type Instruction =
  | LineInstruction
  | SpeakerInstruction
  | LabelInstruction
  | CommandInstruction
  | CondJumpInstruction
  | ChoiceInstruction;

export interface CompileResult {
  instructions: Instruction[];
}
