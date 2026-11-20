import { randomBytes } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { assertOneStatement, createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage } from "../util/errors.ts";

export const APP_DATABASE_ENV = "DATABASE_URL";

const APP_SSLMODE_DEFAULT = "no-verify";

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]+$/;
const SIZE_WARN_BYTES = 400 * 1024 * 1024;

export interface StoredAppDatabase {
  deploymentId: string;
  schema: string;
  urlEnc: string;
  createdAt: number;
  rotatedAt?: number;
}

export interface AppDatabase {
  readonly envVar: string;
  ensure(deploymentId: string): Promise<void>;
  resolve(deploymentId: string): Promise<Record<string, string>>;
  destroy(deploymentId: string): Promise<void>;
  sweep(): Promise<void>;
  close(): Promise<void>;
}

export function appDatabaseName(deploymentId: string): string {
  const suffix = deploymentId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  const name = `app_${suffix}`;
  if (!suffix || !NAME_RE.test(name)) {
    throw new Error(`cannot derive a Postgres identifier from deployment id "${deploymentId}"`);
  }
  return name;
}

function quoteIdent(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`refusing to use "${name}" as a Postgres identifier`);
  return `"${name}"`;
}

function generatePassword(): string {
  const pw = randomBytes(32).toString("base64url");
  if (!PASSWORD_RE.test(pw)) throw new Error("generated password is not shell/URL safe");
  return pw;
}

export interface AppDatabaseUrlParts {
  host: string;
  port: string;
  database: string;
  projectRef?: string;
  sslmode: string;
  sslmodeExplicit: boolean;
}

export function parseAdminUrl(adminUrl: string): AppDatabaseUrlParts {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new Error("APP_DB_ADMIN_URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("APP_DB_ADMIN_URL must be a postgres:// URL");
  }
  if (/^db\..*\.supabase\.co$/.test(url.hostname)) {
    throw new Error(
      "APP_DB_ADMIN_URL points at Supabase's direct connection host, which is IPv6-only without the paid IPv4 add-on — copy the Session pooler string instead (Project Settings → Database → Connect → Session pooler)",
    );
  }
  const database = url.pathname.replace(/^\//, "") || "postgres";
  const user = decodeURIComponent(url.username);
  const dot = user.indexOf(".");
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    ...(dot > 0 ? { projectRef: user.slice(dot + 1) } : {}),
    sslmode: url.searchParams.get("sslmode") ?? APP_SSLMODE_DEFAULT,
    sslmodeExplicit: url.searchParams.has("sslmode"),
  };
}

export function appDatabasePlaintext(adminUrl: string): boolean {
  const url = new URL(adminUrl);
  const mode = url.searchParams.get("sslmode");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  return !local && (mode === null || mode === "disable");
}

function mintAppUrl(parts: AppDatabaseUrlParts, appHost: string | undefined, role: string, password: string): string {
  const [host, port] = appHost ? splitHostPort(appHost, parts.port) : [parts.host, parts.port];
  const user = parts.projectRef ? `${role}.${parts.projectRef}` : role;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${parts.database}?sslmode=${parts.sslmode}`;
}

function splitHostPort(hostPort: string, fallbackPort: string): [string, string] {
  const idx = hostPort.lastIndexOf(":");
  if (idx <= 0) return [hostPort, fallbackPort];
  return [hostPort.slice(0, idx), hostPort.slice(idx + 1)];
}

export interface AppDatabaseOptions {
  adminUrl: string;
  appHost?: string;
  maxConnections: number;
  backing: DurableMap<StoredAppDatabase>;
  keyMaterial: string | Buffer;
  pg?: PgPool;
}

export function createPostgresAppDatabase(opts: AppDatabaseOptions): AppDatabase {
  const parts = parseAdminUrl(opts.adminUrl);
  const key = deriveConnectorKey(opts.keyMaterial, "app-database");
  const pg = opts.pg ?? createPgPool(opts.adminUrl, [], { max: 2, idleTimeoutMillis: 10_000 });

  let bootstrapped: Promise<void> | null = null;

  async function exec(stmt: string): Promise<void> {
    assertOneStatement(stmt);
    await pg.q(stmt);
  }

  async function bootstrap(): Promise<void> {
    const rows = await pg.q("SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user");
    const row = rows[0];
    if (!row || !(row.rolcreaterole === true || row.rolsuper === true)) {
      throw new Error(
        "APP_DB_ADMIN_URL's role cannot CREATE ROLE — use the Supabase project's `postgres` role, which per-app schemas and login roles require",
      );
    }
    await exec("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
    await exec("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  }

  function ensureBootstrapped(): Promise<void> {
    if (!bootstrapped) {
      bootstrapped = bootstrap().catch((e) => {
        bootstrapped = null;
        throw e;
      });
    }
    return bootstrapped;
  }

  async function extensionsSchemaExists(): Promise<boolean> {
    const rows = await pg.q("SELECT to_regnamespace('extensions') IS NOT NULL AS present");
    return rows[0]?.present === true;
  }

  async function provision(deploymentId: string): Promise<string> {
    await ensureBootstrapped();
    const schema = appDatabaseName(deploymentId);
    const ident = quoteIdent(schema);
    const password = generatePassword();
    const existing = await pg.q("SELECT 1 FROM pg_roles WHERE rolname = $1", [schema]);
    if (existing.length === 0) {
      await exec(
        `CREATE ROLE ${ident} WITH LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${opts.maxConnections}`,
      );
    } else {
      await exec(`ALTER ROLE ${ident} WITH LOGIN PASSWORD '${password}' CONNECTION LIMIT ${opts.maxConnections}`);
    }
    await exec(`GRANT CONNECT ON DATABASE ${quoteIdent(parts.database)} TO ${ident}`);
    await exec(`CREATE SCHEMA IF NOT EXISTS ${ident}`);
    await exec(`GRANT USAGE, CREATE ON SCHEMA ${ident} TO ${ident}`);
    await exec(`REVOKE ALL ON SCHEMA public FROM ${ident}`);
    if (await extensionsSchemaExists()) {
      await exec(`GRANT USAGE ON SCHEMA extensions TO ${ident}`);
      await exec(`ALTER ROLE ${ident} SET search_path = ${ident}, extensions`);
    } else {
      await exec(`ALTER ROLE ${ident} SET search_path = ${ident}`);
    }
    await exec(`ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = '60s'`);
    return mintAppUrl(parts, opts.appHost, schema, password);
  }

  async function storedUrl(deploymentId: string): Promise<string | null> {
    const rec = await opts.backing.get(deploymentId);
    if (!rec) return null;
    try {
      return decryptSecret(rec.urlEnc, key);
    } catch (e) {
      console.warn(
        `app-database: stored URL for ${deploymentId} cannot be decrypted, reprovisioning (${errMessage(e)})`,
      );
      return null;
    }
  }

  return {
    envVar: APP_DATABASE_ENV,

    async ensure(deploymentId) {
      if (await storedUrl(deploymentId)) return;
      const url = await provision(deploymentId);
      const previous = await opts.backing.get(deploymentId);
      await opts.backing.put(deploymentId, {
        deploymentId,
        schema: appDatabaseName(deploymentId),
        urlEnc: encryptSecret(url, key),
        createdAt: previous?.createdAt ?? Date.now(),
        ...(previous ? { rotatedAt: Date.now() } : {}),
      });
    },

    async resolve(deploymentId) {
      const url = await storedUrl(deploymentId);
      const out: Record<string, string> = {};
      if (url) out[APP_DATABASE_ENV] = url;
      return out;
    },

    async destroy(deploymentId) {
      const schema = appDatabaseName(deploymentId);
      const ident = quoteIdent(schema);
      await exec(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
      const present = await pg.q("SELECT 1 FROM pg_roles WHERE rolname = $1", [schema]);
      if (present.length) {
        if (await extensionsSchemaExists()) await exec(`REVOKE ALL ON SCHEMA extensions FROM ${ident}`);
        await exec(`REVOKE ALL ON DATABASE ${quoteIdent(parts.database)} FROM ${ident}`);
        await exec(`DROP ROLE ${ident}`);
      }
      await opts.backing.delete(deploymentId);
    },

    async sweep() {
      const rows = await pg.q("SELECT pg_database_size(current_database()) AS bytes");
      const bytes = Number(rows[0]?.bytes ?? 0);
      if (bytes >= SIZE_WARN_BYTES) {
        console.warn(
          `app-database: ${Math.round(bytes / 1024 / 1024)} MB used — a free Supabase project caps at 500 MB and nothing quotas an individual app; run scripts/app-db-gc.ts to reclaim orphaned schemas`,
        );
      }
    },

    close() {
      return pg.close();
    },
  };
}
