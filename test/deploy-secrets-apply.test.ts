import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeploySecretStore, type DeploySecret } from "../src/deploy/deploy-secrets.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { AppDatabase } from "../src/deploy/app-database.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

interface Harness {
  ensures: string[];
  destroys: string[];
  applies: number;
}

function svc(opts: { appDatabase?: boolean } = {}) {
  const deployStore = createDeployStore();
  const backing = createMemoryMap<DeploySecret>();
  const secrets = createDeploySecretStore({ backing, keyMaterial: "apply-test-key" });
  const seen: Harness = { ensures: [], destroys: [], applies: 0 };
  const order: string[] = [];

  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      seen.applies++;
      order.push("apply");
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  };

  const appDatabase: AppDatabase = {
    envVar: "DATABASE_URL",
    ensure: async (id) => {
      seen.ensures.push(id);
      order.push("ensure");
    },
    resolve: async () => ({ DATABASE_URL: "postgres://provisioned" }),
    destroy: async (id) => {
      seen.destroys.push(id);
    },
    sweep: async () => {},
    close: async () => {},
  };

  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "secrets-apply-")),
    secrets,
    ...(opts.appDatabase === false ? {} : { appDatabase }),
  });

  return { deploy, deployStore, secrets, seen, order };
}

const owner = scopeId("personal", "U1");

async function publish(deploy: ReturnType<typeof svc>["deploy"]) {
  return deploy.deploy({ ownerScopeId: owner, createdBy: "U1", entrypoint: "node server.js", files: [] });
}

test("the app database is ensured before the app is applied, on every deploy path", async () => {
  const { deploy, order, seen } = svc();
  const d = await publish(deploy);

  assert.deepEqual(order.slice(0, 2), ["ensure", "apply"], "provisioning precedes the app starting");
  assert.deepEqual(seen.ensures, [d.id]);

  await deploy.restartDeployment(d.id);
  assert.equal(seen.ensures.length, 2, "a restart re-ensures");
  assert.deepEqual(order, ["ensure", "apply", "ensure", "apply"]);
});

test("a failing provision fails the deploy instead of booting an app without its database", async () => {
  const deployStore = createDeployStore();
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {},
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "secrets-fail-")),
    appDatabase: {
      envVar: "DATABASE_URL",
      ensure: async () => {
        throw new Error("supabase project is paused");
      },
      resolve: async () => ({}),
      destroy: async () => {},
      sweep: async () => {},
      close: async () => {},
    },
  });

  await assert.rejects(
    () => deploy.deploy({ ownerScopeId: owner, createdBy: "U1", entrypoint: "x", files: [] }),
    /supabase project is paused/,
  );
});

test("archiving and reaping never drop the app's database — restore has to work", async () => {
  const { deploy, seen } = svc();
  const d = await publish(deploy);

  await deploy.archiveDeployment(d.id);
  await deploy.reapIdleDeployments(60_000, Date.now() + 1_000_000);
  assert.deepEqual(seen.destroys, [], "no schema is dropped by a reversible operation");
});

test("a rotated secret cannot be resurrected by rolling back to an older version", async () => {
  const { deploy, secrets } = svc();
  const d = await publish(deploy);

  await secrets.put({ deploymentId: d.id, envKey: "API_KEY", value: "old", source: "publish", setBy: "U1" });
  await deploy.redeploy(d.id, { entrypoint: "node server.js", files: [] });
  await secrets.put({ deploymentId: d.id, envKey: "API_KEY", value: "new", source: "publish", setBy: "U1" });

  await deploy.rollbackDeployment(d.id, 1);

  assert.deepEqual(
    await secrets.resolve(d.id),
    { API_KEY: "new" },
    "secrets are current, not versioned — a rollback moves code, never credentials",
  );
});

test("DATABASE_URL is the platform's to set — a caller cannot write it as a secret", async () => {
  const { deploy } = svc();
  const d = await publish(deploy);

  await assert.rejects(
    () =>
      deploy.setSecret({
        deploymentId: d.id,
        envKey: "DATABASE_URL",
        value: "postgres://attacker/",
        source: "publish",
        setBy: "U1",
      }),
    /provisioned by the platform/,
  );
});

test("setSecret refuses a key the runtime owns, and one that is not a shell identifier", async () => {
  const { deploy } = svc();
  const d = await publish(deploy);

  for (const envKey of ["PORT", "HOME", "DATA_DIR"]) {
    await assert.rejects(
      () => deploy.setSecret({ deploymentId: d.id, envKey, value: "v", source: "publish", setBy: "U1" }),
      /set by the runtime/,
      `${envKey} is refused`,
    );
  }
  await assert.rejects(
    () => deploy.setSecret({ deploymentId: d.id, envKey: "A=B", value: "v", source: "publish", setBy: "U1" }),
    /invalid env key/,
  );
});

test("setting a secret restarts a running app; an unchanged re-set does not", async () => {
  const { deploy, seen } = svc();
  const d = await publish(deploy);
  const appliesAfterPublish = seen.applies;

  await deploy.setSecret({ deploymentId: d.id, envKey: "API_KEY", value: "v", source: "publish", setBy: "U1" });
  assert.equal(seen.applies, appliesAfterPublish + 1, "a new secret restarts the app so it picks the value up");

  await deploy.setSecret({ deploymentId: d.id, envKey: "API_KEY", value: "v", source: "publish", setBy: "U1" });
  assert.equal(seen.applies, appliesAfterPublish + 1, "re-setting the same value restarts nothing");

  await deploy.setSecret({ deploymentId: d.id, envKey: "API_KEY", value: "w", source: "publish", setBy: "U1" });
  assert.equal(seen.applies, appliesAfterPublish + 2, "a rotation restarts");
});

test("a stopped app is not restarted — it re-resolves on its next boot", async () => {
  const { deploy, seen } = svc();
  const d = await publish(deploy);
  await deploy.archiveDeployment(d.id);
  const before = seen.applies;

  await deploy.setSecret({ deploymentId: d.id, envKey: "API_KEY", value: "v", source: "publish", setBy: "U1" });
  assert.equal(seen.applies, before, "nothing is applied while the app is not running");
});

test("the database env var is advertised on the profile only when a database is wired", async () => {
  assert.equal(svc().deploy.providerProfile.databaseUrlEnv, "DATABASE_URL");
  assert.equal(svc({ appDatabase: false }).deploy.providerProfile.databaseUrlEnv, undefined);
});
