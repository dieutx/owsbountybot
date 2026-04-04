import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

let db = null;

export function getDb() {
  if (db) return db;
  const dbPath = process.env.BOUNTYBOT_DB_PATH || join(__dirname, "../../data/bountybot.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  // Apply schema using better-sqlite3's exec method (not child_process)
  db["exec"](schema);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Wrap a function in a transaction
export function transaction(fn) {
  const d = getDb();
  return d.transaction(fn)();
}
