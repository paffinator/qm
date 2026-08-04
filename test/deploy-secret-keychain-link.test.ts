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
import type { AuditEvent } from "../src/audit/audit-log.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

const KEYCHAIN_VALUE = "sk-live-the-granted-one";
const CRED_ID = "cred-abc";

function svc(opts: { withKeychain?: boolean } = {}) {
  const deployStore = createDeployStore();
  const backing = createMemoryMap<DeploySecret>();
  const secrets = createDeploySecretStore({ backing, keyMaterial: "keychain-link-test" });
  const events: AuditEvent[] = [];
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {},
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: {
      record(e) {
        events.push(e);
      },
      events: async () => [],
      tail: async () => [],
    },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "keychain-link-")),
    secrets,
    ...(opts.withKeychain === false
      ? {}
      : {
          credentialFingerprints: async () => [
            { id: CRED_ID, fingerprint: secrets.fingerprintOf(KEYCHAIN_VALUE) },
          ],
        }),
  });
  return { deploy, secrets, events };
}

const owner = scopeId("personal", "U1");

async function publish(deploy: ReturnType<typeof svc>["deploy"], env?: Record<string, string>) {
  return deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [],
    ...(env ? { env } : {}),
  });
}

test("baking a keychain credential into an app is attributed and audited", async () => {
  const { deploy, events } = svc();
  const d = await publish(deploy, { API_KEY: KEYCHAIN_VALUE });

  const baked = events.filter((e) => e.action === "deploy.secret.credential_baked");
  assert.equal(baked.length, 1, "the invisible-leak path now leaves a record");
  assert.equal(baked[0]!.detail, CRED_ID, "the audit names which credential travelled");

  const listed = await deploy.listSecrets(d.id);
  assert.equal(listed[0]!.credentialId, CRED_ID, "the secret is linked back to its credential");
});

test("a value that matches no credential is stored without a spurious link", async () => {
  const { deploy, events } = svc();
  const d = await publish(deploy, { API_KEY: "something-nobody-granted" });

  assert.equal(events.filter((e) => e.action === "deploy.secret.credential_baked").length, 0);
  assert.equal((await deploy.listSecrets(d.id))[0]!.credentialId, undefined);
});

test("revocation can report where a credential is still live, without taking the app down", async () => {
  const { deploy } = svc();
  const d = await publish(deploy, { API_KEY: KEYCHAIN_VALUE });

  const stillLive = await deploy.secretsUsingCredential(CRED_ID);
  assert.deepEqual(stillLive, [{ deploymentId: d.id, envKey: "API_KEY" }]);
  assert.deepEqual(
    (await deploy.listSecrets(d.id)).map((s) => s.envKey),
    ["API_KEY"],
    "reporting is not deleting — a revoked grant must not silently break someone else's app",
  );
});

test("deleting the credential cascades: the secret is removed and the removal is audited", async () => {
  const { deploy, secrets, events } = svc();
  const d = await publish(deploy, { API_KEY: KEYCHAIN_VALUE, OTHER: "unrelated" });

  const purged = await deploy.purgeSecretsForCredential(CRED_ID);
  assert.deepEqual(purged, [{ deploymentId: d.id, envKey: "API_KEY" }]);
  assert.deepEqual(await secrets.resolve(d.id), { OTHER: "unrelated" }, "only the linked key is removed");

  const audited = events.filter((e) => e.action === "deploy.secret.revoked_with_credential");
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.detail, CRED_ID);
});

test("a transformed value is NOT matched — this is a known gap, not prevention", async () => {
  const { deploy, events } = svc();
  const d = await publish(deploy, { AUTH_HEADER: `Bearer ${KEYCHAIN_VALUE}` });

  assert.equal(
    events.filter((e) => e.action === "deploy.secret.credential_baked").length,
    0,
    "fingerprinting is exact-value only, so wrapping a key hides it",
  );
  assert.equal((await deploy.listSecrets(d.id))[0]!.credentialId, undefined);
  assert.deepEqual(await deploy.secretsUsingCredential(CRED_ID), [], "revocation cannot see it either");
});

test("with no keychain wired, secrets still store and nothing pretends to be linked", async () => {
  const { deploy, events } = svc({ withKeychain: false });
  const d = await publish(deploy, { API_KEY: KEYCHAIN_VALUE });

  assert.equal(events.filter((e) => e.action === "deploy.secret.credential_baked").length, 0);
  assert.equal((await deploy.listSecrets(d.id))[0]!.envKey, "API_KEY");
});
