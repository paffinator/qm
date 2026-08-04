import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeploySecretStore, type DeploySecret } from "../src/deploy/deploy-secrets.ts";
import { migrateDeploySecrets } from "../src/deploy/deploy-secret-migration.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

function fixture() {
  const deployments = createMemoryMap<Deployment>();
  const deployStore = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "secret-migration-")) },
  });
  const backing = createMemoryMap<DeploySecret>();
  const secrets = createDeploySecretStore({ backing, keyMaterial: "migration-test-key" });
  return { deployments, deployStore, secrets, backing };
}

async function withLegacyEnv(
  deployments: DurableMap<Deployment>,
  deployStore: ReturnType<typeof createDeployStore>,
  envByVersion: Array<Record<string, string>>,
) {
  const d = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
  });
  for (let i = 1; i < envByVersion.length; i++) {
    await deployStore.addVersion(d.id, { entrypoint: "node server.js", snapshotDir: `/snap/v${i + 1}` });
  }
  const stored = (await deployments.get(d.id))!;
  stored.versions = stored.versions.map((v, i) => ({ ...v, env: envByVersion[i] }));
  stored.currentVersion = envByVersion.length;
  await deployments.put(d.id, stored);
  return d.id;
}

test("legacy plaintext env is imported into the store and stripped from every version", async () => {
  const { deployments, deployStore, secrets } = fixture();
  const id = await withLegacyEnv(deployments, deployStore, [{ OLD: "v1-value" }, { API_KEY: "current", KEEP: "yes" }]);

  const result = await migrateDeploySecrets({ deployStore, secrets });
  assert.deepEqual(result, { deployments: 1, imported: 2, stripped: 1 });

  assert.deepEqual(
    await secrets.resolve(id),
    { API_KEY: "current", KEEP: "yes" },
    "only the current version's env is imported — older versions are dead config",
  );

  const after = (await deployments.get(id))!;
  assert.deepEqual(
    after.versions.map((v) => v.env),
    [undefined, undefined],
    "no version retains plaintext, including the historical one",
  );
});

test("the migration is idempotent and never overwrites a value set since", async () => {
  const { deployments, deployStore, secrets } = fixture();
  const id = await withLegacyEnv(deployments, deployStore, [{ API_KEY: "legacy" }]);

  await migrateDeploySecrets({ deployStore, secrets });
  await secrets.put({ deploymentId: id, envKey: "API_KEY", value: "rotated", source: "web", setBy: "U1" });

  const second = await migrateDeploySecrets({ deployStore, secrets });
  assert.deepEqual(second, { deployments: 0, imported: 0, stripped: 0 }, "nothing left to do");
  assert.deepEqual(await secrets.resolve(id), { API_KEY: "rotated" }, "a rotated value survives a re-run");
});

test("an app with no legacy env is left completely alone", async () => {
  const { deployments, deployStore, secrets } = fixture();
  const d = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    snapshotDir: "/snap",
  });
  const before = JSON.stringify(await deployments.get(d.id));

  const result = await migrateDeploySecrets({ deployStore, secrets });
  assert.deepEqual(result, { deployments: 0, imported: 0, stripped: 0 });
  assert.equal(JSON.stringify(await deployments.get(d.id)), before);
});

test("a legacy key that is not a usable env name is dropped rather than carried forward", async () => {
  const { deployments, deployStore, secrets } = fixture();
  const id = await withLegacyEnv(deployments, deployStore, [{ "A=B": "smuggled", PORT: "3000", GOOD: "v" }]);

  await migrateDeploySecrets({ deployStore, secrets });
  assert.deepEqual(await secrets.resolve(id), { GOOD: "v" });
});
