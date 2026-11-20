#!/usr/bin/env node
import { loadConfig } from "../src/config.ts";
import { appDatabaseName } from "../src/deploy/app-database.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const args = process.argv.slice(2);
const apply = args.includes("--yes");
const olderThanArg = args.find((a) => a.startsWith("--older-than="));
const olderThanDays = olderThanArg ? Number(olderThanArg.split("=")[1]) : undefined;

if (olderThanArg && (!Number.isFinite(olderThanDays) || olderThanDays! < 0)) {
  console.error("--older-than=<days> must be a non-negative number");
  process.exit(2);
}

const config = loadConfig();
if (!config.appDb) {
  console.error("APP_DB_ADMIN_URL is not set — there are no app schemas to collect");
  process.exit(2);
}
if (!config.databaseUrl) {
  console.error("DATABASE_URL is not set — cannot read the deployment list to decide what is orphaned");
  process.exit(2);
}

const deployStore = createDeployStore({
  deployments: createPostgresMapFactory(config.databaseUrl).map<Deployment>("deployments"),
  git: { repoRoot: config.deployGitDir },
});
const pg = createPgPool(config.appDb.adminUrl, [], { max: 2 });

const deployments = await deployStore.list();
const live = new Map<string, Deployment>();
for (const d of deployments) live.set(appDatabaseName(d.id), d);

const rows = await pg.q("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%'");
const schemas = rows.map((r) => String(r.nspname));

const cutoff = olderThanDays === undefined ? undefined : Date.now() - olderThanDays * 24 * 60 * 60_000;
const orphans: Array<{ schema: string; reason: string }> = [];
for (const schema of schemas) {
  const d = live.get(schema);
  if (!d) {
    orphans.push({ schema, reason: "no deployment owns it" });
    continue;
  }
  if (d.status === "archived" && cutoff !== undefined) {
    const lastTouch = d.lastAccessAt ?? d.versions.at(-1)?.createdAt ?? 0;
    if (lastTouch < cutoff) {
      orphans.push({ schema, reason: `archived, last touched ${new Date(lastTouch).toISOString()}` });
    }
  }
}

console.log(`${schemas.length} app schemas, ${live.size} deployments, ${orphans.length} collectable`);
for (const o of orphans)
  console.log(`  ${o.schema} — ${o.reason}${live.get(o.schema)?.name ? ` (${live.get(o.schema)!.name})` : ""}`);

if (!orphans.length) {
  await pg.close();
  process.exit(0);
}
if (!apply) {
  console.log("\nDry run. Re-run with --yes to DROP these schemas and roles. This destroys their data.");
  await pg.close();
  process.exit(0);
}

for (const { schema } of orphans) {
  const ident = `"${schema}"`;
  await pg.q(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
  await pg.q(`DROP ROLE IF EXISTS ${ident}`);
  console.log(`dropped ${schema}`);
}
await pg.close();
