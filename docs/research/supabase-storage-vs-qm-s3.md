# Can qm's S3 byte store write artifact bytes to Supabase Storage?

Research date: 2026-08-05.
`@aws-sdk/client-s3` installed: **3.1096.0** (declared `^3.1061.0` in `package.json`).

## Verdict

**Yes — with configuration only, plus one caveat that is best fixed by a one-line code change.**

The gating question (can qm's S3 client be pointed at a non-AWS endpoint?) resolves in favour of
"yes": `s3Client()` constructs a bare `S3Client`, which means the AWS SDK's own environment-based
endpoint override (`AWS_ENDPOINT_URL_S3`) applies with no code change. qm's own deploy configs
already depend on this (they set `S3_REGION = "auto"` and no endpoint, i.e. Fly's Tigris, which
injects `AWS_ENDPOINT_URL_S3` as a secret).

The one real gap is **addressing style**. Supabase requires path-style; the SDK defaults to
virtual-hosted-style and `forcePathStyle` is a client-constructor option with **no** environment
variable. There is a config-only workaround (bucket name that is not virtual-hostable), but the
clean fix is a one-line change in `src/persistence/s3.ts`.

Two facts to note before doing this at all:

- **Lifecycle rules: not supported by Supabase.** `PutBucketLifecycleConfiguration` and
  `GetBucketLifecycleConfiguration` are both documented as ❌. qm's `ensureExpiry` will fail and log;
  the periodic sweep remains the fallback, so nothing breaks. Also note `ensureExpiry` belongs to
  the **transfer** store only, not to the artifact byte store this question is about.
- **Storage has its own quota.** 1 GB file storage on Free, separate from the 500 MB database.
  But per-file uploads on Free are capped at **50 MB**, versus qm's `MAX_BLOB_BYTES` of 1 GB.

## Part 1 — What qm's S3 code actually does (repo facts)

All line references are to this checkout.

### The client is constructed with region and nothing else

`src/persistence/s3.ts:8-10`:

```ts
export function s3Client(region?: string): S3Send {
  return new S3Client(region ? { region } : {}) as S3Send;
}
```

Consequences, all verified:

- **No `endpoint` option.** But an `S3Client` with no explicit endpoint resolves its endpoint through
  the SDK's standard chain, which includes the `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` environment
  variables and the shared-config `endpoint_url` key. Verified in the installed SDK at
  `node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/getEndpointUrlConfig.js`
  (`ENV_ENDPOINT_URL = "AWS_ENDPOINT_URL"`, with the service suffix `_S3` taking precedence), and
  empirically: with `AWS_ENDPOINT_URL_S3=https://abcdef.storage.supabase.co/storage/v1/s3`, a
  `PutObjectCommand` was signed and dispatched to that host. **So there is no code change needed to
  reach a non-AWS endpoint.**
- **No `credentials` option**, so the default credential chain applies —
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and optionally `AWS_SESSION_TOKEN`) from the
  environment work.
- **No `forcePathStyle`**, so it defaults to `false` (`node_modules/@aws-sdk/client-s3/dist-cjs/index.js:930`:
  `forcePathStyle: options.forcePathStyle ?? false`). There is **no environment variable** for this
  setting in the SDK — it is a client context param only.

Empirically measured request URLs (SDK 3.1096.0, endpoint
`https://abcdef.storage.supabase.co/storage/v1/s3`, `PutObject` of key `files/abc`):

| bucket         | `forcePathStyle` | request URL                                                                            |
| -------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `qm-artifacts` | default (false)  | `https://qm-artifacts.abcdef.storage.supabase.co/storage/v1/s3/files/abc` — **broken** |
| `qm-artifacts` | `true`           | `https://abcdef.storage.supabase.co/storage/v1/s3/qm-artifacts/files/abc` — correct    |
| `qm` (2 chars) | default (false)  | `https://abcdef.storage.supabase.co/storage/v1/s3/qm/files/abc` — correct              |
| `qm.files`     | default (false)  | `https://abcdef.storage.supabase.co/storage/v1/s3/qm.files/files/abc` — correct        |
| `qm_files`     | default (false)  | `https://abcdef.storage.supabase.co/storage/v1/s3/qm_files/files/abc` — correct        |

The pattern is the AWS virtual-hosting rule: the SDK only hoists the bucket into the hostname when
the bucket name is a valid virtual-host label (3–63 chars, lowercase, no dots/underscores). A name
that fails that test falls back to path style automatically, custom endpoint or not.

### The artifact byte store (`snapshotStore`) uses four operations, all simple

`src/files/durable-byte-store.ts:132-167`, `createS3DurableByteStore`:

- `put` → `PutObjectCommand` with a fully buffered `Body` (`collect()` reads the whole source into
  memory first). **No multipart upload on this path.**
- `open` → `GetObjectCommand`, streaming the response body.
- `delete` → `DeleteObjectCommand`.
- Keys are `"<prefix>files/<sha256>"`; the store is content-addressed and `open`/`delete` validate
  `^files\/[0-9a-f]{64}$` before touching S3.

No presigned URLs anywhere on this path (`getSignedUrl` does not appear in `src/`).

### The transfer store is the one with lifecycle rules and multipart

`src/persistence/blob-transfer.ts:169-350`, `createS3BlobTransferStore` — a separate store selected
by `TRANSFER_STORE`, keyed under `"<prefix>transfer/"`:

- `put` uses **real multipart upload** (`CreateMultipartUpload` / `UploadPart` /
  `CompleteMultipartUpload`, with `AbortMultipartUpload` on failure) once the source exceeds
  `S3_PART_BYTES` = 16 MiB; smaller bodies take a single `PutObject`.
- `sweep` uses `ListObjectsV2` + `DeleteObject`.
- `ensureExpiry` (`blob-transfer.ts:321-348`) reads `GetBucketLifecycleConfiguration`, merges a rule
  `qm-transfer-expiry` (`Expiration.Days`, `AbortIncompleteMultipartUpload.DaysAfterInitiation`),
  and writes it back with `PutBucketLifecycleConfiguration`.

`src/wiring.ts:1345-1350` installs it best-effort and never throws:

```ts
void blobTransfer
  .ensureExpiry?.(BLOB_TRANSFER_EXPIRY_DAYS)
  .catch((e) =>
    console.error("[blob-transfer] S3 lifecycle expiry install failed (sweep remains the fallback):", errMessage(e)),
  );
```

The sweeper on the line above (`createSweeper(() => blobTransfer.sweep(BLOB_TTL_MS), 30 * 60_000)`)
runs unconditionally, so a lifecycle failure costs only a startup log line.

### Config keys and wiring

`src/config.ts:844-848`:

```
SNAPSHOT_STORE = "s3" | anything-else→"local"     → config.snapshotStore
TRANSFER_STORE = "s3" | anything-else→"local"     → config.transferStore
S3_BUCKET → config.s3Bucket
S3_REGION → config.s3Region
S3_PREFIX → config.s3Prefix
```

(There is a separate, unrelated pair `AWS_SANDBOX_S3_BUCKET` / `AWS_SANDBOX_S3_PREFIX` at
`src/config.ts:216-217` for the sandbox provider — not part of this question.)

`src/wiring.ts:544-562` — both stores are gated on `store === "s3" && config.s3Bucket`, and
`SNAPSHOT_STORE=s3` is the switch that moves artifact bytes off local disk. Postgres only ever
stores metadata: `createPostgresFileArtifactStore(config.databaseUrl, fileBytes)` wraps whichever
byte store was chosen.

Evidence that qm's S3 path is already used against a non-AWS provider: `deploy/core/fly.toml:12-14`
and `deploy/stacks/*` set `SNAPSHOT_STORE=s3`, `TRANSFER_STORE=s3`, `S3_REGION="auto"`. `"auto"` is
the Tigris/R2 convention, and `fly storage create` sets `AWS_ENDPOINT_URL_S3`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=auto` and `BUCKET_NAME` as app secrets
([Fly docs — Tigris object storage](https://fly.io/docs/tigris/)). Tigris serves virtual-hosted-style
on a wildcard domain, which is why the missing `forcePathStyle` has never bitten.

## Part 2 — Supabase Storage's S3 endpoint (primary sources)

### 2.1 Endpoint, region, path style

- Endpoint form: `https://<project_ref>.storage.supabase.co/storage/v1/s3`; local development is
  `http://127.0.0.1:54321/storage/v1/s3` with region `local`.
  ([Supabase — S3 Authentication](https://supabase.com/docs/guides/storage/s3/authentication))
- Region: the project's region, copied together with the endpoint from the dashboard's
  S3 configuration page (`https://supabase.com/dashboard/project/_/storage/s3`). It is a real region
  string (e.g. `us-east-1`), not `auto`. Same source.
- Path style: **required**. Supabase's own `S3Client` examples set `forcePathStyle: true`. Same source.
  This is consistent with the endpoint carrying a URL path (`/storage/v1/s3`) — virtual-hosted
  addressing would produce `https://<bucket>.<ref>.storage.supabase.co/...`, a hostname Supabase does
  not serve.
- Supabase also notes that for large uploads you should use the direct storage hostname
  `https://<project-id>.storage.supabase.co` rather than the general project URL. Same source.

### 2.2 Credentials

Two credential types ([Supabase — S3 Authentication](https://supabase.com/docs/guides/storage/s3/authentication)):

1. **S3 access keys** — an Access Key ID + Secret Access Key generated on the S3 configuration page.
   Docs: they "provide full access to all S3 operations across all buckets and bypass RLS policies.
   These are meant to be used only on the server." **This is the one qm needs.**
2. **Session token** — `accessKeyId: project_ref`, `secretAccessKey: anonKey`,
   `sessionToken: <user JWT>`, giving RLS-scoped access. Usable client-side.

Mapping onto qm: qm passes no credentials, so the SDK default chain is used —
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` env vars take the S3 access key pair directly.
There is no qm config key for credentials, and none is needed. The service-role JWT is **not** an
S3 credential and does not go here; the session-token form would technically work via
`AWS_SESSION_TOKEN` but is the wrong shape for a server-side, all-buckets writer.

### 2.3 Operation support

From [Supabase — S3 Compatibility](https://supabase.com/docs/guides/storage/s3/compatibility):

| Operation qm uses                 | Supabase                                                                                                                            | Path           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `PutObject`                       | ✅ (system metadata: Content-Type, Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Expires; ❌ Content-MD5) | both stores    |
| `GetObject`                       | ✅ (conditional requests + ranges)                                                                                                  | both stores    |
| `DeleteObject`                    | ✅                                                                                                                                  | both stores    |
| `ListObjectsV2`                   | ✅ (`continuation-token`, `delimiter`, `max-keys`, `prefix`, `start-after`, …)                                                      | transfer sweep |
| `CreateMultipartUpload`           | ✅                                                                                                                                  | transfer store |
| `UploadPart`                      | ✅                                                                                                                                  | transfer store |
| `CompleteMultipartUpload`         | ✅                                                                                                                                  | transfer store |
| `AbortMultipartUpload`            | ✅                                                                                                                                  | transfer store |
| Presigned URLs                    | ✅ (SigV4 query parameters)                                                                                                         | unused by qm   |
| `GetBucketLifecycleConfiguration` | ❌                                                                                                                                  | `ensureExpiry` |
| `PutBucketLifecycleConfiguration` | ❌                                                                                                                                  | `ensureExpiry` |

Bucket operations that _are_ supported: `ListBuckets`, `HeadBucket`, `CreateBucket`, `DeleteBucket`,
`GetBucketLocation`. Not supported: CORS (`GetBucketCors`, `PutBucketCors`, `DeleteBucketCors`),
`GetBucketEncryption`, and the two lifecycle calls. Object tagging (`x-amz-tagging`) and ACLs
(`x-amz-acl`, `x-amz-grant-*`) are ❌. Versioning is explicitly out: "S3 versioning is not supported.
Supabase Storage does not enable S3's versioning capabilities for buckets. Deleted objects are
permanently removed and cannot be restored." Same source.

**Lifecycle answer, stated plainly: Supabase Storage does not support object lifecycle/expiry rules
at all.** For qm this is harmless — `ensureExpiry` is only reached by the transfer store, and
`wiring.ts:1346` swallows the failure into a log line while the 30-minute sweeper keeps doing the
work. If you only set `SNAPSHOT_STORE=s3` and leave `TRANSFER_STORE=local`, the call is never made.

### 2.4 Quotas

Storage is a **separate** quota from the database, not a shared 500 MB budget:

- Free plan: "500 MB database size", "1 GB file storage", "5 GB egress"
  ([Supabase pricing](https://supabase.com/pricing)).
- The billing docs list Storage Size (1 GB) and Database Size (500 MB per project) as distinct
  Free-plan quota line items
  ([Supabase — Billing](https://supabase.com/docs/guides/platform/billing-on-supabase)).

But there is a per-file ceiling that matters more than the aggregate:

- "For Free projects, the limit can't exceed 50 MB"; Pro and above can be raised to 500 GB
  ([Supabase — File limits](https://supabase.com/docs/guides/storage/uploads/file-limits)).

qm's `MAX_BLOB_BYTES` is `1_000_000_000` (`src/persistence/blob-transfer.ts:24`), so on a Free
project any artifact above 50 MB will be rejected by Supabase even though qm would accept it. For a
single-user local instance this is unlikely to bite, but it is a real behavioural difference from
local disk.

## Part 3 — The exact configuration

### Recommended: one-line code change plus env

Change `src/persistence/s3.ts` so the client honours a path-style setting. The minimal, endpoint-agnostic
version (a bare `forcePathStyle: true` is safe against AWS too, but changes behaviour for existing
Tigris/AWS deployments' request URLs, so gate it):

```ts
export function s3Client(region?: string): S3Send {
  return new S3Client({
    ...(region ? { region } : {}),
    ...(process.env.S3_FORCE_PATH_STYLE === "true" ? { forcePathStyle: true } : {}),
  }) as S3Send;
}
```

(If this is pursued for real, the setting belongs in `src/config.ts` alongside `S3_REGION` /
`S3_PREFIX` and should be threaded through `S3DurableByteOptions` / `S3BlobTransferOptions` like
`region` and `prefix` already are, rather than read from `process.env` in the client factory. And it
is core code, so under the fork rules it goes upstream, not into the fork.)

Then:

```
SNAPSHOT_STORE=s3
S3_BUCKET=<the Supabase Storage bucket name>
S3_REGION=<project region from the dashboard S3 configuration page>
S3_PREFIX=                                  # optional, e.g. "qm/"
S3_FORCE_PATH_STYLE=true                    # only exists after the change above

AWS_ENDPOINT_URL_S3=https://<project_ref>.storage.supabase.co/storage/v1/s3
AWS_ACCESS_KEY_ID=<S3 access key id from the dashboard S3 configuration page>
AWS_SECRET_ACCESS_KEY=<S3 secret access key>
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
```

Leave `TRANSFER_STORE` unset (local) unless you want transfer blobs in Supabase too; the transfer
store is short-lived, sweeper-managed scratch space and gains nothing from durability.

The Supabase bucket must be created first — qm never calls `CreateBucket`.

### Config-only alternative (no code change)

Name the Supabase bucket something that is not a valid virtual-host label, and the SDK falls back to
path style on its own. Verified above: `qm.files`, `qm_files`, `QMFiles`, and any name of 2 or fewer
characters all produce the correct path-style URL with `forcePathStyle` left at its default. Same env
block as above, minus `S3_FORCE_PATH_STYLE`.

This works, but it is load-bearing on an implementation detail of the SDK's endpoint ruleset and on
Supabase accepting such a bucket name (**unverified** — Supabase's bucket-name validation rules are
not documented on the pages cited here). Treat it as a way to test the idea in an afternoon, not as
the configuration to live with.

### Why `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`

SDK 3.1096.0 adds flexible checksums to `PutObject` by default. Measured headers for
`createS3DurableByteStore.put`:

```
x-amz-sdk-checksum-algorithm: CRC32
x-amz-checksum-crc32: jNwWgw==
```

The Supabase compatibility page does not list any `x-amz-checksum-*` or
`x-amz-sdk-checksum-algorithm` header as supported, and marks checksum headers ❌ where it mentions
them (CopyObject, PutBucketCors). Whether Supabase **rejects** these headers on `PutObject` or merely
ignores them is **not stated in the docs and was not tested here** — this is the one open risk in the
whole plan. Setting `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` removes the headers entirely
(verified empirically against the installed SDK: no `checksum` headers on the wire), so it costs
nothing and removes the unknown. `x-amz-content-sha256` is still sent and is standard SigV4.

## Part 4 — Residual risks and unknowns

Verified above unless marked otherwise.

1. **Checksum headers** — unverified whether Supabase 400s on `x-amz-checksum-crc32`. Mitigated by
   `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`.
2. **Bucket names with dots/underscores** — unverified that Supabase accepts them. Only relevant to
   the no-code-change path.
3. **50 MB per-file cap on Free** vs qm's 1 GB `MAX_BLOB_BYTES`. Artifacts above the cap will fail at
   the store, surfacing as an upload error rather than a size-limit error.
4. **No versioning, no undelete.** Supabase deletes are permanent. qm's byte store is
   content-addressed, so a `delete` of a still-referenced sha256 is unrecoverable — same risk as
   local disk, worth naming because "durable" can be read as "backed up".
5. **Egress**: 5 GB/month on Free. Every artifact read is Supabase egress, where local disk was free.
6. **End-to-end untested.** Nothing in this document was exercised against a live Supabase project;
   the empirical parts are SDK request-shaping measurements against a fake endpoint plus reads of
   qm's source. A real test is: `SNAPSHOT_STORE=s3` + the env block, upload one artifact, confirm the
   object appears under `files/<sha256>` in the Supabase dashboard, and read it back.

## Part 5 — Fallback, and when to prefer it

For a single-user local instance, the acceptable fallback — Postgres metadata plus local-disk bytes,
i.e. exactly today's default at `src/wiring.ts:559` — remains reasonable, and the reason is now
precise. Supabase Storage _can_ hold the bytes and the wiring is close to free, but:

- it needs a core code change (or a bucket-naming trick) for path-style addressing;
- it caps individual artifacts at 50 MB on the Free plan, tighter than qm's own 1 GB limit;
- it cannot host the lifecycle rule qm would like for transfer blobs, so that path stays sweeper-driven;
- and it converts every artifact read into metered egress.

None of those is a blocker. The decision is about whether "files survive the machine" is worth a core
change plus a 50 MB per-artifact ceiling; the mechanism itself is sound.

## Sources

- [Supabase — Storage: S3 Authentication](https://supabase.com/docs/guides/storage/s3/authentication)
- [Supabase — Storage: S3 Compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
- [Supabase — Storage: File limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
- [Supabase — Pricing](https://supabase.com/pricing)
- [Supabase — Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Fly.io — Tigris Global Object Storage](https://fly.io/docs/tigris/)
- Installed SDK, read directly: `node_modules/@smithy/core/dist-es/submodules/endpoints/middleware-endpoint/adaptors/getEndpointUrlConfig.js`,
  `node_modules/@aws-sdk/client-s3/dist-cjs/index.js:930`,
  `node_modules/@aws-sdk/checksums/dist-es/submodules/flexible-checksums/NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS.js`
- qm source: `src/persistence/s3.ts`, `src/persistence/blob-transfer.ts`,
  `src/files/durable-byte-store.ts`, `src/config.ts:844-848`, `src/wiring.ts:544-562`,
  `src/wiring.ts:1343-1350`, `deploy/core/fly.toml:12-14`
