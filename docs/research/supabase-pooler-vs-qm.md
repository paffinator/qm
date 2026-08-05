# Supabase's session-mode pooler vs. qm's Postgres requirements

Researched 2026-08-05 against Supabase's docs, the Supavisor source, node-postgres' docs, PostgreSQL's
docs, and AWS' ELB docs. Code references are to this worktree.

## Answer

Yes — Supavisor **session mode** (port 5432 on `*.pooler.supabase.com`) is functionally sufficient for
qm's core: Supabase documents that in session mode "once the pooler assigns a direct connection, it stays
with that client until voluntarily surrendered", and Supavisor's own code never re-checks-out a backend
for a session-mode client, so `LISTEN` and session-scoped `pg_advisory_lock` behave as on a direct
connection ([FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI),
[client_handler.ex `maybe_checkout`](https://github.com/supabase/supavisor/blob/main/lib/supavisor/client_handler.ex)).
Transaction mode (port 6543) really does break both silently — a `NOTIFY` arriving on an idle pooled
backend is logged at debug level and dropped, and a mismatched `pg_advisory_unlock` only produces a
Postgres *warning*, not an error — so it must not be used for `DATABASE_URL`. The binding constraint is
not correctness but **connection count**: in session mode Supavisor caps concurrent client connections at
the project's *pool size* (Supavisor's built-in default is 15), while qm opens up to ~26 independent `pg`
pools of `max: 10` each (~260 sockets) with no config knob to cap them, against a free-tier Nano
`max_connections` of 60. The fallback if session mode proves insufficient is **not** the direct
`db.*.supabase.co` endpoint — it is IPv6-only without the paid IPv4 add-on and this macOS dev machine has
no global IPv6 address or default IPv6 route (verified locally), so it is unreachable from local dev;
the viable fallbacks are raising the project's pool size plus capping `PgPoolOptions.max` per pool
(or sharing one pool), the $4/mo IPv4 add-on, or a core change to poll instead of `LISTEN`.

## Verdict per feature

| qm feature | Code | Session mode (5432) | Transaction mode (6543) |
| --- | --- | --- | --- |
| Session advisory lock across many DDL statements | `src/persistence/pg-pool.ts:45` | Works | Broken, silent |
| `pg_try_advisory_lock` held across an async callback | `src/persistence/advisory-lock.ts:58-90` | Works | Broken, silent |
| Long-held leader lease on a pinned client | `src/persistence/leader-lease.ts:69-98` | Works | Broken; qm *does* detect it (logs "is DATABASE_URL behind a transaction-pooling proxy?") |
| `pg_advisory_xact_lock` inside `BEGIN…COMMIT` | `src/memory/postgres-memory-service.ts:45,80`, `src/directory/postgres-directory-store.ts:188,338`, `src/acl/postgres-grant-store.ts:39,59,76`, `src/admin/postgres-audit-log.ts:38` | Works | **Works** — all four are inside an explicit transaction (or a single `DO` block), and transaction mode keeps one backend per transaction |
| `LISTEN` on a held client | `src/runs/postgres-session-state-bus.ts:58`, `src/runs/postgres-run-signal-store.ts:54` | Works | Broken, silent |
| `pg_notify(...)` as a normal statement | same files | Works | Works (single statement) |
| Prepared statements | none — qm never passes a query `name` | N/A | N/A (no flags needed either way) |
| ~26 pools × `max: 10` | `createPgPool` call sites | **Exceeds the session-mode ceiling** — see §4 | n/a |

## 1. Does session mode hold a dedicated backend for the client's lifetime?

Documented, in these words:

> "In session mode, once the pooler assigns a direct connection, it stays with that client until
> voluntarily surrendered. This behavior mirrors a direct connection, allowing greedy clients to
> monopolize the pool."
> — [Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)

> "Session mode restricts the pooler, forcing it to grant an underlying direct connection exclusively to
> a single client connection."
> — [Supavisor and Connection Terminology Explained](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO)

> "In session mode, it will immediately create a new a direct connection for a new client unless the
> 'Pool Size' is reached… In session mode, the connection will be immediately closed [when the client
> disconnects]."
> — [Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)

Neither `LISTEN`/`NOTIFY` nor advisory locks are named in Supabase's docs (the docs mention prepared
statements only). The mechanism is confirmed in Supavisor's source, which is first-party:

- `lib/supavisor/client_handler.ex` — `maybe_checkout/3` short-circuits for session mode:
  `defp maybe_checkout(_, %{mode: mode, db_connection: {pool, db_pid, db_sock}}, _) when is_pid(db_pid) and mode in [:session, :proxy], do: {:ok, {pool, db_pid, db_sock}}`. The same backend is reused for
  every query for the client's lifetime.
  ([source](https://github.com/supabase/supavisor/blob/main/lib/supavisor/client_handler.ex))
- `lib/supavisor/db_handler.ex` — when a query batch completes, transaction mode calls `checkin(data)`
  and moves to `:idle`; session mode does `{:keep_state, …}`, keeping `caller` set. Because the caller
  stays attached, unsolicited backend bytes (i.e. `NotificationResponse` from a `NOTIFY`) are handled by
  the `:busy` clause and forwarded to the client socket. This is the mechanism by which `LISTEN` works in
  session mode. ([source](https://github.com/supabase/supavisor/blob/main/lib/supavisor/db_handler.ex))
- Session state is only reset when the client goes away: `client_handler.ex`'s
  `maybe_cleanup_db_handler` sends `DISCARD ALL` (`db_handler.ex`: "Starting cleanup, sending DISCARD
  ALL") before returning the backend to the poolboy pool. Nothing resets state mid-session.

Postgres' own semantics make the dedicated-backend property sufficient:

- "Once acquired at session level, an advisory lock is held until explicitly released or the session
  ends." — [PostgreSQL 13.3.5 Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- "LISTEN registers the current session as a listener… A session's listen registrations are
  automatically cleared when the session ends."
  — [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html)

**Inferred (not documented by Supabase):** that `LISTEN` works in session mode. It follows from the
dedicated-connection guarantee plus the source above, and there is no doc statement to the contrary, but
Supabase does not promise it in writing. Worth a five-minute empirical check (`LISTEN x` on one session
pooler connection, `NOTIFY x` from another) before relying on it.

## 2. Does transaction mode break both silently?

Confirmed for `LISTEN`, and confirmed-with-a-nuance for advisory locks.

**LISTEN — silent, no error.** In transaction mode Supavisor returns the backend to the pool at each
transaction boundary: "In transaction mode, a client is allowed to make a single query before being sent
back to the figurative 'waiting room'"
([FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)). The `LISTEN` statement
itself succeeds. Any later `NOTIFY` reaches a backend that no longer has a client attached, and
`db_handler.ex` discards it:

```elixir
# the process received message from db while idle
def handle_event(:info, {proto, _, bin}, :idle, %{backend_message_streaming: true} = data)
    when proto in @proto do
  Logger.debug("DbHandler: Got db response when idle")
```

No error is sent to any client. ([source](https://github.com/supabase/supavisor/blob/main/lib/supavisor/db_handler.ex))
A LISTEN/NOTIFY proxy for transaction mode is still only an open enhancement request
([supavisor#85](https://github.com/supabase/supavisor/issues/85), opened 2023-05-10, label
`enhancement`). Note also that Supavisor's own README still lists "Session pooling — Like `PgBouncer`"
under **Future Work** while listing only `Transaction` under "Pool mode support per tenant"
([README](https://github.com/supabase/supavisor/blob/main/README.md)) — that section is stale relative to
both the code (`@type mode :: :transaction | :session | :native | :proxy`) and Supabase's docs.

**Session advisory locks — silent by Postgres' own choice.** `pg_advisory_unlock` "returns true if the
lock is successfully released. If the lock was not held, false is returned, and in addition, an SQL
warning will be reported by the server"
([PostgreSQL functions-admin](https://www.postgresql.org/docs/current/functions-admin.html)). A warning
is delivered to node-postgres as a `notice` event, not a thrown error
([pg.Client events](https://node-postgres.com/apis/client)), and qm attaches no `notice` handler. So:
`pg_try_advisory_lock` can succeed on backend A, the critical section runs unprotected, and the unlock
lands on backend B returning `false`. `src/persistence/advisory-lock.ts` ignores the unlock result
entirely (silent); `src/persistence/leader-lease.ts:89` is the one place that checks it and logs
`is DATABASE_URL behind a transaction-pooling proxy?`. The abandoned lock stays held on backend A until
that pooled backend is closed, so a transaction-pooled qm can also *deadlock itself* out of a lock key.

**Correction to the ticket's framing:** the `pg_advisory_xact_lock` family is **not** pooler-hostile.
All four users wrap it in an explicit transaction (`postgres-memory-service.ts` and
`postgres-directory-store.ts` issue `BEGIN`/`COMMIT` by hand, `postgres-grant-store.ts` likewise,
`postgres-audit-log.ts` uses a single `DO` block), and transaction mode holds one backend per
transaction. Transaction-level locks "are automatically released at the end of the transaction"
([PostgreSQL 13.3.5](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)). The
pooler-hostile set is exactly: `pg-pool.ts` schema init, `advisory-lock.ts`, `leader-lease.ts`, and the
two `LISTEN` holders.

## 3. Prepared statements and `pg` connection-string flags

No flags are needed in either mode, because qm never uses named prepared statements.

- Supabase: "Transaction mode does not support prepared statements. To avoid errors, turn off prepared
  statements for your connection library."
  ([Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)) and
  "unlike transaction mode, it [session mode] supports prepared statements"
  ([FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)).
- node-postgres only issues protocol-level prepared statements when you pass a `name`: "PostgreSQL has
  the concept of a prepared statement. node-postgres supports this by supplying a `name` parameter to
  the query config object." ([Queries](https://node-postgres.com/features/queries)). Parameterized
  queries without a `name` use the unnamed extended-query path.
- qm passes only `(text, values)` through `PgPool.q`/`query` (`src/persistence/pg-pool.ts:86-92`); a
  grep for a query config with `name:` across `src/` finds none. So there is nothing to disable — unlike
  Prisma or `postgres.js`, `pg` needs no `?pgbouncer=true`/`prepare=false` equivalent.

SSL: `sslmode` is honoured by `pg` via `pg-connection-string`, where `sslmode=no-verify` maps to
`ssl: { rejectUnauthorized: false }` and `require`/`verify-ca`/`verify-full` map to `ssl: true` (unless
`uselibpqcompat=true`)
([pg-connection-string README](https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/README.md)).
qm's `APP_SSLMODE_DEFAULT = "no-verify"` (`src/deploy/app-database.ts:9`) therefore does encrypt while
skipping certificate verification. Note the README's own caution that anything below `verify-full` "has
serious security implications", and that `pg`'s docs warn an `ssl` config object is *discarded* if the
connection string carries any `sslmode`/`sslcert`/`sslkey`/`sslrootcert`
([SSL](https://node-postgres.com/features/ssl)).

## 4. The free-tier connection ceiling, and the arithmetic against qm's pools

Documented limits for the smallest instance:

| Compute | Database Max Connections | Connection Pooler Max Clients |
| --- | --- | --- |
| Nano (free) | 60 | 200 |

— [Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk) (same table in
[How to change max database connections](https://supabase.com/docs/guides/troubleshooting/how-to-change-max-database-connections-_BQ8P5),
which adds: "the Supavisor connection limits are hard-coded and cannot be changed without upgrading the
compute size").

**The 200 does not apply to session mode.** Supavisor's client-limit check is mode-dependent:

```elixir
# - `:session` mode: limited by pool_size (each client holds a connection)
# - `:transaction` mode: limited by max_clients
defp check_limit(:session, pool_size, _max_clients, current_count)
     when current_count >= pool_size do
  {:error, MaxConnectionsError.new(:session, pool_size)}
end
```

and the error text is `"max clients reached in session mode - max clients are limited to pool_size"`
with code `EMAXCONNSESSION`
([manager.ex](https://github.com/supabase/supavisor/blob/main/lib/supavisor/manager.ex),
[max_connections_error.ex](https://github.com/supabase/supavisor/blob/main/lib/supavisor/errors/max_connections_error.ex)).
This matches the FAQ ("In session mode, it will immediately create a new a direct connection for a new
client unless the 'Pool Size' is reached"). **So in session mode the ceiling qm hits first is the
project's pool size, not 200 and not 60.** Supavisor's built-in default is
`field(:default_pool_size, :integer, default: 15)`
([tenant.ex](https://github.com/supabase/supavisor/blob/main/lib/supavisor/tenants/tenant.ex)); Supabase
documents *how* to change pool size but never states the value it provisions per plan, so treat 15 as
indicative and read the dashboard value
([Connection management](https://supabase.com/docs/guides/database/connection-management)).

Pools qm opens (grep of `createPgPool(` under `src/`): 24 call sites, of which one
(`src/deploy/app-database.ts:125`) uses `APP_DB_ADMIN_URL` with `{ max: 2, idleTimeoutMillis: 10_000 }`.
That leaves 23 call sites on `DATABASE_URL`, and one of them —
`src/admin/scoped-event-sink.ts:125` — is invoked four times (error log, metrics sink, credential-usage
sink, egress-audit sink), so a fully-wired instance creates up to **26 independent pools** on
`DATABASE_URL`. Every one of them passes no `PgPoolOptions`, so each takes node-postgres' defaults:
`max` "By default this is set to 10", `idleTimeoutMillis` "Default is 10000 (10 seconds)"
([pg.Pool](https://node-postgres.com/apis/pool)). There is no env knob: `src/config.ts` has no pool-size
setting, and no call site threads one.

Arithmetic, per qm process:

- Worst case: 26 pools × `max` 10 = **260** client connections — 17× a pool_size of 15, 4× the Nano
  `max_connections` of 60, and above the 200 pooler-client cap even in transaction mode.
- Floor: `pg` opens lazily and evicts after 10 s idle, and two connections are pinned forever by the
  `LISTEN` holders plus one by the leader lease, so steady state is small (order 3-6). But the ceiling is
  what a burst reaches, and hitting it in session mode yields `EMAXCONNSESSION` rather than queueing
  behind the 200-slot waiting room. **Inferred** from the source above: the queue-for-up-to-a-minute
  behaviour the FAQ describes for session mode applies to pool checkout, not to the pool_size client cap.
- Even at one connection per pool, 26 > 15. Session mode on a default free project therefore needs the
  pool size raised.
- How far can pool size go? Supabase advises keeping the pooler "under 40% of available connections" if
  you also use the Data API, "otherwise you can cautiously increase usage to around 80%"
  ([FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI),
  [Connection management](https://supabase.com/docs/guides/database/connection-management)). On Nano
  that is 24 (40%) to 48 (80%) of 60 — and Storage occupies its own "user+db+mode" combination against
  the same pool size number. So a realistic budget is ~24-40 client connections for qm on a free
  project, i.e. an average `max` of 1 per pool with no headroom, or 2 if pool size is pushed to ~48 and
  the Data API is unused.
- Conclusion: to run qm's core against a free Supabase project via session mode you must (a) raise the
  project's pool size toward 40-48, and (b) cap qm's per-pool `max` — the honest fix per this repo's
  "solve at the layer all paths flow through" rule is a default `max` in `createPgPool` (2-3) or a single
  shared pool, not 26 pools of 10.

One documentation inconsistency worth knowing: the FAQ says pool size is "per unique user, database, and
mode combination" and that two combinations each get the full pool size, while
[Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) says the
session (5432) and transaction (6543) ports *share* one pool-size budget ("the total combined
connections across both modes cannot exceed 30"). Assume the stricter, shared reading.

## 5. Fallbacks if session mode is insufficient

| Option | Viable from local macOS dev? | Notes |
| --- | --- | --- |
| Session pooler, pool size raised + `PgPoolOptions.max` capped | **Yes** | Cheapest and needs no core change beyond a pool-size default. Pooler host is IPv4: `dig +short A aws-0-us-east-1.pooler.supabase.com` returns three A records via `pool-tcp-…elb.us-east-1.amazonaws.com`, and `dig AAAA` returns none (checked 2026-08-05 from this machine). |
| Direct `db.<ref>.supabase.co:5432` | **No** | Documented as IPv6-only without the add-on: "Direct connections are on IPv6, or on IPv4 if the project has the IPv4 add-on… If your network is IPv4-only and you don't have the add-on, use pooler session mode instead" ([docs](https://supabase.com/docs/guides/database/connecting-to-postgres)). This machine has no global IPv6 address (`ifconfig` shows only link-local/loopback `inet6`), no default IPv6 route (`route -n get -inet6 default` → "not in table"), and `ping6 2606:4700:4700::1111` → "No route to host". `src/deploy/app-database.ts:71-75` already refuses such a URL. |
| Paid IPv4 add-on | Yes, but paid, and it is a swap not a superset: "The IPv4 add-on is not dual-stack: enabling it swaps the project's IPv6 (AAAA) DNS record for an IPv4 (A) record" ([docs](https://supabase.com/docs/guides/database/connecting-to-postgres)). It also unlocks the Dedicated Pooler over IPv4 — but PgBouncer "runs in transaction mode only — for session mode, use the Shared Pooler", so it does not help LISTEN. |
| Core change: poll instead of `LISTEN` | Yes | Only needed if session mode is rejected outright. `src/runs/postgres-run-signal-store.ts` already has a durable table and `pendingRunIds()`/`takePending()`, so a poll loop is a small change there; `src/runs/postgres-session-state-bus.ts` has no durable backing at all (`createPgPool(connectionString, [])`) and would need a table before it could be polled. Both would then be one fewer pinned connection each. |
| Non-Supabase Postgres for `DATABASE_URL` | Yes | Not in scope for this ticket, but note `APP_DB_ADMIN_URL` (published-apps DB) and `DATABASE_URL` must already be different databases (`src/config.ts:344`), so mixing providers is already an expected shape. |

## 6. Supabase-specific gotchas that would bite qm

1. **The 350-second silent death of a `LISTEN` socket — the biggest risk.** The pooler host resolves to
   an AWS ELB (`pool-tcp-us-east-1-…elb.us-east-1.amazonaws.com`, three A records — one per AZ, the
   shape of a Network Load Balancer; **inferred** that it is an NLB). AWS: "The default idle timeout
   value for TCP flows is 350 seconds… If a client or target sends data after the idle timeout period
   elapses, the client receives a TCP RST packet… Clients or targets can use TCP keepalive packets to
   restart the idle timeout"
   ([AWS NLB docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)).
   A qm `LISTEN` client sends nothing for as long as nothing happens, and Supavisor sends nothing either,
   so after ~6 idle minutes the flow stops being tracked. node-postgres does not enable TCP keepalives
   by default — `keepAlive?: boolean, // if true, enable keepalive on the net.Socket`
   ([pg.Client](https://node-postgres.com/apis/client)) — and `createPgPool` never sets it. The failure
   mode is the bad one: no `error` event fires until qm next writes on that socket, so
   `client.on("error")` never runs, `dropListenClient()`/reconnect never happens, and session-state and
   run-signal notifications are silently lost. `postgres-run-signal-store.ts` at least keeps a durable
   table that could be polled; `postgres-session-state-bus.ts` would just go quiet. Mitigation: pass
   `keepAlive: true, keepAliveInitialDelayMillis` well under 350 s in `createPgPool`, or send a periodic
   `SELECT 1` on the LISTEN client. **Inferred** end-to-end; not documented by Supabase.
2. **Username must be `postgres.<project-ref>` on the pooler.** Documented example:
   `postgres://postgres.apbkobhfnmcqqzqeeqss:[PASSWORD]@aws-[REGION].pooler.supabase.com:5432/postgres`
   ([docs](https://supabase.com/docs/guides/database/connecting-to-postgres)); the direct host uses a
   bare `postgres`. Supavisor parses the tenant out of the username, so the suffix is not cosmetic.
   `src/deploy/app-database.ts:79-104` already models this (`projectRef` split on the first `.`, and
   `mintAppUrl` re-appends `.<ref>` to every per-app role). A same-shaped `DATABASE_URL` needs the same
   treatment for any role other than `postgres`.
3. **SSL is available but not enforced by default.** "Your Supabase project supports connecting to the
   Postgres DB without SSL enabled to maximize client compatibility… Disabling SSL enforcement only
   applies to connections to Postgres, Supavisor (shared Connection Pooler) and PgBouncer"
   ([SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)); Supavisor answers an
   `SSLRequest` with `S` only if downstream certs are configured
   ([client_handler.ex](https://github.com/supabase/supavisor/blob/main/lib/supavisor/client_handler.ex)).
   Since `pg` does not enable TLS unless told to, a `DATABASE_URL` with no `sslmode` connects in
   cleartext over the public internet. Always set at least `sslmode=no-verify`. Also: "Applying or
   updating SSL enforcement triggers a fast database reboot", which will drop every pooled connection
   and every session-level lock.
4. **Free projects get paused.** "Supabase pauses Free Plan projects that show low activity over a
   7-day period… Typically a few user requests to the database each day over the previous week is enough
   to keep the project from being paused"
   ([Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)). A restore is
   manual from the dashboard. A qm instance that is up and sweeping produces enough activity; a
   dev-instance used occasionally may not.
5. **Every restart drops session state, by design.** Session-level advisory locks vanish when the
   session ends — which is correct for a leader lease (that is how `leader-lease.ts` detects loss), but
   it means a pooler restart, a compute resize, an SSL-enforcement toggle or a pool-size change makes
   every leader re-elect and every `LISTEN` reconnect. `leader-lease.ts` and both LISTEN holders already
   handle client death (reconnect after 1 s, `lost` promise fires), so this is expected-path, not a bug —
   provided gotcha 1 is fixed so death is actually observed.
6. **Shared pool size is shared with Supabase Storage.** "the Storage server also uses Supavisor as a
   unique 'user+db+mode' combination, so the pool size you set for your general application will apply
   to it, too" ([FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)). Budget
   accordingly.
7. **Multiple qm instances multiply everything.** The core runs blue-green/multi-instance, so the
   §4 arithmetic is per process. Two instances of 26 pools is 52 client connections before any burst.

## Open questions / what the docs don't say

- **Supabase never documents LISTEN/NOTIFY or advisory-lock behaviour in either mode.** Everything in §1
  beyond the dedicated-connection sentence is read off Supavisor's source and Postgres' semantics. Do a
  two-terminal `LISTEN`/`NOTIFY` test through the session pooler before trusting it in production.
- **The pool size Supabase actually provisions per plan is undocumented.** 15 is Supavisor's code
  default; the real value is whatever the dashboard shows. I could not verify it without a project.
- **Whether session mode's `pool_size` client cap queues or rejects.** The code path I read
  (`check_client_limit`) rejects with `EMAXCONNSESSION` before authentication; the FAQ's "can queue
  clients for up to a minute" appears to describe pool checkout. I could not find a doc that reconciles
  the two.
- **No documented Supavisor client-idle timeout.** I found no `client_idle_timeout` in Supavisor's config
  and no Supabase doc naming one, and the Timeouts page documents only statement timeouts
  ([Timeouts](https://supabase.com/docs/guides/database/postgres/timeouts)). So the 350 s hazard in
  gotcha 1 is a network-layer inference, not a documented pooler behaviour, and I could not confirm the
  load balancer type or its configured idle timeout from outside.
- **Whether Supabase sets `idle_session_timeout` on the Postgres side.** Not documented; unverified. If
  it is non-zero, a pinned `LISTEN` backend could also be killed server-side.
- **Doc contradiction on whether ports 5432 and 6543 share one pool-size budget** (see end of §4),
  unresolved from first-party sources.
- **Not measured:** how many of the 26 pools a given deployment actually instantiates. Several are gated
  on store-selection config in `src/wiring.ts`, so 26 is the ceiling of the fully-Postgres configuration,
  counted statically from `createPgPool` call sites rather than observed at runtime.
