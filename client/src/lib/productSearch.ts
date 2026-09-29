import Fuse, { IFuseOptions } from "fuse.js";
import { InventoryUnit } from "./types";

// Typo-tolerant, any-word-order product search shared by Inventory and POS —
// staff rarely remember a product's exact full title, so a plain substring
// match (the old approach) missed things like "blue shirt" not matching
// "Casual Shirt - Blue", or a small typo missing entirely. Fuse.js scores
// each field independently and ranks the best overall match first.
const SEARCH_OPTIONS: IFuseOptions<InventoryUnit> = {
  keys: [
    { name: "product_title", weight: 0.4 },
    { name: "brand", weight: 0.2 },
    { name: "category", weight: 0.15 },
    { name: "color", weight: 0.1 },
    { name: "size", weight: 0.05 },
    { name: "sku", weight: 0.05 },
    { name: "barcode", weight: 0.05 },
  ],
  threshold: 0.35, // 0 = exact only, 1 = match anything — 0.35 forgives typos/partial words without surfacing unrelated products
  ignoreLocation: true, // a match counts anywhere in the field, not just near the start
  minMatchCharLength: 2,
};

export function createProductSearchIndex(units: InventoryUnit[]): Fuse<InventoryUnit> {
  return new Fuse(units, SEARCH_OPTIONS);
}

export function searchProductUnits(index: Fuse<InventoryUnit>, query: string): InventoryUnit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Fuse treats a space-separated query as one fuzzy pattern, which still
  // falls down on word order ("shirt blue" vs "blue shirt"). Splitting on
  // whitespace and requiring every token to match keeps multi-word queries
  // working regardless of order, while each token still gets full fuzzy
  // (typo-tolerant) matching on its own.
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let candidates = index.search(tokens[0]).map((r) => r.item);
  for (const token of tokens.slice(1)) {
    const tokenMatches = new Set(index.search(token).map((r) => r.item));
    candidates = candidates.filter((item) => tokenMatches.has(item));
  }
  return candidates;
}
