/**
 * Accounts, sessions and the per-user watchlist.
 *
 * Zero dependencies: scrypt and randomBytes come from node:crypto, and storage is a
 * JSON file. That is appropriate for a local single-process app and explicitly not
 * for a real deployment — see the notes in the README before putting this on a network.
 */

import { randomBytes, scrypt, timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

const hash = (password, salt) =>
  new Promise((res, rej) =>
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, key) =>
      e ? rej(e) : res(key),
    ),
  );

/* ------------------------------------------------- shared password helpers --- */
/* Exported so every storage backend hashes and compares identically. The rules
   for handling a password should not depend on where the row happens to live.  */

export const SESSION_TTL_MS = SESSION_DAYS * 864e5;

export async function newCredential(password) {
  const salt = randomBytes(16);
  const key = await hash(password, salt);
  return { salt: salt.toString("hex"), hash: key.toString("hex") };
}

export async function verifyPassword(record, password) {
  if (!record?.salt || !record?.hash) return false;
  const key = await hash(password, Buffer.from(record.salt, "hex"));
  const known = Buffer.from(record.hash, "hex");
  // Lengths always match here, but timingSafeEqual throws if they ever differ.
  return key.length === known.length && timingSafeEqual(key, known);
}

export const newSessionToken = () => randomBytes(32).toString("base64url");

export const newUserId = () => randomUUID();

export function shapeUser({ email, name, salt, hash: pwHash }) {
  const e = String(email).trim().toLowerCase();
  return {
    id: newUserId(),
    email: e,
    name: String(name || "").trim().slice(0, 60) || e.split("@")[0],
    salt,
    hash: pwHash,
    created: new Date().toISOString(),
    list: [],
  };
}

/* ---------------------------------------------------------------- store --- */

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: [], sessions: {} };
    this.queue = Promise.resolve();
  }

  async load() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      return this.save();
    }
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
      this.data.users ||= [];
      this.data.sessions ||= {};
      this.sweep();
    } catch (err) {
      console.warn("[auth] could not read store, starting empty:", err.message);
    }
  }

  // Serialized writes through a promise chain — two concurrent requests mutating the
  // same file would otherwise interleave read/modify/write and drop one of the changes.
  save() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.file); // atomic swap, never a half-written file
    }).catch((err) => console.error("[auth] save failed:", err.message));
    return this.queue;
  }

  sweep() {
    const now = Date.now();
    let dropped = 0;
    for (const [token, s] of Object.entries(this.data.sessions)) {
      if (s.expires < now) {
        delete this.data.sessions[token];
        dropped++;
      }
    }
    if (dropped) this.save();
  }

  userById(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }

  userByEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    return this.data.users.find((u) => u.email === e) || null;
  }

  async count() {
    return this.data.users.length;
  }

  async createUser({ email, password, name }) {
    const cred = await newCredential(password);
    const user = shapeUser({ email, name, ...cred });
    this.data.users.push(user);
    await this.save();
    return user;
  }

  async verify(user, password) {
    return verifyPassword(user, password);
  }

  async startSession(userId) {
    const token = newSessionToken();
    this.data.sessions[token] = { userId, expires: Date.now() + SESSION_TTL_MS };
    await this.save();
    return token;
  }

  async sessionUser(token) {
    if (!token) return null;
    const s = this.data.sessions[token];
    if (!s) return null;
    if (s.expires < Date.now()) {
      delete this.data.sessions[token];
      this.save();
      return null;
    }
    return this.userById(s.userId);
  }

  async endSession(token) {
    if (token && this.data.sessions[token]) {
      delete this.data.sessions[token];
      await this.save();
    }
  }

  async setList(userId, list) {
    const user = this.userById(userId);
    if (!user) return null;
    user.list = list.slice(0, 500);
    await this.save();
    return user.list;
  }

  async rename(userId, name) {
    const user = this.userById(userId);
    if (!user) return null;
    user.name = name;
    await this.save();
    return user;
  }

  async deleteUser(userId) {
    this.data.users = this.data.users.filter((u) => u.id !== userId);
    // Drop every session for that user, not just the current one — a deleted
    // account must not stay signed in on another device.
    for (const [token, s] of Object.entries(this.data.sessions)) {
      if (s.userId === userId) delete this.data.sessions[token];
    }
    await this.save();
  }
}

/* ------------------------------------------------------------ validation --- */

// Intentionally loose. The only authority on whether an address works is whether
// mail reaches it, and this app never sends any.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Composition rules live here, next to the hashing, so the server is the authority.
// The signup form checks the same rules live, but that is a courtesy to the user —
// anything posting straight to the API is held to exactly this.
export const PASSWORD_RULES = [
  { key: "len", label: `${MIN_PASSWORD}+ characters`, test: (p) => p.length >= MIN_PASSWORD },
  { key: "alpha", label: "a letter", test: (p) => /\p{L}/u.test(p) },
  { key: "num", label: "a number", test: (p) => /\d/.test(p) },
  { key: "special", label: "a symbol", test: (p) => /[^\p{L}\d]/u.test(p) },
];

export function checkPassword(password) {
  const p = String(password || "");
  if (p.length > 200) return "That password is too long.";
  const failed = PASSWORD_RULES.filter((r) => !r.test(p));
  if (!failed.length) return null;
  return `Password needs ${failed.map((r) => r.label).join(", ")}.`;
}

export function validate({ email, password, name }) {
  const e = String(email || "").trim();
  if (!EMAIL.test(e)) return "That does not look like an email address.";
  if (e.length > 190) return "That email is too long.";
  const pw = checkPassword(password);
  if (pw) return pw;
  if (name && String(name).length > 60) return "That name is too long.";
  return null;
}

/* ---------------------------------------------------------- rate limiting --- */

const attempts = new Map();
const WINDOW = 15 * 60e3;
const MAX_ATTEMPTS = 8;

export function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW });
    return null;
  }
  rec.count++;
  if (rec.count > MAX_ATTEMPTS) {
    return Math.ceil((rec.resetAt - now) / 60e3);
  }
  return null;
}

export function clearThrottle(key) {
  attempts.delete(key);
}

/* --------------------------------------------------------------- cookies --- */

export const COOKIE = "sc_session";

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure = false } = {}) {
  const bits = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly", // unreachable from JS, so an XSS bug cannot exfiltrate the session
    "SameSite=Lax", // blocks the cross-site POST shape of CSRF
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const publicUser = (u) =>
  u ? { id: u.id, email: u.email, name: u.name, created: u.created || null } : null;

export { join as joinPath };
