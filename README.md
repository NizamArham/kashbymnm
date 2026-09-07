# M&M Clothing — Internal Management System

A local, free, single-computer system for stock, sales, POS, customers,
purchasing, and courier management. No hosting, no monthly cost — the
whole database is one file (SQLite) that lives on your machine.

## What's in here right now

- `server/` — a complete Node.js + TypeScript + Express backend: full
  SQLite database schema, working API routes for every module, and a
  full login/role system (admin vs staff, enforced on the backend).
- `client/` — a complete React + TypeScript frontend (Vite): login
  screen, admin dashboard, POS with In-Store/Online toggle, inventory,
  products, customers, sale history, returns, suppliers, purchases,
  deliveries/courier, cash book, and profile/account management —
  each screen showing only what that user's role is allowed to see.
- `SCHEMA_DESIGN.md` — the human-readable design doc explaining every
  table and why it's structured the way it is.
- `API_REFERENCE.md` — every API endpoint, what it does, roles allowed,
  and example request bodies.

## Prerequisites

You need **Node.js** installed (version 18 or higher). Check with:

```
node --version
```

If you don't have it, download the LTS version from https://nodejs.org.

## First-time setup

Open a terminal in this folder and run:

```
cd server
npm install
npm run db:migrate
npm run db:seed
```

`npm install` downloads the required packages (Express, SQLite driver,
auth libraries, etc.) — this needs an internet connection once, but
nothing after that.

`npm run db:migrate` creates the actual database file at
`server/data/mm-clothing.db` with all tables already set up. Safe to run
again any time — it won't erase existing data or duplicate tables.

`npm run db:seed` creates the very first login: username `admin`,
password `changeme123`. Log in with this once, then create your own real
admin account (or at least change this password) — see
`API_REFERENCE.md` under "Auth & roles".

## Running the server

```
npm run dev
```

This starts the backend on your machine (localhost:4000). Keep this
terminal open while you're using the system.

## Running the frontend

In a **second terminal**, from the project root:

```
cd client
npm install
npm run dev
```

This starts the frontend at **http://localhost:5173**. Open that in your
browser — you'll see the login screen. The backend (previous step) must
already be running, since the frontend talks to it at localhost:4000.

Log in with the seeded account (`admin` / `changeme123`), then create
your own accounts under My Profile.

## Backing up your data

Your entire business database is the single file:

```
server/data/mm-clothing.db
```

To back up: just copy that file somewhere safe (a USB drive, a Google
Drive folder, etc.) — ideally after closing the server. That's the whole
backup process, no export/import needed.

## Try it out

Once `npm run dev` is running, open a browser and hit:

```
http://localhost:4000/api/health
```

You should get back `{"status":"ok","time":"..."}` — confirming the
server is alive.

Everything else requires logging in first — `POST /api/auth/login` with
the seeded `admin` / `changeme123` account, then include the returned
token as `Authorization: Bearer <token>` on every other request. See
`API_REFERENCE.md` for the full picture, including which modules are
admin-only vs. open to staff too.

## What's next

1. ✅ Database schema
2. ✅ Backend API for all modules, with login and role-based access
3. ✅ React frontend — admin and staff experiences
4. A static public catalog site (separate, deployed free on Netlify)
   pulling from the same product data — this is the next piece.

This is being built incrementally — check back with Claude for the next
piece whenever you're ready to continue.
