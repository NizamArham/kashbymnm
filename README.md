# M&M Clothing — Internal Management System

A local, free, single-computer system for stock, sales, POS, customers,
purchasing, and courier management. No hosting, no monthly cost — the
whole database is one file (SQLite) that lives on your machine.

## What's in here right now

- `server/` — Node.js + TypeScript + Express backend, with a SQLite
  database and full schema for all 13 areas of the business
  (Inventory, Products, Sales, Customers, Suppliers, Purchases,
  Payments, Deliveries, Couriers, Cash Book).
- `SCHEMA_DESIGN.md` — the human-readable design doc explaining every
  table and why it's structured the way it is. Read this if you want
  to understand the "why" behind any field.
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

## What's next

1. Confirm the database schema works as expected (`npm run db:migrate`
   should complete with no errors).
2. Backend API routes for each module (Inventory, Sales/POS, Customers,
   Purchasing, Deliveries, Cash Book).
3. React frontend that talks to that API.
4. A static public catalog site (separate, deployed free on Netlify)
   pulling from the same product data.

This is being built incrementally — check back with Claude for the next
piece whenever you're ready to continue.
