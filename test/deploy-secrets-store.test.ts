import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDeploySecretStore, type DeploySecret } from "../src/deploy/deploy-secrets.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const KEY = "unit-test-secret-key-material";
const ID = "11111111-2222-3333-4444-555555555555";

function store(backing: DurableMap<DeploySecret> = createMemoryMap<DeploySecret>(), keyMaterial = KEY) {
  return { backing, secrets: createDeploySecretStore({ backing, keyMaterial }) };
}

test("a value round-trips, and never sits in the durable row as plaintext", async () => {
  const { backing, secrets } = store();
  await secrets.put({ deploymentId: ID, envKey: "API_KEY", value: "sk-live-abc123", source: "publish", setBy: "u1" });

  assert.deepEqual(await secrets.resolve(ID), { API_KEY: "sk-live-abc123" });

  const raw = JSON.stringify(await backing.entries());
  assert.ok(!raw.includes("sk-live-abc123"), "the plaintext value is absent from the stored row");
  assert.ok(!raw.includes("live-abc"), "no substring of the value survives either");
});

test("views carry a salted digest and never the fingerprint or the value", async () => {
  const { secrets } = store();
  await secrets.put({ deploymentId: ID, envKey: "A", value: "same-value", source: "publish", setBy: "u1" });
  await secrets.put({ deploymentId: ID, envKey: "B", value: "same-value", source: "publish", setBy: "u1" });

  const views = await secrets.list(ID);
  assert.deepEqual(
    views.map((v) => v.envKey),
    ["A", "B"],
    "listed in a stable order",
  );
  assert.ok(!("fingerprint" in views[0]!), "the raw fingerprint stays server-side");
  assert.notEqual(views[0]!.digest, views[1]!.digest, "the same value under two keys does not disclose reuse");
  assert.ok(!JSON.stringify(views).includes("same-value"), "no view carries the value");
});

test("re-setting an identical value reports no change, so nothing restarts for nothing", async () => {
  const { secrets } = store();
  const first = await secrets.put({ deploymentId: ID, envKey: "A", value: "v", source: "publish", setBy: "u1" });
  assert.deepEqual({ changed: first.changed, created: first.created }, { changed: true, created: true });

  const same = await secrets.put({ deploymentId: ID, envKey: "A", value: "v", source: "publish", setBy: "u1" });
  assert.deepEqual({ changed: same.changed, created: same.created }, { changed: false, created: false });

  const rotated = await secrets.put({ deploymentId: ID, envKey: "A", value: "w", source: "publish", setBy: "u1" });
  assert.deepEqual({ changed: rotated.changed, created: rotated.created }, { changed: true, created: false });
  assert.deepEqual(await secrets.resolve(ID), { A: "w" });
});

test("a row encrypted under a different key is skipped, and its siblings still resolve", async () => {
  const backing = createMemoryMap<DeploySecret>();
  const other = createDeploySecretStore({ backing, keyMaterial: randomBytes(32) });
  await other.put({ deploymentId: ID, envKey: "UNREADABLE", value: "x", source: "publish", setBy: "u1" });

  const { secrets } = store(backing);
  await secrets.put({ deploymentId: ID, envKey: "READABLE", value: "y", source: "publish", setBy: "u1" });

  assert.deepEqual(await secrets.resolve(ID), { READABLE: "y" }, "one bad row cannot stop an app booting");
  assert.deepEqual(
    (await secrets.list(ID)).map((v) => v.envKey),
    ["READABLE"],
  );
});

test("secrets are scoped to their deployment", async () => {
  const { secrets } = store();
  await secrets.put({ deploymentId: ID, envKey: "A", value: "mine", source: "publish", setBy: "u1" });
  await secrets.put({ deploymentId: "99999999-0000-0000-0000-000000000000", envKey: "A", value: "theirs", source: "publish", setBy: "u2" });

  assert.deepEqual(await secrets.resolve(ID), { A: "mine" });
});

test("remove reports whether anything was there, and putIfAbsent never overwrites", async () => {
  const { secrets } = store();
  assert.equal(await secrets.remove(ID, "GONE"), false);

  assert.equal(await secrets.putIfAbsent({ deploymentId: ID, envKey: "A", value: "first", source: "legacy", setBy: "migration" }), true);
  assert.equal(await secrets.putIfAbsent({ deploymentId: ID, envKey: "A", value: "second", source: "legacy", setBy: "migration" }), false);
  assert.deepEqual(await secrets.resolve(ID), { A: "first" });

  assert.equal(await secrets.remove(ID, "A"), true);
  assert.deepEqual(await secrets.resolve(ID), {});
});

test("reassign stamps who the secrets came from so an inheriting owner can be told", async () => {
  const { secrets } = store();
  await secrets.put({ deploymentId: ID, envKey: "A", value: "v", source: "publish", setBy: "u1" });
  await secrets.put({ deploymentId: ID, envKey: "B", value: "w", source: "publish", setBy: "u1" });

  const from = scopeId("personal", "u1");
  const views = await secrets.reassign(ID, from);
  assert.deepEqual(
    views.map((v) => v.inheritedFrom),
    [from, from],
  );
  assert.deepEqual(await secrets.resolve(ID), { A: "v", B: "w" }, "reassign does not disturb the values");
});
