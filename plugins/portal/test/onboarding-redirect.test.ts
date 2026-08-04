import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let providerConfigured = false;
let providerReason: string | undefined = "needs_admin_key";
let harnessId = "pi";

const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url?.startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({
        webuiModels: [],
        baseModel: "m",
        harnessId,
        modelProviderConfigured: providerConfigured,
        ...(providerReason ? { modelProviderReason: providerReason } : {}),
      }),
    );
  }
  if (req.url === "/api/whoami") {
    const m = (req.headers.cookie ?? "").match(/admin=([^;]+)/);
    const sub = m ? decodeURIComponent(m[1] ?? "") : "";
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: sub === "U-admin" }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "onboarding-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "onboarding-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const sessionKey = deriveKey("onboarding-test-portal-secret", "portal.session.v1");
function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub, org: "acme", iat: now, exp: now + 28800 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  upstream.close();
});

test("unconfigured deployment: admin HTML navigation to web-ui redirects to admin onboarding", async () => {
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/admin/onboarding");
});

test("unconfigured deployment: non-admin HTML navigation gets a not-set-up page, not a bare 403", async () => {
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
    redirect: "manual",
  });
  assert.equal(r.status, 503);
  assert.match(await r.text(), /isn&#39;t set up yet/);
});

test("unconfigured deployment: web-ui JSON requests still proxy through untouched", async () => {
  const r = await fetch(`${base}/api/sessions`, { headers: { cookie: sessionCookie("U-admin") } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { url: string }).url, "/api/sessions");
});

test("unconfigured deployment: the admin surface itself is reachable, so onboarding never loops", async () => {
  const r = await fetch(`${base}/admin/onboarding`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { url: string }).url, "/onboarding");
});

test("an env-credential harness does not bounce admins into onboarding they cannot use", async () => {
  harnessId = "claude";
  providerReason = "harness_requires_deployment_env";
  await new Promise((r) => setTimeout(r, 5_200));
  const admin = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(admin.status, 503, "redirecting here is the loop: the admin page cannot set a deployment env var");
  const adminBody = await admin.text();
  assert.match(adminBody, /deployment&#39;s own environment/);
  assert.doesNotMatch(adminBody, /Ask your admin to complete onboarding/);

  const member = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-member") },
    redirect: "manual",
  });
  assert.equal(member.status, 503);
  assert.match(await member.text(), /will not reach it/);

  harnessId = "pi";
  providerReason = "needs_admin_key";
  await new Promise((r) => setTimeout(r, 5_200));
});

test("once a provider is configured, admin HTML navigation proxies to web-ui again", async () => {
  providerConfigured = true;
  providerReason = "ready";
  await new Promise((r) => setTimeout(r, 5_200));
  const r = await fetch(`${base}/`, {
    headers: { accept: "text/html", cookie: sessionCookie("U-admin") },
    redirect: "manual",
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { url: string }).url, "/");
});
