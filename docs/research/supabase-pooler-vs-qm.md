# Supabase's pooler vs. qm's Postgres feature use

Research date: 2026-08-05. Question: does Supabase's **session-mode** pooler support the
Postgres features qm's core depends on, and if not, what is the fallback?

Verdict up front: **session mode is functionally sufficient** — it holds a dedicated backend
per client connection, so `LISTEN`/`NOTIFY` and session-scoped advisory locks behave as on
direct Postgres, and node-postgres needs no connection-string flags. The real risk on Supabase's
free tier is **not features, it is connection count**: qm opens roughly 27 independent
node-postgres pools, each defaulting to `max: 10`, against a documented free-tier ceiling of 60
direct connections and a Supavisor pool whose upstream default size is 15.

Everything below distinguishes **[FACT]** (stated by a primary source, cited) from
**[INFERENCE]** (my reasoning over those facts plus this repo's code).

---

## 0. What qm actually depends on

Grepped in this repository:

**Session-scoped advisory locks** — held across statements on one backend, released only by
explicit unlock or session end:

- `src/persistence/pg-pool.ts:45` — blocking `pg_advisory_lock(hashtext('agent-platform:schema-init'))`
  taken on a dedicated `pool.connect()` client, DDL applied, then `pg_advisory_unlock` in `finally`.
- `src/persistence/advisory-lock.ts` — `createPostgresAdvisoryLock` uses
  `pg_try_advisory_lock(hashtextextended($1,0))` on a checked-out client, runs the callback while
  holding it, then unlocks on the _same_ client. Non-blocking + poll loop (`pollMs` 300,
  `timeoutMs` 5 min), so it never parks a backend in a blocking lock wait.
- `src/persistence/leader-lease.ts:69,86` — `pg_try_advisory_lock` / `pg_advisory_unlock` on a
  long-lived dedicated `PoolClient` held for the lifetime of the leadership, with an `error`
  handler that treats connection death as lease loss.

**Transaction-scoped advisory locks** (`pg_advisory_xact_lock`, auto-released at COMMIT):

- `src/memory/postgres-memory-service.ts:45,80`
- `src/directory/postgres-directory-store.ts:188,338`
- `src/acl/postgres-grant-store.ts:39,59,76`
- `src/admin/postgres-audit-log.ts:38` (inside a `DO` block during migration)

All of these run inside `withPgTransaction` (`src/persistence/pg-pool.ts`), i.e. `BEGIN` … lock …
`COMMIT` on one checked-out client.

**LISTEN/NOTIFY on a dedicated client:**

- `src/runs/postgres-session-state-bus.ts:~44-60` — `ensureListening()` does
  `(await pg.pool()).connect()`, attaches a `notification` handler, `LISTEN <channel>`, and keeps
  the client checked out indefinitely (`listenClient`); `emit` publishes via `pg_notify`.
- `src/runs/postgres-run-signal-store.ts:~42-58` — same shape; `send` does the INSERT and
  `pg_notify` in one statement, and on listener error it re-rings every known runId (a
  self-heal that matters for the fallback ranking below).

---

## 1. Session mode (5432) vs transaction mode (6543)

### [FACT] Session mode holds a dedicated backend for the client's lifetime

- Supabase's connect guide describes the shared pooler in session mode
  (`aws-<region>.pooler.supabase.com:5432`) as maintaining a dedicated connection per client for
  the session lifetime, recommended for a "persistent backend on IPv4-only networks"; transaction
  mode is `:6543` and recommended for serverless/edge.
  <https://supabase.com/docs/guides/database/connecting-to-postgres>
- The Supavisor FAQ: in session mode "the pooler assigns a connection that remains with the client
  until released", and it "mirrors direct database connections"; in transaction mode a client
  "executes a single query before returning to the pool".
  <https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI>
- Terminology doc: session mode "restricts the pooler to grant each direct connection exclusively
  to one client", behaves like a direct connection, and adds queueing rather than rejection.
  <https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO>
- Confirmed in Supavisor's own source. `lib/supavisor/client_handler.ex`:

  ```elixir
  defp maybe_checkout(_, %{mode: mode, db_connection: {pool, db_pid, db_sock}}, _)
       when is_pid(db_pid) and mode in [:session, :proxy] do
  ```

  — an already-held backend short-circuits checkout in `:session` mode, whereas
  `maybe_checkout(:on_connect, %{mode: :transaction}, _), do: {:ok, nil}` and
  `db_connection = if data.mode == :transaction, do: nil, else: data.db_connection` release the
  backend per statement batch in transaction mode.
  <https://github.com/supabase/supavisor/blob/main/lib/supavisor/client_handler.ex>

- Port allocation is now fixed: session mode on 5432, transaction mode on 6543. Supabase
  deprecated session mode on 6543 effective 2025-02-28.
  <https://supabase.com/changelog> (entry "Supabase Connection Pooler Deprecating Session Mode on
  Port 6543 on February 28, 2025")

### [FACT] What transaction mode breaks

- Supabase's connect guide lists transaction mode as not supporting **prepared statements**,
  **session-scoped advisory locks**, or **LISTEN/NOTIFY**.
  <https://supabase.com/docs/guides/database/connecting-to-postgres>
- Supavisor's own FAQ: "It supports prepared statements in session mode. In transaction mode,
  named prepared statements are supported when the `named_prepared_statements` feature flag is
  enabled" (per-tenant / `NAMED_PREPARED_STATEMENTS_ENABLED`) — i.e. off unless enabled.
  <https://github.com/supabase/supavisor/blob/main/docs/faq.md>
- LISTEN/NOTIFY under transaction pooling is an **open** Supavisor issue (#85, opened 2023-05-10,
  still open as of this research). Supabase's own chasers on it: "Since listen requires a
  connection per `listen` command … Don't listen to more topics than your pool_size and make sure
  to use `session` mode (for now)."
  <https://github.com/supabase/supavisor/issues/85>
- Postgres semantics that make this unavoidable: a session-level advisory lock "is held until
  explicitly released or the session ends" and does not honour transaction semantics, whereas
  transaction-level locks "are automatically released at the end of the transaction".
  <https://www.postgresql.org/docs/current/explicit-locking.html>

### [INFERENCE] Loud vs. silent failure in transaction mode

Ranked by how qm would experience it:

| Feature                                                       | qm call sites                                                      | Failure mode in transaction mode                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN` + dedicated client                                   | session-state bus, run-signal store                                | **Silent.** `LISTEN` returns success; the backend is then handed to another client, so notifications are delivered to nobody qm is holding. Real-time run signals and session-state fanout degrade to "never fires" with no error. `postgres-run-signal-store`'s re-ring-on-error path does not trigger, because nothing errors.                     |
| `pg_advisory_lock` / `pg_try_advisory_lock` across statements | `pg-pool.ts:45` schema init, `advisory-lock.ts`, `leader-lease.ts` | **Silent and dangerous.** The lock is acquired on whichever backend served that statement; the subsequent unlock (or the protected work) may land on a different backend. Two instances can both believe they hold `deploy:<id>` or the leader lease, and an orphaned lock can persist on a pooled backend until it is recycled. No error is raised. |
| Named prepared statements                                     | none (see §2)                                                      | Loud (`prepared statement "…" does not exist`) — but qm never creates any.                                                                                                                                                                                                                                                                           |
| `pg_advisory_xact_lock` inside `withPgTransaction`            | memory, directory, ACL, audit-log migration                        | **Works.** Supavisor keeps a transaction on one backend for its duration; the lock is released at COMMIT. This family is the only pooler-safe one.                                                                                                                                                                                                   |

So the two families the ticket calls out are asymmetric: the _transaction_-scoped locks are fine in
either mode; the _session_-scoped locks and LISTEN both fail **silently** in transaction mode,
which is the worst possible failure shape for a leader lease. Session mode is not an optimisation
here — it is a correctness requirement.

### [INFERENCE] Residual session-mode caveats

1. `LISTEN` costs one dedicated backend per listening process, forever. qm holds **two** such
   clients per instance (session-state bus, run-signal store) plus **one** for a held leader lease
   — three long-lived checkouts that never return to their pools, on top of §3's arithmetic.
2. Supavisor's tenant schema defaults `client_idle_timeout: 0` (disabled) and
   `client_heartbeat_interval: 60`, so an idle `LISTEN` client is not reaped by the pooler by
   default and is heartbeated. [FACT]
   <https://github.com/supabase/supavisor/blob/main/lib/supavisor/tenants/tenant.ex>
   Whether Supabase's platform overrides `client_idle_timeout` per plan is not documented; both
   listeners already reconnect on `error` with `RECONNECT_DELAY_MS`, so a reap would self-heal —
   though `postgres-session-state-bus` loses notifications in the gap without a re-ring, unlike
   `postgres-run-signal-store` which re-rings every listener after a reconnect.
3. `src/persistence/pg-pool.ts:45` uses the **blocking** `pg_advisory_lock` during schema init.
   Supabase documents the `postgres` role's `statement_timeout` as "None (capped to 2 minutes by
   default global timeout)" [FACT]
   <https://supabase.com/docs/guides/database/postgres/timeouts> — so a contended boot (many
   instances initialising schema at once, ~27 pools each) can abort schema init with a statement
   timeout rather than waiting. This is a pre-existing core sharp edge, not a Supabase-specific
   one, but Supabase's default global cap makes it reachable.

---

## 2. Prepared statements / node-postgres flags

**[FACT] No connection-string flags are needed in either mode for node-postgres as qm uses it.**

- node-postgres only uses _named_ (server-cached) prepared statements when you pass a `name` in
  the query config: "If you supply a `name` parameter the query execution plan will be cached on
  the PostgreSQL server on a per connection basis." Parameterised queries without `name` are
  unnamed and require no opt-out. <https://node-postgres.com/features/queries>
- Supabase's own per-driver opt-out list says exactly this for Node Postgres: "Omit the `name`
  value in a query definition" — versus `?pgbouncer=true` (Prisma), `prepare: false` (Drizzle),
  `prepare_threshold=None` (psycopg), `statement_cache_size=0` (asyncpg).
  <https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL>

**[FACT, this repo]** No call site in `src/` passes a `name` to `client.query` / `pool.query`; all
queries go through `PgPool.q` / `PgPool.query` / `withPgTransaction`, which forward
`(text, params)` only. `pg-boss` (`src/cron/job-queue.ts`) is the one dependency that could differ,
but it is configured with a plain `connectionString` and `max: 5` and is not documented as
requiring pooler flags.

**[INFERENCE]** SSL is the only connection-string concern. `src/deploy/app-database.ts` already
threads an `sslmode` default (`APP_SSLMODE_DEFAULT`) and flags plaintext URLs
(`appDatabasePlaintext`), so nothing new is required for the pooler host.

---

## 3. Free-tier connection ceiling vs. qm's pool count

### [FACT] The documented ceilings

| Compute size    | Direct connections | Pooler client connections |
| --------------- | ------------------ | ------------------------- |
| **Nano (free)** | **60**             | **200**                   |
| Micro           | 60                 | 200                       |
| Small           | 90                 | 400                       |
| Medium          | 120                | 600                       |

Supabase adds that "the Supavisor connection limits are hard-coded and cannot be changed without
upgrading the compute size".
<https://supabase.com/docs/guides/troubleshooting/how-to-change-max-database-connections-_BQ8P5>

Two further limits matter, because in session mode a client connection **is** a direct connection:

- **Pool size** = "the maximum number of direct connections the pooler can maintain per unique
  user, database, and mode combination", configurable in the dashboard as `Default Pool Size`.
  <https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI>,
  <https://supabase.com/docs/guides/troubleshooting/how-do-i-update-connection-pool-settings-in-my-dashboard-wAxTJ_>
  Supabase's docs do not publish the provisioned default; Supavisor's schema defaults it to
  **15** (`field(:default_pool_size, :integer, default: 15)`), with
  `default_max_clients: 1000` and `pool_checkout_timeout: 60_000`.
  <https://github.com/supabase/supavisor/blob/main/lib/supavisor/tenants/tenant.ex>,
  <https://github.com/supabase/supavisor/blob/main/lib/supavisor/tenants/user.ex>
- **Exhaustion behaviour is loud but slow.** Session mode queues rather than rejects — "the pooler
  queues clients for up to one minute"
  (<https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO>),
  matching `pool_checkout_timeout: 60_000`; beyond the client cap, Supavisor returns
  `Max client connections reached` as a Postgres wire error
  (<https://github.com/supabase/supavisor/blob/main/docs/faq.md>).
- **node-postgres defaults**: `max` is 10, `idleTimeoutMillis` is 10000.
  <https://node-postgres.com/apis/pool>

### [FACT, this repo] How many pools qm opens

`createPgPool` is called once per store family, and `PgPoolOptions` is left empty at every boot
call site — the only site passing options is the deploy path
(`src/deploy/app-database.ts:125`, `{ max: 2, idleTimeoutMillis: 10_000 }`). So **every core pool
inherits node-postgres's `max: 10`.**

Distinct pools created when `DATABASE_URL` is set (from `src/wiring.ts`):

1. `createPostgresGrantStore` — `src/acl/postgres-grant-store.ts`
2. `createPostgresMapFactory` — `src/persistence/durable-map.ts` (shared by `createPostgresLeaderLease`, `createPostgresAdvisoryLock`, `createPostgresInstanceRegistry`)
3. `createPostgresAuditLog` — `src/admin/postgres-audit-log.ts`
4. `createPostgresRateLimiter` — `src/ratelimit/postgres-rate-limiter.ts`
5. `createPostgresBudgetTracker` — `src/ratelimit/postgres-budget.ts` _(only when a budget is configured)_
6. `createPostgresFileArtifactStore` — `src/files/postgres-file-artifact-store.ts`
7. `createPostgresMemoryService` — `src/memory/postgres-memory-service.ts`
8. `createPostgresErrorLog` — `src/admin/postgres-error-log.ts`
9. `createPostgresMetricsSink` — `src/admin/postgres-metrics-sink.ts`
10. `createPostgresCredentialUsageSink` — `src/admin/postgres-credential-usage-sink.ts`
11. `createPostgresEgressAuditSink` — `src/admin/postgres-egress-audit-sink.ts`
    _(8–11 each call `createPostgresEventSink` → its own `createPgPool` in `src/admin/scoped-event-sink.ts:125`)_
12. `createPostgresTaskStore` — `src/tasks/postgres-task-store.ts`
13. `createPostgresProcessRegistry` — `src/processes/process-registry.ts` _(conditional)_
14. `createPostgresReplayDedupe` — `src/auth/replay-dedupe.ts`
15. `createPostgresSessionStateBus` — `src/runs/postgres-session-state-bus.ts` **(+1 permanently checked-out LISTEN client)**
16. `createPostgresAdminGrantStore` — `src/admin/postgres-admin-grant-store.ts`
17. `createPostgresDirectoryStore` — `src/directory/postgres-directory-store.ts`
18. `createPostgresEnvironmentStore` — `src/environments/environment-store.ts`
19. `createPostgresDeliveryStore` — `src/delivery/postgres-delivery-store.ts`
20. `createPostgresSurfaceCache` — `src/surface-cache/surface-cache.ts`
21. `createPostgresChannelPolicyStore` — `src/surface-cache/channel-policy-store.ts`
22. `createPostgresAmbientJudgmentStore` — `src/surface-cache/ambient-judgment-store.ts`
23. `createPostgresAckEmojiPickStore` — `src/surface-cache/ack-emoji-pick-store.ts`
24. `createPostgresSessionStore` — `src/sessions/postgres-session-store.ts`
25. `createPostgresRunStore` — `src/runs/postgres-run-store.ts`
26. `createPostgresRunSignalStore` — `src/runs/postgres-run-signal-store.ts` **(+1 permanently checked-out LISTEN client)**
27. `createPostgresRunActivityStore` — `src/runs/postgres-run-activity-store.ts`

Plus `createPgBossCronQueue` → `new PgBoss({ …, max: 5 })` (`src/cron/job-queue.ts:33`), its own
pool outside `createPgPool`.

### [INFERENCE] Is the free tier a real risk? Yes.

- **Theoretical ceiling per instance:** 27 × 10 + 5 = **275 connections**, against 200 pooler
  clients and 60 direct. Reaching it is not a "cannot happen" — a burst of concurrent requests each
  touching several store families expands several pools at once.
- **Boot floor per instance:** `createPgPool` is lazy (`poolP` is null until first `pool()`), but
  each pool with a non-empty `statements` list takes a client and runs `applyDdl` on first use, and
  wiring exercises nearly all of them during boot. So expect **~27 concurrent connections just to
  boot one instance**, before serving traffic. That already exceeds a default `Default Pool Size`
  of 15, meaning boot itself will queue on `pool_checkout_timeout` (60 s) and can fail with
  connect timeouts on an untouched free project.
- **Steady state is much lower** than the ceiling: `idleTimeoutMillis` defaults to 10 s, so idle
  connections are reaped and most pools settle at 0–1 connections. But three checkouts never
  return: the two LISTEN clients and (when leader) the leader-lease client.
- **Multi-instance makes it worse.** Core is documented as running blue-green and multi-instance
  (`CLAUDE.md`, "Durable by default"), so multiply the boot floor by the number of live instances —
  two instances at ~27 each is ~54, at the 60-direct free-tier wall before Supabase's own
  services (PostgREST, Auth, Realtime, Storage) take their share.
- **Mitigation, cheapest first:** raise `Default Pool Size` in the dashboard toward the 60-direct
  cap (documented as configurable), _and_ pass a small `max` at the `createPgPool` layer. Because
  every core store funnels through one helper, a single default there —
  e.g. `max: options.max ?? 3` in `src/persistence/pg-pool.ts` — bounds all 27 pools at once. That
  is the "solve at the layer all paths flow through" fix; per-store `max:` values would be 27
  edits. `PgPoolOptions` already exists for it. **[INFERENCE — a proposal, not a verified change.]**

---

## 4. Is the direct host still IPv6-only without the paid add-on?

**[FACT] Yes — the assertion at `src/deploy/app-database.ts:71` is still correct as of this research.**

- Supabase's connect guide lists the direct connection `db.<ref>.supabase.co:5432` as **IPv6 only**
  on both Free and Paid tiers, and IPv4-reachable only with the IPv4 add-on; both pooler modes
  "always use an IPv4 address" on all tiers.
  <https://supabase.com/docs/guides/database/connecting-to-postgres>
- The IPv4 doc: "By default, Supabase Postgres use IPv6 addresses"; the add-on is labelled
  "Dedicated IPv4 Add-On (Pro Plans+)", i.e. **not available on Free**, and toggling it causes brief
  downtime "due to DNS reconfiguration and propagation".
  <https://supabase.com/docs/guides/platform/ipv4-address>
- It is a **swap, not dual-stack**: enabling it "swaps the project's IPv6 (AAAA) DNS record for an
  IPv4 (A) record, so the project endpoint becomes reachable only over IPv4".
  <https://supabase.com/docs/guides/database/connecting-to-postgres>
- Price: "$0.0055 per hour ($4 per month)".
  <https://supabase.com/docs/guides/platform/manage-your-usage/ipv4>

**[INFERENCE]** The error message at `app-database.ts:71` is accurate but slightly incomplete: it
should also convey that the add-on requires a Pro plan, so a free-tier operator cannot buy their
way out of it. Also note the dedicated PgBouncer pooler (`db.<ref>.supabase.co:6543`) is paid-tier
and **transaction-mode only**
(<https://supabase.com/docs/guides/database/connecting-to-postgres>) — so it is never an option for
qm, regardless of plan.

---

## 5. Ranked fallbacks

Session mode is sufficient, so these are ordered as "what to reach for if session mode proves
insufficient in a specific environment", with the trigger that would make each necessary.

**Rank 1 — Session pooler (5432), tuned. The recommendation; not really a fallback.**
Free-tier compatible, IPv4, feature-complete for every construct in §0. Cost: $0. Required work:
raise `Default Pool Size` in the dashboard and bound `PgPoolOptions.max` centrally in
`src/persistence/pg-pool.ts` (§3). Trigger to move on: none, unless the host's own limits bind.

**Rank 2 — Direct IPv6 connection (`db.<ref>.supabase.co:5432`).**
Free-tier compatible, exact Postgres semantics, no pooler in the path at all, no pool-size ceiling
below the 60-direct cap, and no `pool_checkout_timeout` queueing. Cost: $0. The only blocker is
network reachability — it demands end-to-end IPv6 from wherever core runs, which many CI runners,
container networks, and home ISPs lack. Choose this when the runtime has IPv6 and you want the
pooler's pool-size arithmetic out of the picture. Note `src/deploy/app-database.ts:71` currently
**rejects** this host outright for `APP_DB_ADMIN_URL`, so adopting it would mean relaxing that
guard rather than just changing a URL. **[INFERENCE]**

**Rank 3 — Paid IPv4 add-on on the direct host.** $4/month, Pro plan only, so it is a
plan upgrade plus an add-on, not $4 total. Buys direct-connection semantics over IPv4. Reach for it
only when Rank 2's semantics are wanted but IPv6 is unavailable. Remember it is a DNS swap: after
enabling, the host resolves IPv4 **only**, so any IPv6-only consumer of the same URL breaks.

**Rank 4 — Core change: replace LISTEN with polling.** Last resort, and only if a deployment target
forces transaction mode (e.g. serverless with no persistent process). Scope: `postgres-run-signal-store`
and `postgres-session-state-bus` would poll instead of listening — and note this does **not** rescue
the session-scoped advisory locks in `pg-pool.ts`, `advisory-lock.ts`, and `leader-lease.ts`, which
would each need a table-backed lease. `advisory-lock.ts` already polls
(`pg_try_advisory_lock` + `sleep(pollMs)`), so its shape is polling-friendly, but its correctness
still rests on lock and unlock hitting the same backend. Cost: real engineering plus per-poll
query load against the same free-tier database, added surface area rather than less — which cuts
against this repo's "fixes should make the system simpler" rule. Do not do this to save $4/month.

---

## Sources

- Supabase, Connect to your database — <https://supabase.com/docs/guides/database/connecting-to-postgres>
- Supabase, Supavisor FAQ — <https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI>
- Supabase, Supavisor and connection terminology explained — <https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO>
- Supabase, How to change max database connections — <https://supabase.com/docs/guides/troubleshooting/how-to-change-max-database-connections-_BQ8P5>
- Supabase, Connection management — <https://supabase.com/docs/guides/database/connection-management>
- Supabase, Update connection pool settings — <https://supabase.com/docs/guides/troubleshooting/how-do-i-update-connection-pool-settings-in-my-dashboard-wAxTJ_>
- Supabase, Disabling prepared statements — <https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL>
- Supabase, IPv4 address — <https://supabase.com/docs/guides/platform/ipv4-address>
- Supabase, Manage IPv4 usage (pricing) — <https://supabase.com/docs/guides/platform/manage-your-usage/ipv4>
- Supabase, Timeouts — <https://supabase.com/docs/guides/database/postgres/timeouts>
- Supabase changelog, session mode deprecated on 6543 (2025-02-28) — <https://supabase.com/changelog>
- Supavisor, FAQ — <https://github.com/supabase/supavisor/blob/main/docs/faq.md>
- Supavisor, `client_handler.ex` — <https://github.com/supabase/supavisor/blob/main/lib/supavisor/client_handler.ex>
- Supavisor, `tenants/tenant.ex` / `tenants/user.ex` — <https://github.com/supabase/supavisor/blob/main/lib/supavisor/tenants/tenant.ex>
- Supavisor issue #85, LISTEN/NOTIFY with transaction pooling (open) — <https://github.com/supabase/supavisor/issues/85>
- PostgreSQL, Explicit Locking § Advisory Locks — <https://www.postgresql.org/docs/current/explicit-locking.html>
- node-postgres, Pool API — <https://node-postgres.com/apis/pool>
- node-postgres, Queries — <https://node-postgres.com/features/queries>
