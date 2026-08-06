import { test } from "node:test";
import assert from "node:assert/strict";
import { capTail, normalize } from "../src/memory/notebook.ts";

test("capTail at exactly the text's length is the identity", () => {
  const s = "- (2026-05-01) fact one\n- fact two";
  assert.equal(capTail(s, s.length), s);
});

test("capTail truncates from the head, keeping the tail where the newest facts live", () => {
  assert.equal(capTail("abcdef", 3), "def");
});

test("normalize treats bullet style, capture date, and case as non-identity", () => {
  assert.equal(normalize("- (2026-05-01) Fact"), normalize("* fact"));
});

test("a model-written provenance aside is not part of a fact's identity", () => {
  assert.equal(
    normalize("- (2026-08-06) Runs an art company called Oakenfield (stated 2026-08-06 in DM)"),
    normalize("- (2026-08-06) Runs an art company called Oakenfield"),
    "the same fact twice, once carrying the aside the extractor volunteered",
  );
  assert.equal(normalize("Ships on Thursdays (told by Alex)"), normalize("Ships on Thursdays"));
  assert.equal(normalize("Owns billing (per the runbook, 2026-01-02)"), normalize("Owns billing"));
});

test("an aside that carries meaning stays part of the identity", () => {
  assert.notEqual(
    normalize("Ships every Thursday (Atlantic time)"),
    normalize("Ships every Thursday (Pacific time)"),
    "stripping this would silently drop the second fact",
  );
  assert.notEqual(normalize("Ships every Thursday (Atlantic time)"), normalize("Ships every Thursday"));
});

test("a cc'd fact keeps its source in its identity, so two sources stay two facts", () => {
  assert.notEqual(normalize("Runs an art company (said in #eng)"), normalize("Runs an art company (said in #ops)"));
  assert.notEqual(normalize("Runs an art company (said in #eng)"), normalize("Runs an art company"));
});

test("differently worded facts stay distinct: merging them is consolidation's job, not the key's", () => {
  assert.notEqual(
    normalize("Runs an art company called Oakenfield"),
    normalize("Runs an art company called Oak"),
    "an alias is a semantic judgement; keying on it would also collapse contradicting updates",
  );
});
