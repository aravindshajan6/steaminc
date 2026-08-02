/**
 * Picks a storage backend. Set MONGODB_URI to use Mongo; otherwise state goes to a
 * JSON file under DATA_DIR.
 *
 * The file store is the right default: it needs no install, no service and no
 * network, which keeps `npm start` on a fresh clone genuinely dependency-free.
 * Mongo is what you switch to when the filesystem is not durable — a container
 * platform with no persistent disk — or when more than one instance needs to share
 * the same accounts.
 */

import { join } from "node:path";
import { Store as FileStore } from "./auth.js";
import { MongoStore } from "./mongo-store.js";

export function createStore({ mongoUri, dataDir, dbName }) {
  if (mongoUri) {
    return { store: new MongoStore(mongoUri, dbName), kind: "mongodb" };
  }
  return { store: new FileStore(join(dataDir, "accounts.json")), kind: "file" };
}
