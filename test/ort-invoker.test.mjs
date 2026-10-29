// The build replaces Embind's `new Function` invoker with aegisCreateInvoker.
// Check that both produce the same calls and results for every kind of invoker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INVOKER_HELPER } from "../src/vendor/ort-patches.js";

const aegisCreateInvoker = new Function(`${INVOKER_HELPER}; return aegisCreateInvoker;`)();

// Mirrors the generator in ort-wasm-simd-threaded.asyncify.mjs (function Pb).
function original(argCount, kind, returnsValue, env) {
  const k = { toValue: env.toValue };
  const args = Array.from({ length: argCount }, (_, p) => {
    const name = `argFromPtr${p}`;
    k[name] = env.readArg;
    return `${name}(args${p ? "+" + 8 * p : ""})`;
  });
  let h;
  switch (kind) {
    case 0: h = "toValue(handle)"; break;
    case 2: h = "new (toValue(handle))"; break;
    case 3: h = ""; break;
    case 1: k.getStringOrSymbol = env.getStringOrSymbol; h = "toValue(handle)[getStringOrSymbol(methodName)]";
  }
  h += `(${args})`;
  if (returnsValue) {
    k.toReturnWire = env.toReturnWire;
    k.emval_returnValue = env.emval_returnValue;
    h = `return emval_returnValue(toReturnWire, destructorsRef, ${h})`;
  }
  h = `return function (handle, methodName, destructorsRef, args) {\n  ${h}\n  }`;
  return { invoker: new Function(Object.keys(k), h)(...Object.values(k)), k };
}

let log = [];
class Target {
  constructor(...a) { this.made = a; }
  method(...a) { log.push(["method", this === target, a]); return a.reduce((x, y) => x + y, 0); }
}
const target = new Target();
const fn = (...a) => { log.push(["fn", a]); return a.length; };
const values = { 1: fn, 2: target, 3: Target };

function makeEnv() {
  return {
    toValue: (h) => values[h],
    readArg: (ptr) => ptr * 10,
    getStringOrSymbol: (m) => (m === 7 ? "method" : "?"),
    toReturnWire: { wire: true },
    emval_returnValue: (wire, destructors, value) => ({ wire, destructors, value }),
  };
}

const cases = [
  { kind: 0, handle: 1 },
  { kind: 1, handle: 2 },
  { kind: 2, handle: 3 },
  { kind: 3, handle: 1 },
];

for (const { kind, handle } of cases) {
  for (const returnsValue of [true, false]) {
    for (const argCount of kind === 3 ? [1, 3] : [0, 1, 3]) {
      test(`kind ${kind}, ${argCount} args, ${returnsValue ? "returns" : "void"}`, () => {
        const a = original(argCount, kind, returnsValue, makeEnv());
        const b = original(argCount, kind, returnsValue, makeEnv());
        const patched = aegisCreateInvoker(b.k, kind);
        log = [];
        const ra = a.invoker(handle, 7, 99, 100);
        const logA = log;
        log = [];
        const rb = patched(handle, 7, 99, 100);
        assert.deepEqual(rb, ra);
        assert.deepEqual(log, logA);
        assert.ok(logA.length > 0 || kind >= 2);
      });
    }
  }
}
