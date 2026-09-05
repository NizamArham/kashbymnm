import Database from "better-sqlite3";
import path from "path";

// Single SQLite file — this IS the database. No server, no hosting, no cost.
// Lives at server/data/mm-clothing.db. Back it up by copying this one file.
const DB_PATH = path.join(__dirname, "..", "..", "data", "mm-clothing.db");

export const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL"); // better concurrent read/write behavior

export default db;
