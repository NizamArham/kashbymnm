# M&M Clothing — Internal Management System

A local, free, single-computer system for stock, sales, POS, customers,
purchasing, and courier management. No hosting, no monthly cost — the
whole database is one file (SQLite) that lives on your machine.

## What's in here right now

- `server/` — a complete Node.js + TypeScript + Express backend: full
  SQLite database schema, plus working API routes for every module
  (Business Info, Customers + Addresses, Suppliers, Products, Inventory,
  Sales/POS, Purchases, Supplier Payments, Deliveries, Courier Payments,
  Cash Book).
- `SCHEMA_DESIGN.md` — the human-readable design doc explaining every
  table and why it's structured the way it is.
- `API_REFERENCE.md` — every API endpoint, what it does, and example
  request bodies. Read this before building the frontend against it.
- `client/` — reserved for the React frontend (not built yet — this is
  the next step).

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
```

`npm install` downloads the required packages (Express, SQLite driver,
etc.) — this needs an internet connection once, but nothing after that.

`npm run db:migrate` creates the actual database file at
`server/data/mm-clothing.db` with all 14 tables (11 core areas + 3
supporting tables) already set up. It's safe to run this command again
any time — it won't erase existing data or duplicate tables.

## Running the server

```
npm run dev
```

This starts the backend on your machine (localhost). Keep this terminal
open while you're using the system.

## Backing up your data

Your entire business database is the single file:

```
server/data/mm-clothing.db
```

To back up: just copy that file somewhere safe (a USB drive, a Google
Drive folder, etc.) — ideally after closing the server. That's the whole
backup process, no export/import needed.

## Try it out

Once `npm run dev` is running, open a browser (or use a tool like
Postman/Insomnia, or just `curl`) and hit:

```
http://localhost:4000/api/health
```

You should get back `{"status":"ok","time":"..."}` — confirming the
server is alive. From there, see `API_REFERENCE.md` for every real
endpoint (suppliers, products, inventory, sales, purchases, etc.) with
example request bodies.

## What's next

1. ✅ Database schema
2. ✅ Backend API for all modules
3. React frontend that talks to that API — this is the next step.
4. A static public catalog site (separate, deployed free on Netlify)
   pulling from the same product data.

This is being built incrementally — check back with Claude for the next
piece whenever you're ready to continue.
