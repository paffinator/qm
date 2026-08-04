import type { DeployStore } from "./deploy-store.ts";
import type { DeploySecretStore } from "./deploy-secrets.ts";
import { isDeployEnvKey } from "./deploy-env.ts";
import { errMessage } from "../util/errors.ts";

export interface MigrateDeploySecretsResult {
  deployments: number;
  imported: number;
  stripped: number;
}

export async function migrateDeploySecrets(input: {
  deployStore: DeployStore;
  secrets: DeploySecretStore;
}): Promise<MigrateDeploySecretsResult> {
  const result: MigrateDeploySecretsResult = { deployments: 0, imported: 0, stripped: 0 };
  for (const d of await input.deployStore.list()) {
    const current = d.versions.find((v) => v.version === d.currentVersion);
    const legacy = Object.entries(current?.env ?? {});
    const anyEnv = d.versions.some((v) => v.env && Object.keys(v.env).length > 0);
    if (!anyEnv) continue;
    result.deployments++;
    try {
      for (const [envKey, value] of legacy) {
        if (!isDeployEnvKey(envKey)) continue;
        const inserted = await input.secrets.putIfAbsent({
          deploymentId: d.id,
          envKey,
          value,
          source: "legacy",
          setBy: d.createdBy,
        });
        if (inserted) result.imported++;
      }
      if (await input.deployStore.stripVersionEnv(d.id)) result.stripped++;
    } catch (e) {
      console.warn(`deploy-secrets: migration of ${d.id} failed, leaving it for the next boot (${errMessage(e)})`);
    }
  }
  if (result.deployments) {
    console.log(
      `[deploy-secrets] migrated ${result.imported} env vars from ${result.deployments} apps into the encrypted store (${result.stripped} stripped of plaintext)`,
    );
  }
  return result;
}
