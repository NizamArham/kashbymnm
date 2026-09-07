import bcrypt from "bcryptjs";
import { db } from "./connection";

// Bootstraps the very first login. Without this, nobody could create an
// account, since creating a user requires already being logged in as admin.
// Safe to run multiple times — it won't duplicate the admin if one exists.

const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "changeme123"; // CHANGE THIS after first login

const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(DEFAULT_USERNAME);

if (existing) {
  console.log(`Admin user "${DEFAULT_USERNAME}" already exists — nothing to do.`);
} else {
  const password_hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, 'admin', 'Nizam Arham')`
  ).run(DEFAULT_USERNAME, password_hash);

  console.log("First admin account created:");
  console.log(`  username: ${DEFAULT_USERNAME}`);
  console.log(`  password: ${DEFAULT_PASSWORD}`);
  console.log("");
  console.log("IMPORTANT: log in and change this password (or create your own");
  console.log("admin account and delete this one) before using the system for real.");
}
