import { test } from "node:test";
import assert from "node:assert/strict";
import { appDatabaseName, parseAdminUrl } from "../src/deploy/app-database.ts";

const ID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";

test("a deployment id becomes a legal, dot-free Postgres identifier", () => {
  const name = appDatabaseName(ID);
  assert.equal(name, "app_3f2a1b4c5d6e7f809a1b2c3d4e5f6071");
  assert.match(name, /^[a-z][a-z0-9_]*$/, "usable unquoted, and legal quoted");
  assert.ok(!name.includes("."), "Supavisor parses the tenant from the last dot in the username");
  assert.ok(Buffer.byteLength(name) <= 63, "inside NAMEDATALEN");
});

test("the identifier is derived from the id, so renaming an app cannot orphan its schema", () => {
  assert.equal(appDatabaseName(ID), appDatabaseName(ID.toUpperCase()));
});

test("an id that cannot yield an identifier is refused rather than quietly mangled", () => {
  assert.throws(() => appDatabaseName("----"), /cannot derive a Postgres identifier/);
  assert.throws(() => appDatabaseName(""), /cannot derive a Postgres identifier/);
});

test("the pooler admin URL is parsed into the parts needed to mint an app URL", () => {
  const parts = parseAdminUrl("postgres://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
  assert.deepEqual(parts, {
    host: "aws-0-us-east-1.pooler.supabase.com",
    port: "5432",
    database: "postgres",
    projectRef: "abcdefghijklmnop",
    sslmode: "require",
  });
});

test("Supabase's direct host is refused, because it is IPv6-only without the paid add-on", () => {
  assert.throws(
    () => parseAdminUrl("postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres"),
    /IPv6-only|Session pooler/,
  );
});

test("a non-postgres or unparseable URL is refused at the boundary", () => {
  assert.throws(() => parseAdminUrl("https://example.com"), /must be a postgres:\/\/ URL/);
  assert.throws(() => parseAdminUrl("not a url"), /not a valid postgres:\/\/ URL/);
});

test("a plain Postgres URL with no project-ref user still parses (RDS and local dev)", () => {
  const parts = parseAdminUrl("postgresql://postgres:pw@127.0.0.1:5433/appdb");
  assert.deepEqual(parts, { host: "127.0.0.1", port: "5433", database: "appdb", sslmode: "require" });
});

test("TLS defaults to require, and an app inherits whatever the operator's own URL uses", () => {
  assert.equal(parseAdminUrl("postgres://postgres:pw@host:5432/db").sslmode, "require", "secure by default");
  assert.equal(
    parseAdminUrl("postgres://postgres:pw@127.0.0.1:5433/db?sslmode=disable").sslmode,
    "disable",
    "a local Postgres without TLS is reachable when the operator says so explicitly",
  );
});
