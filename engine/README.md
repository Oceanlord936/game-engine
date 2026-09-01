# engine

A from-scratch visual novel engine — really a small interpreted language for
VN scripts. See `../visual-novel-plan.md` for the overall game vision and
`C:\Users\ocean\.claude\plans\luminous-foraging-oasis.md` for the engine
build plan this project follows.

## Status

Core engine (everything except rendering) is done:

- [x] Milestone 1 — `.vns` parser + AST (`src/parser.ts`, `src/ast.ts`)
- [x] Milestone 1.5 — compiler: lowers the nested AST to a flat, jump-based
      instruction stream (`src/compiler.ts`, `src/types.ts`)
- [x] Milestone 2 — headless interpreter (`src/interpreter.ts`)
- [x] Milestone 5 — save/load (`Interpreter.save()`/`.load()`, backed by
      JSON files on disk via `src/play.ts`'s `save`/`load` commands)
- [x] `&&` / `||` and `else if` in conditions (`src/condition.ts`)
- [x] Generic handoff seam for external systems (combat, etc.) — any call
      the interpreter doesn't implement itself suspends via a `handoff`
      event, resolved by `resolveHandoff()`; see "The handoff seam" below
- [ ] Milestone 3 — React render shell
- [ ] Milestone 4 — images
- [ ] Milestone 6 — `characters.yaml`

## Scripts

- `npm start` / `npm run play:demo` — play `stories/demo.vns` (the longer,
  multi-ending test story) interactively in the terminal
- `npm run play:sample` — play the smaller tutorial story instead
- `npm test` — run all unit tests (parser, compiler, interpreter, save/load,
  and a full playthrough test of every ending in `demo.vns` — vitest)
- `npm run parse:sample` — print the parsed AST (pass a path to check a
  different file, e.g. `node --experimental-strip-types src/run-sample.ts stories/demo.vns`)
- `npm run compile:sample` — print the compiled flat instruction stream
  (the clearest way to see how `if`/`else` and `choice` actually lower to
  jumps — read this after reading the AST output; also takes a path arg)

### Playing interactively (`src/play.ts`)

At any prompt: **Enter** advances, a **number** picks a choice, and three
commands work anywhere:

- `vars` — print every variable's current value (the main tool for
  confirming state changes did what you expected)
- `save` — write interpreter state to `saves/<story>.save.json`
- `load` — restore it (works across separate runs of the program — save,
  close the terminal, reopen it, `load` picks up exactly where you left off)
- `quit` — exit

`stories/demo.vns` is built with three distinct endings reachable through
different choice combinations (see the comment at the top of the file) —
good for exercising `save`/`load`/`vars` against real branching state.

## The pipeline

```
.vns source text
      │  src/parser.ts (recursive descent)
      ▼
nested AST (src/ast.ts)     — labels containing statements, if/else nested, etc.
      │  src/compiler.ts (lowering, same technique a real compiler uses
      │  for if/else → conditional jumps; else-if is pure parser sugar,
      │  so it lowers via the exact same code path as plain if/else)
      ▼
flat instruction stream (src/types.ts)   — sequence + jumps only, no nesting
      │  src/interpreter.ts (the VM: instruction pointer, variable state,
      │  pauses on `choice` until choose(), or on any external call until
      │  resolveHandoff())
      ▼
EngineEvent stream (text / choice / handoff / end)
```

Conditions (`if (...)` and `${... ? a : b}`) are their own small
sub-language, parsed lazily wherever they're used — see `src/condition.ts`.
Neither the story parser nor the compiler know `&&`/`||` exist; they just
carry the condition around as a raw string, same as they always have.

### The handoff seam

`set` and `jump` are the only two things the interpreter has real code
for — everything else you call (`bg(x)`, `battle(a, b)`, a name that
doesn't exist yet) unconditionally suspends the story and hands off to
whatever's driving the interpreter, via a `{ type: "handoff", name, args }`
event. There's no hardcoded list of "which external systems exist" inside
the language — the interpreter can't tell the difference between a
cosmetic call that resolves instantly and a whole turn-based battle that
takes ten minutes; that's entirely the host's decision. `src/play.ts`'s
`handoffHandlers` table is where those decisions live: a plain
`Record<string, (args) => Promise<Record<string, string|number>>>`.
`bg`/`show` resolve trivially (nothing to report back). `rps` is the
first handler that actually computes something and reports it back —
`stories/demo.vns`'s `afternoon_walk` label has a rock-paper-scissors
choice option (`rps(alice);`) whose both sides are picked at random in
TypeScript, never by the player; the result flows back as
`rps_result`/`rps_player_choice`/`rps_opponent_choice` and the story
reacts to it with ordinary `if`/`else if` and adjusts `trust` accordingly
— the same shape a real battle handler would use, just with much simpler
rules. A future `battle` handler plugs into this same table without
touching the parser, compiler, or interpreter at all. See
`visual-novel-plan.md`'s "story language" section for the full reasoning
behind this boundary.

## Script format (`.vns`)

Deliberately shaped like a subset of Java/TypeScript — braces for blocks,
semicolons for statements, `if`/`else`, function-call syntax for calls,
and `${...}` interpolation exactly like a TS template literal. Dialogue text
is the one place that stays lightweight (no semicolons, no quotes) since
that's what you're writing most of the time.

```
label chapter1_start {
  The rain hadn't stopped in three days.
  Alice: You're late again, ${trust > 3 ? "old friend" : "stranger"}.

  trust += 1;

  if (trust > 5 && curiosity > 3) {
    Alice: Nothing much, actually.
    bg(sunny_street);
  } else if (secret_found == 1) {
    Alice: Keep this between us, okay?
    bg(rainy_street);
  } else {
    Alice: Everything, apparently.
    bg(rainy_street);
  }

  show(alice, neutral);

  choice {
    "Apologize" {
      Alice: ...I guess that's fine.
      trust += 1;
    }
    "Deflect" -> deflect_branch;
  }

  jump(chapter1_start);
}
```

- **Bare line** = narrator text. **`Name: text`** = speaker line (`Name` is
  identifier-style, no spaces — that's what keeps `3:00` in narration from
  misreading as a speaker called "3").
- **`label name { ... }`** = a named, jumpable block — the unit of story
  structure.
- **`name = value;` / `name += value;` / `name -= value;`** = variable
  assignment.
- **`name(args);`** = a call. `jump(x);` is handled by the interpreter
  directly; anything else (`bg`, `show`, `battle`, ...) suspends the story
  as a `handoff` event for whatever's driving the interpreter to resolve —
  see "The handoff seam" above. New calls never require a parser change.
- **`if (cond) { ... } else if (cond) { ... } else { ... }`** = gates a
  whole block of statements, not just text. `else if` chains as many times
  as you like; `else` is optional. `cond` can combine comparisons with
  `&&`/`||` (standard precedence — `&&` binds tighter than `||`, same as
  Java/TS/C — but no `(...)` grouping for sub-expressions yet).
- **`choice { "text" -> target; ... }`** = presents options. Each option is
  either a jump to another label, or an inline `{ ... }` reaction that runs
  in place and then continues the story afterward.
- **`// ...`** = full-line comment.
- **`${name}`** = variable interpolation. **`${cond ? "a" : "b"}`** =
  ternary (same `cond` grammar as `if`, `&&`/`||` included), for small
  inline text variation that doesn't need a whole `if`/`else` block.

### What the language deliberately doesn't have (yet)

- Parenthesized sub-grouping in conditions — `(a || b) && c` doesn't parse
  (the tokenizer doesn't recognize `(`/`)` as tokens at all, so it's a
  clear parse error, not silently wrong precedence). Only needed once a
  condition genuinely can't be phrased as `&&`-of-`||`-groups.
- Expressions on the right of `=`/`+=` beyond a literal (no `x = y + 1;`).
- Call/return — `jump()` never comes back, so there's no reusable
  "sub-scene" you can jump into and return from.
- Compact one-line blocks — `if (x) { foo(); }` on a single line doesn't
  parse. A block's opening `{` must end its line, and a closing `}` (or
  `} else {` / `} else if (...) {`) must be alone on its own line. This is
  a parser limitation (it works line-by-line, not as a full tokenizer), not
  a design choice — but it costs nothing in practice since dialogue
  naturally wants its own line anyway.

None of the missing-language-feature items were needed for `demo.vns`;
add them when a real story actually needs one.
