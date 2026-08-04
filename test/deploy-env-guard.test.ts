import { test } from "node:test";
import assert from "node:assert/strict";
import { deployEnvEntries, deployEnvKeyError, isDeployEnvKey, RESERVED_APP_ENV } from "../src/deploy/deploy-env.ts";

const NUL = String.fromCharCode(0);

test("env keys the runtime owns are refused, and so is anything that is not a shell identifier", () => {
  for (const reserved of RESERVED_APP_ENV) {
    assert.equal(isDeployEnvKey(reserved), false, `${reserved} is set by the runtime`);
    assert.match(deployEnvKeyError(reserved), /set by the runtime/);
  }
  for (const bad of ["A=B", "a b", "1A", "", "A-B", "A.B", "A;B"]) {
    assert.equal(isDeployEnvKey(bad), false, `${JSON.stringify(bad)} is not a shell identifier`);
  }
  for (const good of ["A", "_A", "API_KEY", "a1", "DATABASE_URL"]) {
    assert.equal(isDeployEnvKey(good), true, `${good} is usable`);
  }
});

test("entries merge left-to-right so platform-resolved secrets win over published env", () => {
  const entries = deployEnvEntries({ A: "published", B: "kept" }, { A: "resolved" });
  assert.deepEqual(Object.fromEntries(entries), { A: "resolved", B: "kept" });
});

test("entries drop unusable keys and NUL values instead of smuggling them into argv", () => {
  const entries = deployEnvEntries({
    "A=B": "smuggled",
    "2BAD": "no",
    PORT: "3000",
    HOME: "/tmp/evil",
    HAS_NUL: `before${NUL}after`,
    OK: "yes",
  });
  assert.deepEqual(Object.fromEntries(entries), { OK: "yes" });
});

test("values that are awkward for a shell survive — quoting is the caller's job, not filtering", () => {
  const entries = deployEnvEntries({ A: "a'b", B: "$(whoami)", C: "line1\nline2", D: "" });
  assert.deepEqual(Object.fromEntries(entries), { A: "a'b", B: "$(whoami)", C: "line1\nline2", D: "" });
});

test("undefined env maps contribute nothing", () => {
  assert.deepEqual(deployEnvEntries(undefined, undefined), []);
});
