import { describe, it, expect } from "vitest";
import { Interpreter } from "../src/interpreter.ts";

describe("Interpreter", () => {
  it("walks narrator and speaker lines in order", () => {
    const vm = Interpreter.fromSource(
      ["label a {", "The rain hadn't stopped.", "Alice: You're late.", "}"].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", text: "The rain hadn't stopped." });
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "You're late." });
    expect(vm.next()).toEqual({ type: "end" });
  });

  it("applies assignment silently — a single next() runs both sets and lands on the text after them", () => {
    const vm = Interpreter.fromSource(
      ["label a {", "trust = 1;", "trust += 1;", "Trust is ${trust}.", "}"].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", text: "Trust is 2." });
    expect(vm.variables.get("trust")).toBe(2);
  });

  it("resolves a ${cond ? a : b} ternary to the true branch when the condition holds", () => {
    const vm = Interpreter.fromSource(
      ["label a {", "trust = 5;", 'Alice: ${trust > 3 ? "Nothing much." : "Everything."}', "}"].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "Nothing much." });
  });

  it("resolves a ${cond ? a : b} ternary to the false branch when the condition fails", () => {
    const vm = Interpreter.fromSource(
      ["label a {", "trust = 1;", 'Alice: ${trust > 3 ? "Nothing much." : "Everything."}', "}"].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "Everything." });
  });

  it("gates an if-block on && — both sides must hold", () => {
    const source = [
      "label a {",
      "trust = 5;",
      "curiosity = 0;",
      "if (trust > 3 && curiosity > 1) {",
      "Alice: both",
      "}",
      "Alice: after",
      "}",
    ].join("\n");
    const vm = Interpreter.fromSource(source);
    // curiosity > 1 is false, so the whole block (and everything leading
    // up to it — both assignments, the condjump) is silent, landing here.
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "after" });
  });

  it("gates an if-block on || — either side is enough", () => {
    const source = [
      "label a {",
      "trust = 0;",
      "secret_found = 1;",
      "if (trust > 5 || secret_found == 1) {",
      "Alice: either",
      "}",
      "}",
    ].join("\n");
    const vm = Interpreter.fromSource(source);
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "either" });
  });

  it("resolves a ${a && b ? x : y} ternary using the same && / || grammar as if", () => {
    const source = [
      "label a {",
      "trust = 5;",
      "curiosity = 3;",
      'Alice: ${trust > 3 && curiosity > 1 ? "both" : "not both"}',
      "}",
    ].join("\n");
    const vm = Interpreter.fromSource(source);
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "both" });
  });

  it("routes through an else-if chain to the matching branch", () => {
    const source = [
      "label a {",
      "trust = 3;",
      "secret_found = 1;",
      "if (trust > 5) {",
      "Alice: friend",
      "} else if (secret_found == 1) {",
      "Alice: mystery",
      "} else {",
      "Alice: distant",
      "}",
      "}",
    ].join("\n");
    const vm = Interpreter.fromSource(source);
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "mystery" });
  });

  it("skips an entire if-block, not just text, when the condition is false", () => {
    const vm = Interpreter.fromSource(
      [
        "label a {",
        "trust = 1;",
        "if (trust > 3) {",
        "Alice: only if trusted",
        "}",
        "Alice: always runs",
        "}",
      ].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "always runs" });
  });

  it("runs the if-block (and skips the else) when the condition is true", () => {
    const vm = Interpreter.fromSource(
      [
        "label a {",
        "trust = 5;",
        "if (trust > 3) {",
        "Alice: trusted branch",
        "} else {",
        "Alice: untrusted branch",
        "}",
        "Alice: always runs",
        "}",
      ].join("\n"),
    );
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "trusted branch" });
    // the synthetic jump(__if0_end) that skips the else-body is silent now too
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "always runs" });
  });

  it("runs the else-block when the condition is false", () => {
    const vm = Interpreter.fromSource(
      ["label a {", "trust = 1;", "if (trust > 3) {", "Alice: trusted", "} else {", "Alice: untrusted", "}", "}"].join(
        "\n",
      ),
    );
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "untrusted" });
  });

  describe("handoff (any call that isn't set/jump)", () => {
    it("surfaces an unrecognized call as a handoff, resolved by resolveHandoff()", () => {
      const vm = Interpreter.fromSource(
        ["label a {", "bg(rainy_street);", "show(alice, neutral);", "}"].join("\n"),
      );
      expect(vm.next()).toEqual({ type: "handoff", name: "bg", args: ["rainy_street"] });
      vm.resolveHandoff();
      expect(vm.next()).toEqual({ type: "handoff", name: "show", args: ["alice", "neutral"] });
      vm.resolveHandoff();
    });

    it("repeats the same handoff on every next() until resolveHandoff() is called", () => {
      const vm = Interpreter.fromSource(["label a {", "battle(alice, goblin);", "}"].join("\n"));
      const handoffEvent = vm.next();
      expect(handoffEvent).toEqual({ type: "handoff", name: "battle", args: ["alice", "goblin"] });
      expect(vm.next()).toEqual(handoffEvent); // not resolved yet — same event again
      vm.resolveHandoff();
      expect(vm.next()).toEqual({ type: "end" });
    });

    it("merges resolveHandoff()'s result vars into story state before continuing", () => {
      const vm = Interpreter.fromSource(
        ["label a {", "battle(alice, goblin);", "Alice: ${last_battle_result}", "}"].join("\n"),
      );
      vm.next(); // the handoff
      vm.resolveHandoff({ last_battle_result: "win", alice_hp: 42 });
      expect(vm.variables.get("last_battle_result")).toBe("win");
      expect(vm.variables.get("alice_hp")).toBe(42);
      expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "win" });
    });

    it("throws when resolveHandoff() is called with no pending handoff", () => {
      const vm = Interpreter.fromSource(["label a {", "Alice: hi", "}"].join("\n"));
      expect(() => vm.resolveHandoff()).toThrow(/without a pending handoff/);
    });
  });

  it("presents a choice, repeats it until choose() is called, then follows the jump-form option", () => {
    const vm = Interpreter.fromSource(
      [
        "label a {",
        "choice {",
        '"Apologize" -> apologize_branch;',
        '"Deflect" -> deflect_branch;',
        "}",
        "}",
        "label apologize_branch {",
        "Alice: ...fine.",
        "}",
        "label deflect_branch {",
        "Alice: Typical.",
        "}",
      ].join("\n"),
    );

    const choiceEvent = vm.next();
    expect(choiceEvent).toEqual({ type: "choice", options: ["Apologize", "Deflect"] });
    expect(vm.next()).toEqual(choiceEvent); // repeats until choose()

    vm.choose(0);
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "...fine." });
  });

  it("runs an inline-form choice option's body and falls through afterward", () => {
    const vm = Interpreter.fromSource(
      [
        "label a {",
        "choice {",
        '"Apologize" {',
        "Alice: ...fine.",
        "trust += 1;",
        "}",
        "}",
        "Alice: story continues",
        "}",
      ].join("\n"),
    );

    vm.next(); // choice event
    vm.choose(0);
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "...fine." });
    // trust += 1 and the synthetic jump(__choice0_end) are both silent now
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "story continues" });
    expect(vm.variables.get("trust")).toBe(1);
  });

  it("loops back around on jump()", () => {
    const vm = Interpreter.fromSource(["label start {", "Alice: hi", "jump(start);", "}"].join("\n"));
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "hi" });
    expect(vm.next()).toEqual({ type: "text", speaker: "Alice", text: "hi" }); // looped, silently
  });

  it("throws on an unknown jump target", () => {
    const vm = Interpreter.fromSource(["label a {", "jump(nowhere);", "}"].join("\n"));
    expect(() => vm.next()).toThrow(/Unknown label "nowhere"/);
  });

  it("throws when choose() is called with an out-of-range index", () => {
    const vm = Interpreter.fromSource(["label a {", "choice {", '"Only option" -> a;', "}", "}"].join("\n"));
    vm.next();
    expect(() => vm.choose(5)).toThrow(/out of range/);
  });

  it("refuses to run a story with parse errors", () => {
    expect(() => Interpreter.fromSource("Alice: not inside a label")).toThrow(/parse errors/);
  });

  describe("save/load", () => {
    const source = [
      "label a {",
      "trust = 1;",
      "Alice: first",
      "trust += 1;",
      "Alice: second",
      "trust += 1;",
      "Alice: third",
      "}",
    ].join("\n");

    it("restores position and variables to a fresh interpreter on the same story", () => {
      const original = Interpreter.fromSource(source);
      original.next(); // trust = 1; -> "first"
      original.next(); // trust += 1; (now 2) -> "second"

      const snapshot = original.save();
      expect(original.variables.get("trust")).toBe(2);

      // A brand new interpreter, as if the process restarted and the save
      // file was read back from disk — round-trips through JSON to prove
      // the snapshot really is plain, serializable data.
      const restored = Interpreter.fromSource(source);
      restored.load(JSON.parse(JSON.stringify(snapshot)));

      expect(restored.variables.get("trust")).toBe(2);
      expect(restored.next()).toEqual({ type: "text", speaker: "Alice", text: "third" });
    });

    it("round-trips a save taken while a choice is on screen", () => {
      const choiceSource = [
        "label a {",
        "choice {",
        '"Yes" -> yes_branch;',
        '"No" -> no_branch;',
        "}",
        "}",
        "label yes_branch {",
        "Alice: yes",
        "}",
        "label no_branch {",
        "Alice: no",
        "}",
      ].join("\n");

      const original = Interpreter.fromSource(choiceSource);
      const choiceEvent = original.next();
      expect(choiceEvent).toEqual({ type: "choice", options: ["Yes", "No"] });

      const snapshot = original.save();
      const restored = Interpreter.fromSource(choiceSource);
      restored.load(snapshot);

      // The same choice must still be pending after load, not skipped.
      expect(restored.next()).toEqual(choiceEvent);
      restored.choose(1);
      expect(restored.next()).toEqual({ type: "text", speaker: "Alice", text: "no" });
    });

    it("round-trips a save taken while a handoff is pending", () => {
      const battleSource = ["label a {", "battle(alice, goblin);", "Alice: done"].concat("}").join("\n");

      const original = Interpreter.fromSource(battleSource);
      const handoffEvent = original.next();
      expect(handoffEvent).toEqual({ type: "handoff", name: "battle", args: ["alice", "goblin"] });

      const snapshot = original.save();
      const restored = Interpreter.fromSource(battleSource);
      restored.load(JSON.parse(JSON.stringify(snapshot)));

      // The same handoff must still be pending after load, not skipped.
      expect(restored.next()).toEqual(handoffEvent);
      restored.resolveHandoff({ outcome: "win" });
      expect(restored.next()).toEqual({ type: "text", speaker: "Alice", text: "done" });
      expect(restored.variables.get("outcome")).toBe("win");
    });

    it("rejects save data with an out-of-range position", () => {
      const vm = Interpreter.fromSource(source);
      expect(() => vm.load({ pc: 999, vars: [], pendingOptions: null, pendingHandoff: null })).toThrow(
        /out-of-range/,
      );
    });
  });
});
