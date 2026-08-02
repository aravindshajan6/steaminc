/**
 * MongoDB-backed storage, exposing the same surface as the JSON-file Store in auth.js
 * so server.js never learns which one it is talking to.
 *
 * This exists because a platform without a persistent disk — Render's free plan, for
 * one — wipes the JSON file on every restart, taking every account with it. An
 * external database is the only way state outlives the container there.
 *
 * The driver is imported dynamically, so `mongodb` is only ever required when
 * MONGODB_URI is set. Without it the app still runs with no npm install at all.
 */

import {
  newCredential, verifyPassword, newSessionToken, shapeUser, SESSION_TTL_MS,
} from "./auth.js";

export class MongoStore {
  constructor(uri, dbName = "steaminc") {
    this.uri = uri;
    this.dbName = dbName;
  }

  async load() {
    let MongoClient;
    try {
      ({ MongoClient } = await import("mongodb"));
    } catch {
      throw new Error(
        "MONGODB_URI is set but the 'mongodb' driver is not installed. Run `npm install` in backend/, or unset MONGODB_URI to use file storage.",
      );
    }

    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: 10000,
      // Atlas free clusters cap total connections; a small pool is plenty for this app
      // and leaves room for other clients.
      maxPoolSize: 10,
    });
    await this.client.connect();

    this.db = this.client.db(this.dbName);
    this.users = this.db.collection("users");
    this.sessions = this.db.collection("sessions");
    this.comments = this.db.collection("comments");

    // Unique index does what the file store could not: make "one account per email"
    // a guarantee instead of a check-then-write race between two concurrent signups.
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.users.createIndex({ id: 1 }, { unique: true });

    // TTL index — Mongo deletes expired sessions on its own, so there is no sweep
    // to run and no way to forget to run it. Requires `expires` to be a Date.
    await this.sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    await this.sessions.createIndex({ token: 1 }, { unique: true });

    // Comments are always read as "everything for one title, newest first",
    // so index exactly that rather than the two fields separately.
    await this.comments.createIndex({ target: 1, created: -1 });
    await this.comments.createIndex({ id: 1 }, { unique: true });
  }

  async close() {
    await this.client?.close();
  }

  async count() {
    return this.users.countDocuments();
  }

  async userById(id) {
    return this.users.findOne({ id }, { projection: { _id: 0 } });
  }

  async userByEmail(email) {
    return this.users.findOne(
      { email: String(email || "").trim().toLowerCase() },
      { projection: { _id: 0 } },
    );
  }

  async createUser({ email, password, name }) {
    const user = shapeUser({ email, name, ...(await newCredential(password)) });
    try {
      await this.users.insertOne({ ...user });
    } catch (err) {
      // 11000 = duplicate key. Two signups raced; the loser gets the normal message.
      if (err?.code === 11000) {
        throw Object.assign(new Error("An account with that email already exists."), { status: 409 });
      }
      throw err;
    }
    return user;
  }

  async verify(user, password) {
    return verifyPassword(user, password);
  }

  async startSession(userId) {
    const token = newSessionToken();
    await this.sessions.insertOne({
      token,
      userId,
      expires: new Date(Date.now() + SESSION_TTL_MS),
    });
    return token;
  }

  async sessionUser(token) {
    if (!token) return null;
    const s = await this.sessions.findOne({ token });
    if (!s) return null;
    // TTL cleanup runs about once a minute, so an expired doc can still be present.
    // Check the date rather than trusting the index to have caught up.
    if (s.expires.getTime() < Date.now()) {
      await this.sessions.deleteOne({ token });
      return null;
    }
    return this.userById(s.userId);
  }

  async endSession(token) {
    if (token) await this.sessions.deleteOne({ token });
  }

  /* -------------------------------------------------------------- comments -- */

  async listComments(target, limit = 100) {
    return this.comments
      .find({ target }, { projection: { _id: 0 } })
      .sort({ created: -1 })
      .limit(limit)
      .toArray();
  }

  async addComment(comment) {
    await this.comments.insertOne({ ...comment });
    return comment;
  }

  async deleteComment(id, userId) {
    // userId in the filter IS the authorization check — a user can only ever
    // delete their own comment, enforced by the query rather than by a branch.
    const res = await this.comments.deleteOne({ id, userId });
    return res.deletedCount > 0;
  }

  async countComments(userId) {
    return this.comments.countDocuments({ userId });
  }

  async rename(userId, name) {
    await this.users.updateOne({ id: userId }, { $set: { name } });
    return this.userById(userId);
  }

  async deleteUser(userId) {
    await this.users.deleteOne({ id: userId });
    // Every session, not just the current one — a deleted account must not stay
    // signed in on some other device.
    await this.sessions.deleteMany({ userId });
  }

  async setList(userId, list) {
    const capped = list.slice(0, 500);
    const res = await this.users.findOneAndUpdate(
      { id: userId },
      { $set: { list: capped } },
      { returnDocument: "after", projection: { _id: 0, list: 1 } },
    );
    return res?.list ?? (res?.value?.list ?? capped);
  }
}
