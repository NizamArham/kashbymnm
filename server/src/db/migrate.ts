import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "mm-clothing.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const schemaPath = path.join(__dirname, "schema.sql");
const schemaSql = fs.readFileSync(schemaPath, "utf-8");

db.exec(schemaSql);

console.log(`Database ready at ${DB_PATH}`);
console.log("All tables created (or already existed). Safe to run again anytime.");

db.close();
