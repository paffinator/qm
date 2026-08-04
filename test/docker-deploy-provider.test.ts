import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

interface Shim {
  docker: string;
  invocations(): string[][];
}

function dockerShim(): Shim {
  const dir = mkdtempSync(join(tmpdir(), "docker-shim-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\n{ echo "==="; printf '%s\\n' "$@"; } >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return {
    docker: bin,
    invocations() {
      let raw: string;
      try {
        raw = readFileSync(log, "utf8");
      } catch {
        return [];
      }
      return raw
        .split("===\n")
        .filter((chunk) => chunk.trim().length > 0)
        .map((chunk) => chunk.split("\n").filter((line) => line.length > 0));
    },
  };
}

function deployment(): Deployment {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    ownerScopeId: scopeId("personal", "u1"),
    createdBy: "u1",
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [],
  };
}

function version(env?: Record<string, string>): DeploymentVersion {
  return {
    version: 1,
    createdAt: Date.now(),
    entrypoint: "node server.js",
    snapshotDir: "/tmp/snap",
    ...(env ? { env } : {}),
  };
}

function runArgs(shim: Shim): string[] {
  const run = shim.invocations().find((argv) => argv[0] === "run");
  assert.ok(run, "the provider ran a container");
  return run;
}

function envFlags(argv: string[]): string[] {
  return argv.flatMap((arg, i) => (arg === "-e" && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
}

test("published env reaches the container, but a key that is not a shell identifier is dropped", async () => {
  const shim = dockerShim();
  const provider = createDockerDeployProvider({ docker: shim.docker });
  await provider.apply(deployment(), version({ "A=B": "smuggled", "2BAD": "no", GOOD: "v" }));
  const flags = envFlags(runArgs(shim));
  assert.ok(flags.includes("GOOD=v"), "a valid key is passed through");
  assert.ok(!flags.some((f) => f.includes("smuggled")), "a key containing = is never handed to docker run");
  assert.ok(!flags.some((f) => f.startsWith("2BAD=")), "a key starting with a digit is dropped");
});

test("PORT is the runtime's to set — a published PORT cannot win, because docker takes the last -e", async () => {
  const shim = dockerShim();
  const provider = createDockerDeployProvider({ docker: shim.docker });
  await provider.apply(deployment(), version({ PORT: "3000" }));
  const flags = envFlags(runArgs(shim));
  assert.deepEqual(
    flags.filter((f) => f.startsWith("PORT=")),
    ["PORT=8080"],
    "exactly one PORT, and it is the framework's",
  );
});

test("resolved secrets are exported and a published env key cannot shadow them", async () => {
  const shim = dockerShim();
  const provider = createDockerDeployProvider({
    docker: shim.docker,
    resolveDeploySecrets: async () => ({ DATABASE_URL: "postgres://u:p@h:5432/postgres" }),
  });
  await provider.apply(deployment(), version({ DATABASE_URL: "postgres://attacker/" }));
  const flags = envFlags(runArgs(shim));
  assert.ok(flags.includes("DATABASE_URL=postgres://u:p@h:5432/postgres"), "the provisioned URL is passed");
  assert.ok(!flags.some((f) => f.includes("attacker")), "a published DATABASE_URL never wins");
});
