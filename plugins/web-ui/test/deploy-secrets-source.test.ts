import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "deploys.ts"), "utf8");

test("the secrets UI has no input that could carry a value — pasting happens on the drop form", () => {
  const secretsSection = src.slice(src.indexOf("function deploySecretsSection"), src.indexOf("async function restoreDeploy"));
  assert.ok(secretsSection.length > 0, "the secrets section exists");
  assert.ok(!secretsSection.includes('type="password"'), "no password input lives in the app shell");
  assert.match(secretsSection, /placeholder="API_KEY"/, "the only input collects the env key, not the value");
  assert.equal(
    (secretsSection.match(/<input/g) ?? []).length,
    1,
    "exactly one input — the env key; the value never enters this page",
  );
});

test("the secrets UI renders the salted digest and never a raw fingerprint", () => {
  assert.match(src, /A salted digest, not the value/);
  assert.ok(!src.includes("s.fingerprint"), "the view model has no fingerprint to render");
});

test("setting a secret goes through a drop link rather than posting the value to the BFF", () => {
  const addFn = src.slice(src.indexOf("async function addDeploySecret"), src.indexOf("async function deleteDeploySecret"));
  assert.match(addFn, /secrets\/drop/, "it mints a drop");
  assert.deepEqual(
    addFn.match(/JSON\.stringify\([^)]*\)/g),
    ["JSON.stringify({ envKey })"],
    "the only serialized payload is the env key — the value never reaches the BFF",
  );
});
