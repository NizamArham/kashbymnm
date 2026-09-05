import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Single SQLite file — this IS the database. No server, no hosting, no cost.
// Lives at server/data/mm-clothing.db. Back it up by copying this one file.
const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "mm-clothing.db");

export const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL"); // better concurrent read/write behavior

export default db;
