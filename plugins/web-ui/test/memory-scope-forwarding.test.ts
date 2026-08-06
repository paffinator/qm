import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const seen: Array<{ method: string; url: string }> = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    if (url.startsWith("/v1/memory")) seen.push({ method: req.method ?? "GET", url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: "", revision: "1", revisions: [] }));
  });
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.CORE_SIGNING_SECRET;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const ALICE = { cookie: "webuiuser=alice" };
const PROJECT = "group:web-project-p1";

test.after(() => {
  surface.close();
  core.close();
});

test("a project scope reaches core on both memory reads", async () => {
  seen.length = 0;
  assert.equal(
    (await fetch(`${base}/api/memory?scope=${encodeURIComponent(PROJECT)}`, { headers: ALICE })).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/api/memory/history?scope=${encodeURIComponent(PROJECT)}`, { headers: ALICE })).status,
    200,
  );
  const [head, history] = seen;
  assert.match(head?.url ?? "", /^\/v1\/memory\?/, "the head read keeps its own path");
  assert.match(head?.url ?? "", /principalId=alice/, "the principal still comes from the session, not the query");
  assert.match(head?.url ?? "", /scope=group%3Aweb-project-p1/, "and the requested scope is forwarded");
  assert.match(history?.url ?? "", /^\/v1\/memory\/history\?/, "history keeps its own path");
  assert.match(history?.url ?? "", /scope=group%3Aweb-project-p1/, "history forwards the scope too");
});

test("omitting the scope forwards no scope at all", async () => {
  seen.length = 0;
  await fetch(`${base}/api/memory`, { headers: ALICE });
  assert.match(seen[0]?.url ?? "", /principalId=alice/);
  assert.doesNotMatch(seen[0]?.url ?? "", /scope=/, "no scope param invented for the caller's own notebook");
});

test("a write cannot be aimed at a project notebook", async () => {
  seen.length = 0;
  const put = await fetch(`${base}/api/memory?scope=${encodeURIComponent(PROJECT)}`, {
    method: "PUT",
    headers: { ...ALICE, "content-type": "application/json" },
    body: JSON.stringify({ content: "aimed elsewhere", revision: "1" }),
  });
  assert.equal(put.status, 200);
  const write = seen.find((c) => c.method === "PUT");
  assert.ok(write, "the write still reaches core");
  assert.doesNotMatch(write.url, /scope=/, "but carries no scope: writes stay on the caller's own notebook");
});
