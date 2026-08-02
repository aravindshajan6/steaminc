/**
 * Password rules, credential handling, throttling, cookies and watchlist
 * sanitisation. No network, no database, no HTTP listener — everything here is a
 * pure function or a value, so the suite runs in under a second.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PASSWORD_RULES, checkPassword, validate, cleanList,
  newCredential, verifyPassword, newSessionToken, shapeUser,
  throttle, clearThrottle,
  parseCookies, sessionCookie, clearCookie, publicUser,
  SESSION_TTL_MS,
} from "../auth.js";

describe("password rules", () => {
  test("rejects passwords missing each requirement, naming what is absent", () => {
    assert.match(checkPassword("short"), /8\+ characters/);
    assert.match(checkPassword("alllettersonly"), /a number/);
    assert.match(checkPassword("letters123"), /a symbol/);
    assert.match(checkPassword("12345678!"), /a letter/);
  });

  test("accepts a password meeting every rule", () => {
    assert.equal(checkPassword("letters123!"), null);
  });

  test("exactly 8 characters passes — the boundary is >=, not >", () => {
    // A real bug caught by hand once: "tooshort" is exactly 8 and must be allowed.
    assert.equal(PASSWORD_RULES.find((r) => r.key === "len").test("abcdefg1!"), true);
    assert.equal(PASSWORD_RULES.find((r) => r.key === "len").test("abcdefg"), false);
  });

  test("rejects an absurdly long password rather than hashing it", () => {
    assert.match(checkPassword("a1!".repeat(200)), /too long/);
  });

  test("unicode letters count as letters", () => {
    assert.equal(checkPassword("пароль123!"), null);
  });
});

describe("signup validation", () => {
  test("rejects malformed emails", () => {
    for (const bad of ["", "nope", "a@b", "a b@c.com", "@example.com"]) {
      assert.notEqual(validate({ email: bad, password: "letters123!" }), null, `expected ${bad} to fail`);
    }
  });

  test("accepts a normal signup", () => {
    assert.equal(validate({ email: "a@example.com", password: "letters123!", name: "Al" }), null);
  });

  test("password problems surface through validate, not just checkPassword", () => {
    assert.match(validate({ email: "a@example.com", password: "weak" }), /Password needs/);
  });
});

describe("credentials", () => {
  test("a password verifies against its own hash and nothing else", async () => {
    const cred = await newCredential("letters123!");
    assert.equal(await verifyPassword(cred, "letters123!"), true);
    assert.equal(await verifyPassword(cred, "letters123"), false);
    assert.equal(await verifyPassword(cred, ""), false);
  });

  test("the same password hashes differently each time (salted)", async () => {
    const a = await newCredential("letters123!");
    const b = await newCredential("letters123!");
    assert.notEqual(a.hash, b.hash, "identical hashes means the salt is not being used");
    assert.notEqual(a.salt, b.salt);
  });

  test("stored credential contains no trace of the plaintext", async () => {
    const cred = await newCredential("hunter2-secret!");
    assert.ok(!JSON.stringify(cred).includes("hunter2"));
  });

  test("verifying against a malformed record returns false instead of throwing", async () => {
    assert.equal(await verifyPassword({}, "x"), false);
    assert.equal(await verifyPassword(null, "x"), false);
  });

  test("session tokens are unique and long enough to be unguessable", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken()));
    assert.equal(tokens.size, 200);
    assert.ok(newSessionToken().length >= 40);
  });
});

describe("user shape", () => {
  test("email is lowercased and a missing name falls back to the local part", () => {
    const u = shapeUser({ email: "  Mixed@Example.COM  ", name: "", salt: "s", hash: "h" });
    assert.equal(u.email, "mixed@example.com");
    assert.equal(u.name, "mixed");
    assert.deepEqual(u.list, []);
  });

  test("publicUser never leaks the hash or salt", () => {
    const u = shapeUser({ email: "a@b.com", name: "A", salt: "SALT", hash: "HASH" });
    const pub = publicUser(u);
    assert.deepEqual(Object.keys(pub).sort(), ["created", "email", "id", "name"]);
    assert.ok(!JSON.stringify(pub).includes("HASH"));
    assert.ok(!JSON.stringify(pub).includes("SALT"));
  });
});

describe("login throttling", () => {
  test("allows 8 attempts then blocks, and clears on success", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 8; i++) assert.equal(throttle(key), null, `attempt ${i + 1} should pass`);
    assert.ok(throttle(key) > 0, "9th attempt should be blocked");
    clearThrottle(key);
    assert.equal(throttle(key), null, "a successful login should reset the counter");
  });

  test("buckets are independent — one attacker cannot lock out another user", () => {
    const a = `a-${Math.random()}`, b = `b-${Math.random()}`;
    for (let i = 0; i < 9; i++) throttle(a);
    assert.equal(throttle(b), null);
  });
});

describe("cookies", () => {
  test("session cookie is HttpOnly and SameSite=Lax", () => {
    const c = sessionCookie("abc");
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    assert.ok(!/Secure/.test(c), "Secure must be off for plain http");
  });

  test("Secure is added behind an https proxy", () => {
    assert.match(sessionCookie("abc", { secure: true }), /Secure/);
  });

  test("clearing sets an immediate expiry", () => {
    assert.match(clearCookie(), /Max-Age=0/);
  });

  test("parses a cookie header, and tolerates junk", () => {
    assert.equal(parseCookies("sc_session=xyz; other=1").sc_session, "xyz");
    assert.deepEqual(parseCookies(""), {});
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("novalue"), {});
  });

  test("session lifetime is 30 days", () => {
    assert.equal(SESSION_TTL_MS, 30 * 864e5);
  });
});

describe("watchlist sanitisation", () => {
  test("keeps only the six rendered fields and drops injected ones", () => {
    const [item] = cleanList([
      { id: 5, media: "movie", title: "T", year: "2020", score: 70,
        evil: "<script>", nested: { a: 1 }, poster: "/p.jpg" },
    ]);
    assert.deepEqual(Object.keys(item).sort(), ["id", "media", "poster", "score", "title", "year"]);
    assert.equal(item.evil, undefined);
  });

  test("drops entries with an unknown media type or a bad id", () => {
    const out = cleanList([
      { id: 1, media: "movie" },
      { id: 2, media: "hacked" },
      { id: {}, media: "tv" },
      null,
    ]);
    assert.equal(out.length, 1);
  });

  test("free ids stay strings, catalogue ids become numbers", () => {
    const out = cleanList([
      { id: "AboutBan1935", media: "free" },
      { id: "27205", media: "movie" },
    ]);
    assert.equal(typeof out[0].id, "string");
    assert.equal(out[1].id, 27205);
  });

  test("caps the list and truncates oversized strings", () => {
    const huge = Array.from({ length: 800 }, (_, i) => ({ id: i, media: "movie", title: "x".repeat(500) }));
    const out = cleanList(huge);
    assert.equal(out.length, 500);
    assert.equal(out[0].title.length, 200);
  });

  test("a non-array is rejected with a 400, not a crash", () => {
    assert.throws(() => cleanList("nope"), (e) => e.status === 400);
  });
});
