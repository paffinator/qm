import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage } from "../util/errors.ts";
import type { ScopeId } from "../types.ts";

export type DeploySecretSource = "provision" | "publish" | "web" | "layer" | "legacy";

export interface DeploySecret {
  deploymentId: string;
  envKey: string;
  secretEnc: string;
  fingerprint: string;
  source: DeploySecretSource;
  setBy: string;
  credentialId?: string;
  inheritedFrom?: ScopeId;
  createdAt: number;
  updatedAt: number;
}

export interface DeploySecretView {
  envKey: string;
  digest: string;
  source: DeploySecretSource;
  setBy: string;
  updatedAt: number;
  credentialId?: string;
  inheritedFrom?: ScopeId;
}

export interface DeploySecretPutInput {
  deploymentId: string;
  envKey: string;
  value: string;
  source: DeploySecretSource;
  setBy: string;
  credentialId?: string;
}

export interface DeploySecretStore {
  list(deploymentId: string): Promise<DeploySecretView[]>;
  resolve(deploymentId: string): Promise<Record<string, string>>;
  put(input: DeploySecretPutInput): Promise<{ view: DeploySecretView; changed: boolean; created: boolean }>;
  putIfAbsent(input: DeploySecretPutInput): Promise<boolean>;
  remove(deploymentId: string, envKey: string): Promise<boolean>;
  reassign(deploymentId: string, inheritedFrom: ScopeId): Promise<DeploySecretView[]>;
  fingerprintOf(value: string): string;
  usingCredential(credentialId: string): Promise<DeploySecretRef[]>;
}

export interface DeploySecretRef {
  deploymentId: string;
  envKey: string;
}

const rowId = (deploymentId: string, envKey: string): string => `${deploymentId}:${envKey}`;

const fingerprintOf = (value: string): string => hashId([value]);

const digestOf = (deploymentId: string, envKey: string, value: string): string =>
  hashId([deploymentId, envKey, value], 8);

function viewOf(rec: DeploySecret, value: string): DeploySecretView {
  return {
    envKey: rec.envKey,
    digest: digestOf(rec.deploymentId, rec.envKey, value),
    source: rec.source,
    setBy: rec.setBy,
    updatedAt: rec.updatedAt,
    ...(rec.credentialId ? { credentialId: rec.credentialId } : {}),
    ...(rec.inheritedFrom ? { inheritedFrom: rec.inheritedFrom } : {}),
  };
}

export function createDeploySecretStore(input: {
  backing: DurableMap<DeploySecret>;
  keyMaterial: string | Buffer;
}): DeploySecretStore {
  const key = deriveConnectorKey(input.keyMaterial, "deploy-secrets");

  async function rowsOf(deploymentId: string): Promise<DeploySecret[]> {
    const prefix = `${deploymentId}:`;
    const entries = await input.backing.entries();
    return entries.filter(([id]) => id.startsWith(prefix)).map(([, rec]) => rec);
  }

  function decrypt(rec: DeploySecret): string | null {
    try {
      return decryptSecret(rec.secretEnc, key);
    } catch (e) {
      console.warn(
        `deploy-secrets: cannot decrypt ${rec.deploymentId}:${rec.envKey} — skipping (${errMessage(e)})`,
      );
      return null;
    }
  }

  return {
    async list(deploymentId) {
      const rows = await rowsOf(deploymentId);
      return rows
        .map((rec) => {
          const value = decrypt(rec);
          return value === null ? null : viewOf(rec, value);
        })
        .filter((v): v is DeploySecretView => v !== null)
        .sort((a, b) => a.envKey.localeCompare(b.envKey));
    },

    async resolve(deploymentId) {
      const rows = await rowsOf(deploymentId);
      const out: Record<string, string> = {};
      for (const rec of rows) {
        const value = decrypt(rec);
        if (value !== null) out[rec.envKey] = value;
      }
      return out;
    },

    async put({ deploymentId, envKey, value, source, setBy, credentialId }) {
      const id = rowId(deploymentId, envKey);
      const existing = await input.backing.get(id);
      const fingerprint = fingerprintOf(value);
      const changed = existing?.fingerprint !== fingerprint;
      const now = Date.now();
      const rec: DeploySecret = {
        deploymentId,
        envKey,
        secretEnc: changed ? encryptSecret(value, key) : existing!.secretEnc,
        fingerprint,
        source,
        setBy,
        ...(credentialId ? { credentialId } : {}),
        ...(existing?.inheritedFrom ? { inheritedFrom: existing.inheritedFrom } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: changed ? now : (existing?.updatedAt ?? now),
      };
      await input.backing.put(id, rec);
      return { view: viewOf(rec, value), changed, created: !existing };
    },

    async putIfAbsent({ deploymentId, envKey, value, source, setBy }) {
      const id = rowId(deploymentId, envKey);
      const now = Date.now();
      const rec: DeploySecret = {
        deploymentId,
        envKey,
        secretEnc: encryptSecret(value, key),
        fingerprint: fingerprintOf(value),
        source,
        setBy,
        createdAt: now,
        updatedAt: now,
      };
      if (input.backing.insertIfAbsent) return input.backing.insertIfAbsent(id, rec);
      if (await input.backing.get(id)) return false;
      await input.backing.put(id, rec);
      return true;
    },

    async remove(deploymentId, envKey) {
      const id = rowId(deploymentId, envKey);
      if (input.backing.deleteIf) return input.backing.deleteIf(id, () => true);
      const existing = await input.backing.get(id);
      if (!existing) return false;
      await input.backing.delete(id);
      return true;
    },

    fingerprintOf,

    async usingCredential(credentialId) {
      const entries = await input.backing.entries();
      return entries
        .filter(([, rec]) => rec.credentialId === credentialId)
        .map(([, rec]) => ({ deploymentId: rec.deploymentId, envKey: rec.envKey }));
    },

    async reassign(deploymentId, inheritedFrom) {
      const rows = await rowsOf(deploymentId);
      const views: DeploySecretView[] = [];
      for (const rec of rows) {
        const updated = await input.backing.merge(rowId(deploymentId, rec.envKey), { inheritedFrom });
        const value = decrypt(updated ?? rec);
        if (value !== null) views.push(viewOf(updated ?? rec, value));
      }
      return views.sort((a, b) => a.envKey.localeCompare(b.envKey));
    },
  };
}
