/**
 * The file-backed store: accounts, sessions, watchlists and comments.
 *
 * Runs against a throwaway file per test, so it needs no database and leaves
 * nothing behind. The Mongo store implements the same interface — these tests
 * describe the contract both are held to.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store, SESSION_TTL_MS } from "../auth.js";

const dirs = [];
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "steaminc-test-"));
  dirs.push(dir);
  const store = new Store(join(dir, "accounts.json"));
  await store.load();
  return store;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop(), { recursive: true, force: true });
});

describe("accounts", () => {
  test("creates a user and finds them by email, case-insensitively", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "Sam@Example.com", password: "letters123!", name: "Sam" });
    assert.equal(u.email, "sam@example.com");
    assert.ok(await s.userByEmail("SAM@EXAMPLE.COM"));
    assert.ok(await s.userById(u.id));
    assert.equal(await s.count(), 1);
  });

  test("stores no plaintext password anywhere in the file", async () => {
    const s = await freshStore();
    await s.createUser({ email: "a@b.com", password: "correct-horse!", name: "A" });
    assert.ok(!JSON.stringify(s.data).includes("correct-horse"));
  });

  test("verifies the right password and rejects the wrong one", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    assert.equal(await s.verify(u, "letters123!"), true);
    assert.equal(await s.verify(u, "letters124!"), false);
  });

  test("renaming keeps the same id and credentials", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!", name: "Old" });
    const renamed = await s.rename(u.id, "New");
    assert.equal(renamed.name, "New");
    assert.equal(renamed.id, u.id);
    assert.equal(await s.verify(renamed, "letters123!"), true);
  });

  test("state survives a reload from disk", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const reopened = new Store(s.file);
    await reopened.load();
    assert.equal(await reopened.count(), 1);
    assert.equal((await reopened.userById(u.id)).email, "a@b.com");
  });
});

describe("sessions", () => {
  test("a started session resolves back to its user", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const token = await s.startSession(u.id);
    assert.equal((await s.sessionUser(token)).id, u.id);
  });

  test("unknown, empty and expired tokens all resolve to nobody", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    assert.equal(await s.sessionUser("made-up"), null);
    assert.equal(await s.sessionUser(""), null);
    assert.equal(await s.sessionUser(null), null);

    const token = await s.startSession(u.id);
    s.data.sessions[token].expires = Date.now() - 1; // travel past the expiry
    assert.equal(await s.sessionUser(token), null);
    assert.equal(s.data.sessions[token], undefined, "an expired session should be dropped");
  });

  test("signing out invalidates only that session", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const phone = await s.startSession(u.id);
    const laptop = await s.startSession(u.id);
    await s.endSession(phone);
    assert.equal(await s.sessionUser(phone), null);
    assert.ok(await s.sessionUser(laptop), "other devices should stay signed in");
  });

  test("deleting an account clears every session it had", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const phone = await s.startSession(u.id);
    const laptop = await s.startSession(u.id);
    await s.deleteUser(u.id);
    assert.equal(await s.sessionUser(phone), null);
    assert.equal(await s.sessionUser(laptop), null, "a deleted account must not stay signed in anywhere");
    assert.equal(await s.count(), 0);
  });

  test("new sessions expire roughly 30 days out", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const token = await s.startSession(u.id);
    const drift = Math.abs(s.data.sessions[token].expires - (Date.now() + SESSION_TTL_MS));
    assert.ok(drift < 5000, `expiry drifted by ${drift}ms`);
  });
});

describe("watchlist", () => {
  test("saves and reads back a list", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const list = [{ id: 1, media: "movie", title: "T", poster: null, year: "2020", score: 70 }];
    assert.deepEqual(await s.setList(u.id, list), list);
    assert.deepEqual((await s.userById(u.id)).list, list);
  });

  test("caps at 500 entries", async () => {
    const s = await freshStore();
    const u = await s.createUser({ email: "a@b.com", password: "letters123!" });
    const huge = Array.from({ length: 900 }, (_, i) => ({ id: i, media: "movie" }));
    assert.equal((await s.setList(u.id, huge)).length, 500);
  });
});

describe("comments", () => {
  const mk = (over = {}) => ({
    id: `c-${Math.random()}`,
    target: "movie:1",
    userId: "u1",
    userName: "Critic",
    body: "Good.",
    created: new Date().toISOString(),
    ...over,
  });

  test("lists only the comments for the given title, newest first", async () => {
    const s = await freshStore();
    await s.addComment(mk({ body: "older", created: "2020-01-01T00:00:00Z" }));
    await s.addComment(mk({ body: "newer", created: "2024-01-01T00:00:00Z" }));
    await s.addComment(mk({ target: "movie:999", body: "other title" }));

    const got = await s.listComments("movie:1");
    assert.equal(got.length, 2);
    assert.equal(got[0].body, "newer");
  });

  test("a user cannot delete someone else's comment", async () => {
    const s = await freshStore();
    const c = mk({ id: "target", userId: "owner" });
    await s.addComment(c);

    assert.equal(await s.deleteComment("target", "attacker"), false, "deletion should be refused");
    assert.equal((await s.listComments("movie:1")).length, 1, "the comment must survive");

    assert.equal(await s.deleteComment("target", "owner"), true);
    assert.equal((await s.listComments("movie:1")).length, 0);
  });

  test("deleting something that does not exist reports false rather than throwing", async () => {
    const s = await freshStore();
    assert.equal(await s.deleteComment("nope", "u1"), false);
  });

  test("counts a user's own comments", async () => {
    const s = await freshStore();
    await s.addComment(mk({ userId: "u1" }));
    await s.addComment(mk({ userId: "u1" }));
    await s.addComment(mk({ userId: "u2" }));
    assert.equal(await s.countComments("u1"), 2);
  });
});
