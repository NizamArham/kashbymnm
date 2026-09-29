import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const categoriesRouter = Router();

// Everyone needs the list (Add Product, POS lookups, etc.) but only an
// admin may add/rename/delete — same split as suppliers/products.
categoriesRouter.use(requireAuth);

const nameInput = z.object({ name: z.string().trim().min(1, "Name is required") });

// products.category is a single free-text "Category / SubCategory (Gender)"
// field — every existing page (Browse Categories, PDFs, etc.) already
// parses it this way, so renaming a row here rewrites that text in place
// rather than switching products over to a foreign key. This is the same
// split/compose pair as the client's categoryTree.ts, reimplemented here
// since the server doesn't share code with the client bundle.
function splitCategoryString(raw: string | null): { category: string; subCategory: string; suffix: string } {
  if (!raw) return { category: "", subCategory: "", suffix: "" };
  const suffixMatch = raw.match(/\s*(\([^)]*\))\s*$/);
  const suffix = suffixMatch ? suffixMatch[1] : "";
  const withoutSuffix = suffixMatch ? raw.slice(0, suffixMatch.index) : raw;
  const [category, subCategory] = withoutSuffix.split(" / ").map((s) => s.trim());
  return { category: category ?? "", subCategory: subCategory ?? "", suffix };
}

function composeCategoryString(category: string, subCategory: string, suffix: string): string {
  let s = category;
  if (subCategory) s += ` / ${subCategory}`;
  if (suffix) s += ` ${suffix}`;
  return s;
}

// GET /api/categories — nested list for the combobox + the management modal.
categoriesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const categories = db.prepare(`SELECT id, name FROM categories ORDER BY name COLLATE NOCASE`).all() as {
      id: number;
      name: string;
    }[];
    const subCategories = db.prepare(`SELECT id, category_id, name FROM sub_categories ORDER BY name COLLATE NOCASE`).all() as {
      id: number;
      category_id: number;
      name: string;
    }[];

    const result = categories.map((c) => ({
      id: c.id,
      name: c.name,
      sub_categories: subCategories.filter((s) => s.category_id === c.id).map((s) => ({ id: s.id, name: s.name })),
    }));
    res.json(result);
  })
);

// Everything below (create/rename/delete) is admin-only.
categoriesRouter.use(requireRole("admin"));

// POST /api/categories — new top-level category.
categoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name } = nameInput.parse(req.body);
    const dup = db.prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?)`).get(name);
    if (dup) throw new ApiError(409, `A category named "${name}" already exists`);

    const result = db.prepare(`INSERT INTO categories (name) VALUES (?)`).run(name);
    res.status(201).json({ id: result.lastInsertRowid, name, sub_categories: [] });
  })
);

// PUT /api/categories/:id — rename, cascading onto every product that
// currently has this category, so the picklist and real product data
// never drift apart (per the owner's explicit call: renames/merges like
// "Chino" -> "Chinos" should clean up and replace everywhere, whether or
// not anything currently uses the old name).
categoriesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { name } = nameInput.parse(req.body);
    const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(req.params.id) as
      | { id: number; name: string }
      | undefined;
    if (!category) throw new ApiError(404, "Category not found");

    const dup = db.prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ?`).get(name, category.id);
    if (dup) throw new ApiError(409, `A category named "${name}" already exists`);

    const runRename = db.transaction(() => {
      db.prepare(`UPDATE categories SET name = ? WHERE id = ?`).run(name, category.id);

      const products = db.prepare(`SELECT id, category FROM products WHERE category IS NOT NULL`).all() as {
        id: number;
        category: string;
      }[];
      let updated = 0;
      for (const p of products) {
        const parts = splitCategoryString(p.category);
        if (parts.category.toLowerCase() !== category.name.toLowerCase()) continue;
        const next = composeCategoryString(name, parts.subCategory, parts.suffix);
        db.prepare(`UPDATE products SET category = ? WHERE id = ?`).run(next, p.id);
        updated++;
      }
      return updated;
    });

    const productsUpdated = runRename();
    res.json({ id: category.id, name, products_updated: productsUpdated });
  })
);

// DELETE /api/categories/:id — blocked while any product still uses it,
// so deleting never silently orphans real catalog data.
categoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(req.params.id) as
      | { id: number; name: string }
      | undefined;
    if (!category) throw new ApiError(404, "Category not found");

    const products = db.prepare(`SELECT category FROM products WHERE category IS NOT NULL`).all() as { category: string }[];
    const inUseCount = products.filter((p) => splitCategoryString(p.category).category.toLowerCase() === category.name.toLowerCase()).length;
    if (inUseCount > 0) {
      throw new ApiError(409, `${inUseCount} product${inUseCount === 1 ? "" : "s"} still use "${category.name}" — reassign them first.`);
    }

    db.prepare(`DELETE FROM categories WHERE id = ?`).run(category.id);
    res.status(204).send();
  })
);

// POST /api/categories/:id/sub-categories — new sub-category under a category.
categoriesRouter.post(
  "/:id/sub-categories",
  asyncHandler(async (req, res) => {
    const { name } = nameInput.parse(req.body);
    const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(req.params.id) as
      | { id: number; name: string }
      | undefined;
    if (!category) throw new ApiError(404, "Category not found");

    const dup = db
      .prepare(`SELECT id FROM sub_categories WHERE category_id = ? AND LOWER(name) = LOWER(?)`)
      .get(category.id, name);
    if (dup) throw new ApiError(409, `"${category.name}" already has a sub-category named "${name}"`);

    const result = db.prepare(`INSERT INTO sub_categories (category_id, name) VALUES (?, ?)`).run(category.id, name);
    res.status(201).json({ id: result.lastInsertRowid, category_id: category.id, name });
  })
);

// PUT /api/categories/sub-categories/:id — rename, cascading the same way
// as a category rename.
categoriesRouter.put(
  "/sub-categories/:id",
  asyncHandler(async (req, res) => {
    const { name } = nameInput.parse(req.body);
    const sub = db.prepare(`SELECT * FROM sub_categories WHERE id = ?`).get(req.params.id) as
      | { id: number; category_id: number; name: string }
      | undefined;
    if (!sub) throw new ApiError(404, "Sub-category not found");
    const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(sub.category_id) as { id: number; name: string };

    const dup = db
      .prepare(`SELECT id FROM sub_categories WHERE category_id = ? AND LOWER(name) = LOWER(?) AND id != ?`)
      .get(sub.category_id, name, sub.id);
    if (dup) throw new ApiError(409, `"${category.name}" already has a sub-category named "${name}"`);

    const runRename = db.transaction(() => {
      db.prepare(`UPDATE sub_categories SET name = ? WHERE id = ?`).run(name, sub.id);

      const products = db.prepare(`SELECT id, category FROM products WHERE category IS NOT NULL`).all() as {
        id: number;
        category: string;
      }[];
      let updated = 0;
      for (const p of products) {
        const parts = splitCategoryString(p.category);
        if (
          parts.category.toLowerCase() !== category.name.toLowerCase() ||
          parts.subCategory.toLowerCase() !== sub.name.toLowerCase()
        )
          continue;
        const next = composeCategoryString(category.name, name, parts.suffix);
        db.prepare(`UPDATE products SET category = ? WHERE id = ?`).run(next, p.id);
        updated++;
      }
      return updated;
    });

    const productsUpdated = runRename();
    res.json({ id: sub.id, category_id: sub.category_id, name, products_updated: productsUpdated });
  })
);

// DELETE /api/categories/sub-categories/:id — blocked while any product
// still uses it.
categoriesRouter.delete(
  "/sub-categories/:id",
  asyncHandler(async (req, res) => {
    const sub = db.prepare(`SELECT * FROM sub_categories WHERE id = ?`).get(req.params.id) as
      | { id: number; category_id: number; name: string }
      | undefined;
    if (!sub) throw new ApiError(404, "Sub-category not found");
    const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(sub.category_id) as { id: number; name: string };

    const products = db.prepare(`SELECT category FROM products WHERE category IS NOT NULL`).all() as { category: string }[];
    const inUseCount = products.filter((p) => {
      const parts = splitCategoryString(p.category);
      return parts.category.toLowerCase() === category.name.toLowerCase() && parts.subCategory.toLowerCase() === sub.name.toLowerCase();
    }).length;
    if (inUseCount > 0) {
      throw new ApiError(409, `${inUseCount} product${inUseCount === 1 ? "" : "s"} still use "${sub.name}" — reassign them first.`);
    }

    db.prepare(`DELETE FROM sub_categories WHERE id = ?`).run(sub.id);
    res.status(204).send();
  })
);
