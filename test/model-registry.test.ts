import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  SELECTABLE_BASE_MODELS,
  DEFAULT_WEBUI_MODEL_IDS,
  FAST_MODE_MODEL_IDS,
  resolveModel,
  modelSupportsFastMode,
  modelServiceable,
  serviceableModelIds,
  modelProviderAvailabilityFor,
  defaultModelForHarness,
} from "../src/model/pi-models.ts";
import { claudeCliKeylessCredential, loadConfig, providerKeysPresent } from "../src/config.ts";
import { claudeChildEnv } from "../src/harness/claude-harness.ts";
import { validateWebTurnModelOptions } from "../src/core/turn-options.ts";

test("every registry model resolves via pi-ai (nothing offered that turns can't serve)", () => {
  for (const m of MODEL_REGISTRY) {
    assert.ok(resolveModel(m.id), `registry model ${m.id} must resolve`);
  }
});

test("picker ⊆ gate: every selectable base model is web-ui-enabled", () => {
  const webui = new Set(DEFAULT_WEBUI_MODEL_IDS);
  for (const m of SELECTABLE_BASE_MODELS) {
    assert.ok(
      webui.has(m.id),
      `${m.id} is offered in the picker but not in the web-ui gate set — this is the drift that 403s`,
    );
  }
});

test("every web-ui-enabled model passes the web-turn model gate (no 403 for an offered model)", () => {
  for (const id of DEFAULT_WEBUI_MODEL_IDS) {
    assert.equal(
      validateWebTurnModelOptions({ model: id }, null),
      null,
      `${id} must not be refused by validateWebTurnModelOptions`,
    );
  }
});

test("regression: gpt-5.6-sol is web-ui-enabled (the reported 403)", () => {
  assert.ok(DEFAULT_WEBUI_MODEL_IDS.includes("gpt-5.6-sol"));
  assert.equal(validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null), null);
});

test("FAST_MODE_MODEL_IDS derives from the registry — the web-ui client reads this, keeps no copy", () => {
  assert.deepEqual(
    [...FAST_MODE_MODEL_IDS].sort(),
    MODEL_REGISTRY.filter((m) => m.fastMode)
      .map((m) => m.id)
      .sort(),
  );
  for (const id of FAST_MODE_MODEL_IDS) assert.equal(modelSupportsFastMode(id), true);
});

test("exposure is provider-key-aware: a model whose provider is unconfigured is not serviceable", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  assert.equal(modelServiceable("gpt-5.6-sol", noOpenai), false);
  assert.equal(modelServiceable("claude-opus-4-8", noOpenai), true);
  assert.deepEqual(serviceableModelIds(["claude-opus-4-8", "gpt-5.6-sol"], noOpenai), ["claude-opus-4-8"]);
});

test("provider-key gating applies to key-authed harnesses, never to mock", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  assert.deepEqual(modelProviderAvailabilityFor("pi", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("opencode", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("pi", noKeys, { anthropic: false, openai: true, openrouter: true }), {
    anthropic: false,
    openai: true,
    openrouter: true,
  });
  assert.deepEqual(
    modelProviderAvailabilityFor(
      "opencode",
      { anthropic: true, openai: true, openrouter: true },
      { anthropic: false, openai: false, openrouter: false },
    ),
    { anthropic: true, openai: true, openrouter: false },
  );
  assert.deepEqual(modelProviderAvailabilityFor("codex", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("codex", { anthropic: false, openai: true, openrouter: false }), {
    anthropic: false,
    openai: true,
    openrouter: false,
  });
  assert.deepEqual(modelProviderAvailabilityFor("mock", noKeys), { anthropic: true, openai: true, openrouter: true });
});

test("claude harness serves anthropic only, and only with a credential its CLI child can see", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  const allKeys = { anthropic: true, openai: true, openrouter: true };
  assert.deepEqual(modelProviderAvailabilityFor("claude", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("claude", allKeys), {
    anthropic: true,
    openai: false,
    openrouter: false,
  });
  assert.deepEqual(
    modelProviderAvailabilityFor("claude", noKeys, allKeys),
    noKeys,
    "an admin-pasted key never reaches the claude CLI child",
  );
  assert.deepEqual(
    modelProviderAvailabilityFor("claude", noKeys, noKeys, { claude: true }),
    { anthropic: true, openai: false, openrouter: false },
    "a keyless CLI credential serves anthropic with no api key present",
  );
});

test("codex serves openai on a ChatGPT credential, and that credential leaks nowhere else", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  const cli = { codex: true };
  assert.deepEqual(modelProviderAvailabilityFor("codex", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("codex", noKeys, noKeys, cli), {
    anthropic: false,
    openai: true,
    openrouter: false,
    openaiViaSubscription: true,
  });
  assert.deepEqual(
    modelProviderAvailabilityFor("claude", noKeys, noKeys, cli),
    noKeys,
    "a ChatGPT credential cannot serve an anthropic model",
  );
  assert.deepEqual(modelProviderAvailabilityFor("opencode", noKeys, noKeys, cli), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("pi", noKeys, noKeys, cli), noKeys);
});

test("a ChatGPT credential serves every codex model except the api-key-only tier", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  const subscription = modelProviderAvailabilityFor("codex", noKeys, noKeys, { codex: true });
  assert.equal(modelServiceable("gpt-5.6-sol", subscription), false);
  assert.equal(modelServiceable("gpt-5.6-terra", subscription), true);
  assert.equal(modelServiceable("gpt-5.6-luna", subscription), true);
  assert.equal(
    defaultModelForHarness("codex", undefined, subscription),
    "gpt-5.6-terra",
    "the default must not be a model the subscription cannot run",
  );

  const keyed = modelProviderAvailabilityFor("codex", { anthropic: false, openai: true, openrouter: false });
  assert.equal(modelServiceable("gpt-5.6-sol", keyed), true, "an api key still serves the api-key-only tier");
  assert.equal(defaultModelForHarness("codex", undefined, keyed), "gpt-5.6-sol");
});

test("a keyless claude credential never leaks into another harness's availability", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  const cli = { claude: true };
  assert.deepEqual(
    modelProviderAvailabilityFor("opencode", noKeys, noKeys, cli),
    noKeys,
    "opencode cannot use a Claude Code OAuth token",
  );
  assert.deepEqual(modelProviderAvailabilityFor("codex", noKeys, noKeys, cli), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("pi", noKeys, noKeys, cli), noKeys);
});

test("the keyless-credential predicate reads the claude child env, whatever the deployment harness is", () => {
  const base = { claudeProcessEnv: {} } as unknown as Parameters<typeof claudeCliKeylessCredential>[0];
  assert.equal(claudeCliKeylessCredential(base), false);
  assert.equal(claudeCliKeylessCredential({ ...base, claudeProcessEnv: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }), true);
  assert.equal(claudeCliKeylessCredential({ ...base, claudeProcessEnv: { ANTHROPIC_AUTH_TOKEN: "tok" } }), true);
  assert.equal(claudeCliKeylessCredential({ ...base, claudeProcessEnv: { CLAUDE_CODE_OAUTH_TOKEN: "  " } }), false);
  assert.equal(
    claudeCliKeylessCredential({ ...base, harness: "pi", claudeProcessEnv: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }),
    true,
    "the credential is a fact about the child env, not about the deployment default harness",
  );
});

test("providerKeysPresent reports api keys only, and trims every arm", () => {
  const base = { claudeProcessEnv: {} } as unknown as Parameters<typeof providerKeysPresent>[0];
  assert.deepEqual(providerKeysPresent(base), { anthropic: false, openai: false, openrouter: false });
  assert.equal(providerKeysPresent({ ...base, anthropicApiKey: "sk-ant-key" }).anthropic, true);
  assert.equal(providerKeysPresent({ ...base, anthropicApiKey: "   " }).anthropic, false);
  assert.equal(providerKeysPresent({ ...base, openaiApiKey: "   " }).openai, false);
  assert.equal(providerKeysPresent({ ...base, openrouterApiKey: "   " }).openrouter, false);
  assert.equal(
    providerKeysPresent({ ...base, claudeProcessEnv: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }).anthropic,
    false,
    "a CLI credential is not an api key and must not ride the provider vector",
  );
});

test("env -> config -> claude child env carries the subscription token end to end", () => {
  const config = loadConfig({
    HARNESS: "claude",
    ORG_ID: "acme",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-live",
  });
  assert.equal(config.claudeProcessEnv.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-live");
  assert.equal(claudeCliKeylessCredential(config), true);
  assert.equal(providerKeysPresent(config).anthropic, false);
  const childEnv = claudeChildEnv(config.claudeProcessEnv, "/tmp/jail-fixture");
  assert.equal(
    childEnv.CLAUDE_CODE_OAUTH_TOKEN,
    "sk-ant-oat01-live",
    "dropping the token from either allowlist must fail a test, not fail silently at runtime",
  );
  assert.equal(childEnv.HOME, "/tmp/jail-fixture");
  assert.deepEqual(
    modelProviderAvailabilityFor("claude", providerKeysPresent(config), undefined, {
      claude: claudeCliKeylessCredential(config),
    }),
    { anthropic: true, openai: false, openrouter: false },
  );
});

test("web-turn gate refuses a keyless model cleanly, accepts it once the provider is configured", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  const refused = validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, noOpenai);
  assert.match(refused ?? "", /provider isn't configured/);
  assert.equal(
    validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, { anthropic: true, openai: true, openrouter: false }),
    null,
  );
});

test("fast-mode support is registry-driven", () => {
  assert.equal(modelSupportsFastMode("claude-opus-4-8"), true);
  assert.equal(modelSupportsFastMode("gpt-5.6-sol"), false);
  assert.equal(modelSupportsFastMode(undefined), false);
  assert.equal(modelSupportsFastMode("nonexistent-model"), false);
});
