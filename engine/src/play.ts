import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { Interpreter, type EngineEvent, type SaveData } from "./interpreter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storyArg = process.argv[2] ?? "stories/demo.vns";
const storyPath = join(__dirname, "..", storyArg);
const source = readFileSync(storyPath, "utf-8");

const savesDir = join(__dirname, "..", "saves");
const saveFile = join(savesDir, `${basename(storyArg, extname(storyArg))}.save.json`);

const interpreter = Interpreter.fromSource(source);
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`=== ${basename(storyArg)} ===`);
console.log('Commands: [Enter] continue  ·  a number to choose  ·  "vars"  ·  "save"  ·  "load"  ·  "quit"\n');

function printVars(): void {
  if (interpreter.variables.size === 0) {
    console.log("  (no variables set yet)");
    return;
  }
  for (const [name, value] of interpreter.variables) {
    console.log(`  ${name} = ${JSON.stringify(value)}`);
  }
}

function doSave(): void {
  if (!existsSync(savesDir)) mkdirSync(savesDir, { recursive: true });
  writeFileSync(saveFile, JSON.stringify(interpreter.save(), null, 2), "utf-8");
  console.log(`  (saved to ${saveFile})`);
}

function doLoad(): boolean {
  if (!existsSync(saveFile)) {
    console.log(`  (no save file at ${saveFile})`);
    return false;
  }
  const data = JSON.parse(readFileSync(saveFile, "utf-8")) as SaveData;
  interpreter.load(data);
  console.log(`  (loaded from ${saveFile})`);
  return true;
}

function printChoiceOptions(options: string[]): void {
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
}

/**
 * What handles an opaque call name when the interpreter hands one off.
 * The interpreter has no idea what any of these mean or how long they take
 * — that's entirely this table's business. A trivial one (bg/show here)
 * resolves instantly and feels like nothing happened; a real one (a future
 * battle handler) can run its own async loop, prompt the player, whatever
 * it needs, before resolving. Both look identical to the interpreter.
 */
type HandoffHandler = (args: string[]) => Promise<Record<string, string | number>>;

const RPS_MOVES = ["rock", "paper", "scissors"] as const;
type RpsMove = (typeof RPS_MOVES)[number];

/** True when `a` beats `b` in rock-paper-scissors. */
function rpsBeats(a: RpsMove, b: RpsMove): boolean {
  return (a === "rock" && b === "scissors") || (a === "paper" && b === "rock") || (a === "scissors" && b === "paper");
}

const handoffHandlers: Record<string, HandoffHandler> = {
  bg: async (args) => {
    console.log(`  [bg ${args.join(" ")}]`);
    return {};
  },
  show: async (args) => {
    console.log(`  [show ${args.join(" ")}]`);
    return {};
  },
  // Both sides picked at random here, never by the player — the story
  // only ever sees the outcome (rps_result/rps_player_choice/
  // rps_opponent_choice), the same shape a real battle handler would use.
  rps: async (args) => {
    const opponent = args[0] ?? "your opponent";
    const playerChoice = RPS_MOVES[Math.floor(Math.random() * RPS_MOVES.length)];
    const opponentChoice = RPS_MOVES[Math.floor(Math.random() * RPS_MOVES.length)];
    const result = playerChoice === opponentChoice ? "tie" : rpsBeats(playerChoice, opponentChoice) ? "win" : "lose";
    console.log(`  [rps you:${playerChoice} ${opponent}:${opponentChoice} -> ${result}]`);
    return { rps_result: result, rps_player_choice: playerChoice, rps_opponent_choice: opponentChoice };
  },
};

async function handleHandoff(name: string, args: string[]): Promise<Record<string, string | number>> {
  const handler = handoffHandlers[name];
  if (handler) return handler(args);
  console.log(`  [unhandled call: ${name}(${args.join(", ")}) — no handler registered, continuing]`);
  return {};
}

/**
 * Runs the interpreter forward, resolving handoffs along the way, until it
 * reaches something that needs a person: text (needs an "advance") or a
 * choice (needs a pick) — or the story ends. Returns that event so the
 * caller assigns it directly; returning (rather than mutating a shared
 * variable as a side effect) is what keeps TS's narrowing on that variable
 * reliable at every call site below.
 */
async function advance(): Promise<EngineEvent> {
  while (true) {
    const event = interpreter.next();

    if (event.type === "handoff") {
      const result = await handleHandoff(event.name, event.args);
      interpreter.resolveHandoff(result);
      continue;
    }
    if (event.type === "text") {
      console.log(event.speaker ? `${event.speaker}: ${event.text}` : event.text);
      return event;
    }
    if (event.type === "choice") {
      printChoiceOptions(event.options);
      return event;
    }
    console.log("-- end of story --");
    return event;
  }
}

const isCommand = (s: string): boolean => s === "vars" || s === "save" || s === "load" || s === "quit";

let lastEvent: EngineEvent = await advance();

if (lastEvent.type !== "end") {
  for await (const rawLine of rl) {
    const input = rawLine.trim();
    const lower = input.toLowerCase();

    if (isCommand(lower)) {
      if (lower === "vars") {
        printVars();
      } else if (lower === "save") {
        doSave();
      } else if (lower === "load") {
        if (doLoad()) {
          // State just moved out from under whatever was on screen —
          // don't try to interpret the next line against stale options.
          lastEvent = await advance();
          if (lastEvent.type === "end") break;
        }
      } else if (lower === "quit") {
        console.log("  (bye)");
        break;
      }
      if (lastEvent.type === "choice" && lower !== "load") printChoiceOptions(lastEvent.options);
      continue;
    }

    if (lastEvent.type === "choice") {
      const index = Number(input) - 1;
      if (Number.isInteger(index) && index >= 0 && index < lastEvent.options.length) {
        interpreter.choose(index);
      } else {
        console.log("  (type a number, or one of: vars / save / load / quit)");
        continue;
      }
    }

    lastEvent = await advance();
    if (lastEvent.type === "end") break;
  }
}

rl.close();
