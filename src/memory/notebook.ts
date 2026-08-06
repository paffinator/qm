export const RECALL_MAX_CHARS = 6_000;

export function isBullet(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("- ") || t.startsWith("* ");
}

export function bulletText(line: string): string {
  return line
    .trimStart()
    .replace(/^[-*]\s*/, "")
    .trim();
}

export function captureDate(text: string): string | undefined {
  return /^\((\d{4}-\d\d-\d\d)\)/.exec(text)?.[1];
}

export function bullets(body: string): string[] {
  return body.split("\n").filter(isBullet).map(bulletText);
}

const SOURCE_ASIDE = /^said in\b/i;
const PROVENANCE_ASIDE = /^(?:stated|told|claimed|reported|mentioned|per|source|according)\b|\d{4}-\d\d-\d\d/i;

function withoutProvenanceAsides(text: string): string {
  let out = text;
  for (;;) {
    const aside = /\(([^()]*)\)$/.exec(out);
    if (!aside) return out;
    const inner = aside[1]!.trim();
    if (SOURCE_ASIDE.test(inner) || !PROVENANCE_ASIDE.test(inner)) return out;
    out = out.slice(0, aside.index).trim();
  }
}

export function normalize(line: string): string {
  return withoutProvenanceAsides(
    line
      .replace(/^[-*]\s*/, "")
      .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, "")
      .trim(),
  ).toLowerCase();
}

export function dateStr(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function capTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
