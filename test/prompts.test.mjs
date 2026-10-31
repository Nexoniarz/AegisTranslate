import { test } from "node:test";
import assert from "node:assert/strict";
import { loopCut, cleanOutput } from "../src/prompts.js";

const stopAt = (s) => {
  const cut = loopCut(s);
  return cut < 0 ? null : s.slice(0, cut);
};

test("cuts the repetition seen on a dense comic page", () => {
  const head = "「即ち『フム』\n";
  const loop = "『フム』『フム』\n".repeat(30);
  assert.equal(stopAt(head + loop), head + "『フム』『フム』\n");
});

test("detects a loop at any point of a streamed chunk", () => {
  const full = "Intro line\n" + "the end. ".repeat(40);
  for (let n = full.length - 9; n <= full.length; n++) {
    const kept = stopAt(full.slice(0, n));
    assert.ok(kept, `missed loop at length ${n}`);
    assert.ok(kept.startsWith("Intro line\nthe end."));
    assert.ok(kept.length < 40, kept);
  }
});

test("cuts long repeated sentences", () => {
  const sentence = "We will be back on Monday, thank you for your patience and understanding. ";
  assert.equal(stopAt("Closed.\n" + sentence.repeat(5)), "Closed.\n" + sentence);
});

test("keeps real text with some repetition", () => {
  for (const s of [
    "火事だ火事だ",
    "ha ha ha ha ha ha",
    "『フム』\n『フム』\n『フム』",
    "Buffalo buffalo Buffalo buffalo buffalo buffalo Buffalo buffalo",
    "1. Item\n2. Item\n3. Item\n4. Item",
    "—".repeat(30),
    "",
  ]) {
    assert.equal(loopCut(s), -1, s);
  }
});

test("cleanOutput hides reasoning blocks", () => {
  assert.equal(cleanOutput("<think>\n\n</think>\n\nHello"), "Hello");
  assert.equal(cleanOutput("Hi <think>still thinking"), "Hi");
});
