/**
 * The copyright-era gate on the free-copy cross-match.
 *
 * Every case here returns before any network call, so the suite stays offline
 * and deterministic. This is the highest-consequence logic in the app: a false
 * positive tells someone a licensed film is free to watch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { archiveMatch } from "../archive.js";

describe("free-copy cross-match gate", () => {
  test("refuses anything released after the public-domain cutoff", async () => {
    // The trap this exists for: the Archive's Nosferatu item carries no year, so
    // without the gate the 2024 remake would match the 1922 print and be
    // advertised as free.
    assert.equal(await archiveMatch("Nosferatu", "2024"), null);
    assert.equal(await archiveMatch("Dune", "2021"), null);
    assert.equal(await archiveMatch("Oppenheimer", "2023"), null);
    assert.equal(await archiveMatch("Anything", "1971"), null);
  });

  test("refuses when no year is known — an unknown date is not an old one", async () => {
    assert.equal(await archiveMatch("Some Film", ""), null);
    assert.equal(await archiveMatch("Some Film", null), null);
    assert.equal(await archiveMatch("Some Film", undefined), null);
  });

  test("refuses titles too short to match on", async () => {
    assert.equal(await archiveMatch("A", "1940"), null);
    assert.equal(await archiveMatch("", "1940"), null);
  });

  test("TV is never cross-matched — only movies reach this path", async () => {
    // Guarded at the call site in server.js; asserted here so a future refactor
    // that starts passing series through is noticed.
    assert.equal(await archiveMatch("", "1968"), null);
  });
});
