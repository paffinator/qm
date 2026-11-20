import { readFileSync } from "node:fs";

export const CODEX_AUTH_FILE_ENV = "CODEX_AUTH_FILE";

export function codexKeylessCredentialInEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[CODEX_AUTH_FILE_ENV]?.trim());
}

export interface CodexChatgptCredential {
  contents: string;
}

export function readCodexChatgptCredential(path: string): CodexChatgptCredential {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `${CODEX_AUTH_FILE_ENV}=${path} could not be read — run "codex login" and point it at the resulting auth.json`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CODEX_AUTH_FILE_ENV}=${path} is not valid JSON — expected a codex auth.json`);
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const tokens =
    typeof record.tokens === "object" && record.tokens !== null ? (record.tokens as Record<string, unknown>) : {};
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error(
      `${CODEX_AUTH_FILE_ENV}=${path} carries no ChatGPT tokens — run "codex login" to sign in with your subscription`,
    );
  }
  return { contents: raw };
}
