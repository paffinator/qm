import { test } from "node:test";
import assert from "node:assert/strict";
import { appDatabaseName, createPostgresAppDatabase, type StoredAppDatabase } from "../src/deploy/app-database.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

const ADMIN_URL = process.env.APP_DB_ADMIN_URL;
const skip = ADMIN_URL ? false : "set APP_DB_ADMIN_URL to a Postgres whose role can CREATE ROLE";

let seq = 0;
const freshId = (): string => {
  seq += 1;
  const tag = `${process.pid.toString(16)}${seq.toString(16).padStart(2, "0")}`.slice(-12).padStart(12, "0");
  return `3f2a1b4c-5d6e-7f80-9a1b-${tag}`;
};

const pooled = (process.env.APP_DB_ADMIN_URL ?? "").includes(".pooler.");

function subject(backing = createMemoryMap<StoredAppDatabase>()) {
  return {
    backing,
    db: createPostgresAppDatabase({
      adminUrl: ADMIN_URL!,
      maxConnections: 5,
      backing,
      keyMaterial: "app-database-pg-test-key",
    }),
  };
}

async function asApp(url: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pool = createPgPool(url, [], { max: 1 });
  try {
    return await pool.q(sql, params);
  } finally {
    await pool.close();
  }
}

async function urlFor(db: ReturnType<typeof subject>["db"], id: string): Promise<string> {
  await db.ensure(id);
  const resolved = await db.resolve(id);
  const url = resolved.DATABASE_URL;
  assert.ok(url, "a provisioned app has a DATABASE_URL");
  return url;
}

test("provisioning is idempotent and creates exactly one role and schema", { skip }, async () => {
  const { db } = subject();
  const APP_A = freshId();
  try {
    await db.ensure(APP_A);
    await db.ensure(APP_A);
    await Promise.all([db.ensure(APP_A), db.ensure(APP_A), db.ensure(APP_A)]);

    const schema = appDatabaseName(APP_A);
    const roles = await asApp(ADMIN_URL!, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [schema]);
    const schemas = await asApp(ADMIN_URL!, "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1", [schema]);
    assert.equal(roles[0]!.n, 1, "one login role");
    assert.equal(schemas[0]!.n, 1, "one schema");
  } finally {
    await db.destroy(APP_A);
    await db.close();
  }
});

test("an app's unqualified DDL lands in its own schema, and it cannot reach another app's", { skip }, async () => {
  const { db } = subject();
  const APP_A = freshId();
  const APP_B = freshId();
  try {
    const urlA = await urlFor(db, APP_A);
    const urlB = await urlFor(db, APP_B);

    await asApp(urlA, "CREATE TABLE secrets_a(id int primary key, note text)");
    await asApp(urlA, "INSERT INTO secrets_a VALUES (1, 'private to A')");

    const placed = await asApp(urlA, "SELECT schemaname FROM pg_tables WHERE tablename = 'secrets_a'");
    assert.equal(placed[0]!.schemaname, appDatabaseName(APP_A), "search_path put the table in the app's own schema");

    const rows = await asApp(urlA, "SELECT note FROM secrets_a");
    assert.equal(rows[0]!.note, "private to A", "the app reads its own data unqualified");

    await assert.rejects(
      () => asApp(urlB, `SELECT * FROM ${appDatabaseName(APP_A)}.secrets_a`),
      /permission denied/i,
      "app B cannot read app A's rows",
    );
  } finally {
    await db.destroy(APP_A);
    await db.destroy(APP_B);
    await db.close();
  }
});

test("an app role cannot create schemas, roles, or escape into public", { skip }, async () => {
  const { db } = subject();
  const APP_A = freshId();
  try {
    const url = await urlFor(db, APP_A);

    await assert.rejects(() => asApp(url, "CREATE SCHEMA sneaky"), /permission denied/i, "no schema creation");
    await assert.rejects(() => asApp(url, "CREATE ROLE sneaky LOGIN"), /permission denied/i, "no role creation");
    await assert.rejects(
      () => asApp(url, "CREATE TABLE public.sneaky(id int)"),
      /permission denied/i,
      "public is not writable",
    );

    const su = await asApp(
      url,
      "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(su[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false }, "no elevated attributes");
  } finally {
    await db.destroy(APP_A);
    await db.close();
  }
});

test("a lost stored URL is reprovisioned; behind a pooler the rotated credential is cached", { skip }, async () => {
  const { backing, db } = subject();
  const APP_A = freshId();
  try {
    const first = await urlFor(db, APP_A);
    await asApp(first, "CREATE TABLE keeper(id int)");

    await backing.delete(APP_A);
    const second = await urlFor(db, APP_A);
    assert.notEqual(second, first, "a fresh password was minted");

    if (pooled) {
      await assert.rejects(
        () => asApp(second, "SELECT 1"),
        /password|authenticat/i,
        "documented limitation: a connection pooler serves a cached credential, so a rotated password is rejected until that cache expires — recovery-by-rotation does not work behind Supavisor",
      );
      return;
    }

    const kept = await asApp(second, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'keeper'");
    assert.equal(kept[0]!.n, 1, "rotation preserves the schema and its data");
    await assert.rejects(() => asApp(first, "SELECT 1"), /password|authenticat/i, "the old password no longer works");
  } finally {
    await db.destroy(APP_A);
    await db.close();
  }
});

test("destroy removes the schema and the role, and ensure can rebuild afterwards", { skip }, async () => {
  const { db } = subject();
  const APP_A = freshId();
  try {
    await db.ensure(APP_A);
    await db.destroy(APP_A);

    const schema = appDatabaseName(APP_A);
    const roles = await asApp(ADMIN_URL!, "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1", [schema]);
    const schemas = await asApp(ADMIN_URL!, "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1", [schema]);
    assert.equal(roles[0]!.n, 0, "role dropped");
    assert.equal(schemas[0]!.n, 0, "schema dropped");

    await db.ensure(APP_A);
    const again = await asApp(ADMIN_URL!, "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1", [schema]);
    assert.equal(again[0]!.n, 1, "provisioning after teardown works");
  } finally {
    await db.destroy(APP_A);
    await db.close();
  }
});
