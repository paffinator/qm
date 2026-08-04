export const RESERVED_APP_ENV = ["PORT", "HOME", "DATA_DIR"] as const;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = new Set<string>(RESERVED_APP_ENV);

export function isDeployEnvKey(key: string): boolean {
  return KEY_RE.test(key) && !reserved.has(key);
}

export function deployEnvKeyError(key: string): string {
  if (reserved.has(key)) return `env key "${key}" is set by the runtime and cannot be overridden`;
  return `invalid env key "${key}": use letters, digits and underscores, not starting with a digit`;
}

export function isDeployEnvValue(value: string): boolean {
  return !value.includes("\0");
}

export function deployEnvEntries(
  ...envs: Array<Record<string, string> | undefined>
): Array<[string, string]> {
  const merged: Record<string, string> = {};
  for (const env of envs) {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (isDeployEnvKey(key) && isDeployEnvValue(value)) merged[key] = value;
    }
  }
  return Object.entries(merged);
}
