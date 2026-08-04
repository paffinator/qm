const CHILD_PROCESS_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
] as const;

export const CLAUDE_KEYLESS_CREDENTIAL_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const;

export const CLAUDE_ENV_PASSTHROUGH = [
  ...CHILD_PROCESS_ENV_PASSTHROUGH,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  ...CLAUDE_KEYLESS_CREDENTIAL_ENV,
] as const;

export function claudeKeylessCredentialInEnv(env: NodeJS.ProcessEnv): boolean {
  return CLAUDE_KEYLESS_CREDENTIAL_ENV.some((name) => Boolean(env[name]?.trim()));
}
