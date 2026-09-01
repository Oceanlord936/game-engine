import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Interpreter, type EngineEvent } from "../src/interpreter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "..", "stories", "demo.vns"), "utf-8");

/**
 * Plays a story to completion, picking `choiceIndices` in order at each
 * choice event. `resolveHandoffWith` controls what any handoff (bg, show,
 * rps, ...) resolves with — defaults to "nothing," which is correct for
 * the purely cosmetic bg/show calls but must be overridden for rps so
 * tests can pin down an otherwise-random outcome.
 */
function playThrough(
  choiceIndices: number[],
  resolveHandoffWith: (name: string, args: string[]) => Record<string, string | number> = () => ({}),
): { finalVars: ReadonlyMap<string, string | number>; texts: string[] } {
  const vm = Interpreter.fromSource(source);
  const texts: string[] = [];
  let choiceCursor = 0;
  let steps = 0;

  let event: EngineEvent = vm.next();
  while (event.type !== "end") {
    if (++steps > 500) throw new Error("playThrough exceeded step limit — likely an unintended loop");
    if (event.type === "text") {
      texts.push(event.text);
    } else if (event.type === "choice") {
      vm.choose(choiceIndices[choiceCursor++]);
    } else if (event.type === "handoff") {
      vm.resolveHandoff(resolveHandoffWith(event.name, event.args));
    }
    event = vm.next();
  }

  return { finalVars: vm.variables, texts };
}

describe("demo.vns — full playthroughs", () => {
  it("parses and compiles with zero errors", () => {
    expect(() => Interpreter.fromSource(source)).not.toThrow();
  });

  it("reaches ending_friend: ask about the door, then walk her home", () => {
    const { finalVars, texts } = playThrough([1, 0]); // ask about door; offer to walk home
    expect(finalVars.get("trust")).toBe(6);
    expect(finalVars.get("curiosity")).toBe(3);
    expect(finalVars.get("secret_found")).toBe(1);
    expect(texts).toContain("I'm glad you stayed today.");
    // afternoon's `curiosity > 1 && trust > 2` gate fired — both sides true
    expect(texts).toContain("Fine, I'll show you. Follow me.");
    // the closing `${trust > 5 || ... }` ternary — true via the *left* side (trust=6 > 5)
    expect(texts).toContain("This was worth it.");
  });

  it("reaches ending_mystery: ask about the door, then head home alone", () => {
    const { finalVars, texts } = playThrough([1, 1]); // ask about door; head home alone
    expect(finalVars.get("trust")).toBe(5);
    expect(finalVars.get("curiosity")).toBe(3);
    expect(finalVars.get("secret_found")).toBe(1);
    expect(texts).toContain("Keep the door between us, okay?");
    // trust=5 is NOT > 5, so the closing ternary is true only via the
    // *right* side (secret_found == 1) — the complementary case to the
    // ending_friend assertion above, proving || doesn't just always take
    // whichever side happens to be listed first.
    expect(texts).toContain("This was worth it.");
  });

  it("reaches ending_distant via the compliment path (never asks about the door)", () => {
    const { finalVars, texts } = playThrough([0, 1]); // compliment her; head home alone
    expect(finalVars.get("trust")).toBe(2);
    expect(finalVars.get("curiosity")).toBe(0);
    expect(finalVars.get("secret_found")).toBe(0);
    expect(texts).toContain("See you around, I guess.");
    // curiosity=0 fails the && gate, so the library-secret exchange never happens
    expect(texts).not.toContain("Fine, I'll show you. Follow me.");
    // neither side of the closing || holds: trust=2 isn't > 5, secret wasn't found
    expect(texts).toContain("Well, that happened.");
  });

  it("reaches ending_distant via the silent path", () => {
    const { finalVars, texts } = playThrough([2, 1]); // say nothing; head home alone
    expect(finalVars.get("trust")).toBe(-1);
    expect(texts).toContain("See you around, I guess.");
    expect(texts).toContain("Well, that happened.");
  });

  it("always prints a final stats line reflecting the live variables", () => {
    const { texts } = playThrough([1, 0]);
    expect(texts).toContain("Final trust score: 6");
    expect(texts).toContain("Final curiosity score: 3");
    expect(texts).toContain("Secret discovered: yes");
  });

  describe("rock-paper-scissors handoff (afternoon_walk, option index 2)", () => {
    // All three pin rps_result directly rather than letting src/play.ts's
    // real random handler run — the point here is proving the *story*
    // reacts correctly to whatever a handoff resolves with, independent of
    // how that result was produced.
    const rpsResolver =
      (result: "win" | "lose" | "tie") =>
      (name: string): Record<string, string | number> =>
        name === "rps" ? { rps_result: result, rps_player_choice: "rock", rps_opponent_choice: "scissors" } : {};

    it("winning pushes trust up enough to reach ending_friend", () => {
      const { finalVars, texts } = playThrough([1, 2], rpsResolver("win")); // ask about door; play rps
      expect(finalVars.get("rps_result")).toBe("win");
      expect(finalVars.get("trust")).toBe(7); // 3 (ask) + 1 (secret) + 2 (rps win) + 1 (evening bonus)
      expect(texts).toContain("...Lucky.");
      expect(texts).toContain("You threw rock. Alice threw scissors.");
      expect(texts).toContain("I'm glad you stayed today."); // ending_friend
    });

    it("losing pulls trust down, landing on ending_mystery instead", () => {
      const { finalVars, texts } = playThrough([1, 2], rpsResolver("lose"));
      expect(finalVars.get("trust")).toBe(4); // 3 + 1 - 1 (rps loss) + 1
      expect(texts).toContain("Ha! Told you.");
      expect(texts).toContain("Keep the door between us, okay?"); // ending_mystery
    });

    it("a tie leaves trust untouched by the handoff, also landing on ending_mystery", () => {
      const { finalVars, texts } = playThrough([1, 2], rpsResolver("tie"));
      expect(finalVars.get("trust")).toBe(5); // 3 + 1 + 0 (tie) + 1 — exactly the threshold, not past it
      expect(texts).toContain("A tie? Boring. Rematch later.");
      expect(texts).toContain("Keep the door between us, okay?"); // ending_mystery
    });

    it("is reachable from every morning choice, not just the ask-about-the-door path", () => {
      const { texts } = playThrough([0, 2], rpsResolver("win")); // compliment her; play rps
      expect(texts).toContain("You threw rock. Alice threw scissors.");
    });
  });
});
