# Game dev plan — AI-augmented visual novel

Supersedes `game-dev-plan.md` (2D bomb-platformer). That project revealed
that real-time action/physics/rigging is a huge, slow-feedback-loop
investment relative to the actual goal — practicing code and using
drawing to relax. This direction plays to both much more directly, and
gives the AI-chat integration idea a real home.

## Vision

A "next-gen visual novel": static art (player's own drawings), text-driven
interaction, built on the classic stat + schedule-management loop of
**Princess Maker** and **Tokimeki Memorial** — but the goal isn't to raise
a successful daughter or win someone's heart. There's a pre-written story
scenario with an authored cast of characters, and the player's actual goal
is to **disrupt that story, as absurdly as possible**, through freeform
interaction with the characters.

The core story, all characters, and all art are hand-authored by the
developer — never AI-generated. AI's only job is the reactive layer: giving
the player a genuine feeling of freedom to derail things, without handing
the narrative itself over to an LLM.

## Reference mechanics (verified, not guessed)

- **Princess Maker**: weekly/monthly schedule planning; activities raise
  stats and stress depending on how well they're performed; events unlock
  once specific stat/hobby conditions are met; curfew gates available time.
- **Tokimeki Memorial**: same time-management/stat-raising shape over a
  multi-year time span; activities (clubs, grooming) move stats; dialogue
  choices and outfit selection affect relationship outcomes.

Both run on a **discrete time-step** (week/month), not live real-time —
that cadence is what makes the AI layer tractable (see below).

## Core loop

1. Player manages a custom protagonist through a Princess-Maker-style
   schedule across discrete time steps (e.g., weekly).
2. Scheduled activities/courses move stats, same as the reference games.
3. **Authored events** trigger deterministically from state + time
   conditions — hand-written, fully under the developer's control, the
   backbone of the actual story.
4. **AI-mediated events** layer on top, seeded by player conversation and
   current state, generated to feel "as random as possible" within bounds
   the developer sets.

## The AI layer — constraints that keep it "reasonable"

The hard problem: once AI touches the story, it's no longer fully under
prebuilt code's control. The design bets on narrowing what the AI is
*for*, not on trying to fully constrain what it might say.

- **Protect character consistency, not plot consistency.** The player's
  goal is disruption — the plot going sideways is the point. What has to
  stay coherent is that each NPC still reacts like *themselves* to
  whatever absurd thing just happened, not generic improv filler. This is
  a narrower, more solvable prompting problem than "keep the whole
  narrative sensible."
- **Input is conversational only, never world-command.** The player can
  free-type dialogue *to a specific character* — never "make this
  character do X." Framing the input as a chat-with-NPC box (not an open
  command bar) narrows both what players attempt and what the filter has
  to check for.
- **A filter sits between raw player input and the AI/game state**,
  validating the input stays in conversational scope before anything
  downstream sees it.
- **Resolution is deferred, not instant.** Free-text input doesn't get an
  immediate live reply — it's banked and resolved at the next time-step
  (e.g., "the next day, word got around that..."). This reuses the
  reference games' existing discrete-time cadence as a buffer: the AI
  never needs to produce an instantly-coherent response under pressure,
  and a framed "news/rumor" surface can absorb a rougher AI output than a
  face-to-face reply would need to survive on its own.
- **AI output is structured, not just prose.** Alongside the actual
  flavor text, the AI also returns bounded, designer-defined fields (e.g.,
  which stat, a delta capped within a set range) that the deterministic
  game code applies. Flavor can be as unpredictable as it wants; the
  numbers stay inside limits the developer set. (The Claude API supports
  this directly — structured/tool-call output alongside free text in one
  request.)
- Classic multiple-choice dialogue (fully authored, fully controlled)
  stays available alongside — or instead of — the free-text option, so
  the game always has a fallback that needs zero AI involvement.

## Architecture sketch

- **Deterministic layer** (plain code, no AI): stats, time/schedule
  state, story flags/branches, which authored events are eligible to
  fire. This is the actual game — same shape as any stat-sim. Now built
  as a real interpreted language, `.vns` (see "The story language" below).
- **AI layer** (Claude API): given a character's personality/voice
  profile + current scene context + the player's free text, returns (a)
  in-character response/flavor text and (b) structured effect data
  (stat deltas within bounds, flags) for the deterministic layer to apply.
- **Filter layer**: validates free-text player input stays in
  conversational scope before it reaches the AI.
- **Event system**: a pool of authored (state+time triggered) events plus
  AI-seeded events derived from accumulated conversation history, both
  feeding the same deferred "next time-step" resolution.

## The story language — what `.vns` owns vs. delegates

The "Deterministic layer" above is no longer just a sketch — it's built,
as a real interpreted language (`engine/`; see `engine/README.md` for full
syntax and status). Building it surfaced a sharper version of that
original bullet, worth keeping as the standing rule for what goes into the
language itself versus what gets delegated to plain TypeScript.

**The core insight**: story sits at the top of the hierarchy, not
combat/map/rendering/AI. Those are all satellite systems that compute a
state change and hand it back; `.vns` only ever *sequences* and *reacts*,
never computes. A character was never a separate concept bolted on top —
`Name: text` made every character a first-class citizen from the very
first version of the parser. Narratively, a character is "a name that
speaks"; mechanically, a character is "a namespace of flat variables"
(`alice_hp`, `alice_affection_bob`) — two independent, minimal
representations connected only by sharing a name, with no unifying
"Character class" needed.

### What `.vns` needs to do (load-bearing)

| Capability | Mechanism | Status |
|---|---|---|
| Sequencing scenes | `label` / `jump` | done |
| Branch on player choice | `choice` | done |
| Branch on accumulated state | `if`/`else if`/`else`, `&&`/`\|\|` | done |
| Mutate state | assignment | done |
| Attribute dialogue to a character or narrator | `Name: text` / bare line | done |
| Reactive text without a full branch | `${...}` interpolation | done |
| Stop and resume without losing position | save/load | done |
| A defined seam for handing off to and back from external systems (combat, minigames, anything not-narrative) | `handoff` event / `resolveHandoff()` | done |

That last row matters as much as anything else on this list: combat, a
future map layer, any minigame — all of them need the same thing from the
language, a way to say "pause here, another system is in control now,
resume me with a result." Built as a generalization of the pattern
`choice` already used (`pendingOptions`/`choose()`): `set` and `jump` are
the only two calls the interpreter has real code for; every other call
name — `bg(x)`, a future `battle(a, b)`, anything that doesn't exist
yet — unconditionally suspends via a `{ type: "handoff", name, args }`
event and resumes via `resolveHandoff(resultVars)`. No hardcoded list of
"which external systems exist" lives in the interpreter; the set of
handlers for specific call names lives entirely in whatever's driving the
interpreter (`engine/src/play.ts`'s `handoffHandlers` table today). See
`engine/README.md`'s "The handoff seam" for the concrete shape.

### What `.vns` should do (real needs, no new capability required)

- Multi-character relationships (affection, trust per character) — more
  flat vars (`alice_affection_bob`), nothing new.
- Hidden/event-trigger flags, time/schedule state — a "turn" is just a
  backward jump; already fully expressible.
- Item possession affecting story branches — a story-level *verb*
  (`give(alice, ring_of_power);`) even though the item's defined effects
  live in TypeScript data, not in `.vns`.
- Time-gated compound events ("at week 12, if charm > 50, trigger X") —
  `&&` plus the turn-counter pattern.

### What `.vns` should explicitly never do (delegate to TypeScript)

- **Combat resolution** — damage formulas, turn order, AI. Computation,
  not sequencing.
- **Map navigation / pathfinding** — a different kind of system entirely,
  and not part of this game's design regardless.
- **Rendering** — `bg`/`show`/`hide` stay opaque directives; a render
  shell's job (still unbuilt — milestones 3/4 in `engine/README.md`).
- **Entity data modeling** — character sheets and item definitions belong
  in plain TypeScript data, not new `.vns` grammar.
- **General-purpose computation** — arbitrary expressions, first-class
  loops, functions with return values. The language stays deliberately
  short of Turing-complete; anything computationally heavy runs in
  TypeScript and gets *consulted* via a flat variable, never computed
  inline.
- **An open-ended "anything can pause the interpreter" framework** — the
  set of pausing operations stays small and enumerated (`choice` today,
  the general handoff seam next), not a configurable extensibility system
  nobody's asked for.

## Open questions to revisit

- Exact mechanism for the input filter (rules-based vs. a lightweight
  classification pass vs. both).
- Ratio of authored to AI-generated events, and how heavily AI events lean
  on accumulated conversation history vs. current stats/time alone.
- Data model for characters' personality/voice profiles (for AI prompting)
  and story beats — save state itself is solved (`engine/`'s save/load,
  see above).
- V1 scope: how many characters/storylines before calling it playable.
- Art pipeline: static portraits/backgrounds, player's own drawings —
  format and how many states per character are actually needed.
