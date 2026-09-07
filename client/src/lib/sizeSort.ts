// Sorts inventory display order: grouped by product, then by color, then
// by size in a human-logical order (not alphabetical, which would wrongly
// put "L" before "M" is fine but breaks completely for "XS" or numeric
// sizes like "32/30").

const LETTER_SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];

// Parses a "32/30" or "32" waist/inseam style size into comparable numbers.
// Returns null if the string doesn't look like a numeric size at all.
function parseNumericSize(size: string): { waist: number; inseam: number } | null {
  const match = size.match(/^(\d+)(?:\/(\d+))?$/);
  if (!match) return null;
  return {
    waist: parseInt(match[1], 10),
    inseam: match[2] ? parseInt(match[2], 10) : 0,
  };
}

/**
 * Compare function for sorting size strings. Letter sizes (XS..XXXL) sort
 * first, in that fixed order. Numeric sizes ("32/30", "34") sort after all
 * letter sizes, ascending by waist then inseam. Anything unrecognized
 * sorts last, alphabetically, so it's never silently dropped or crashes.
 */
export function compareSizes(a: string, b: string): number {
  const aIndex = LETTER_SIZE_ORDER.indexOf(a.toUpperCase());
  const bIndex = LETTER_SIZE_ORDER.indexOf(b.toUpperCase());

  if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
  if (aIndex !== -1) return -1; // a is a known letter size, b isn't -> a first
  if (bIndex !== -1) return 1;

  const aNum = parseNumericSize(a);
  const bNum = parseNumericSize(b);
  if (aNum && bNum) {
    if (aNum.waist !== bNum.waist) return aNum.waist - bNum.waist;
    return aNum.inseam - bNum.inseam;
  }
  if (aNum) return -1; // numeric sizes sort after letters but before unknowns
  if (bNum) return 1;

  return a.localeCompare(b);
}

export interface SortableUnit {
  product_title?: string;
  color?: string | null;
  size?: string | null;
}

/**
 * Sorts inventory units for display: product title, then color (grouped
 * together, alphabetical), then size in logical order. Units with no
 * size/color sort using empty string, which naturally lands them first
 * within their group.
 */
export function sortInventoryForDisplay<T extends SortableUnit>(units: T[]): T[] {
  return [...units].sort((a, b) => {
    const titleCompare = (a.product_title ?? "").localeCompare(b.product_title ?? "");
    if (titleCompare !== 0) return titleCompare;

    const colorCompare = (a.color ?? "").localeCompare(b.color ?? "");
    if (colorCompare !== 0) return colorCompare;

    return compareSizes(a.size ?? "", b.size ?? "");
  });
}

export interface ProductGroup<T> {
  product_id: number;
  product_title: string;
  brand?: string;
  selling_price?: number;
  units: T[];
}

/**
 * Groups a flat list of inventory units into one entry per product, each
 * containing its units already sorted by color then size. This is what
 * powers the "scan one item -> see everything else for that product"
 * lookup flow: the table shows one row per product, and expanding a row
 * reveals its full, sorted variant list.
 */
export function groupByProduct<T extends SortableUnit & { product_id: number; product_title?: string; brand?: string; selling_price?: number }>(
  units: T[]
): ProductGroup<T>[] {
  const map = new Map<number, ProductGroup<T>>();

  for (const unit of units) {
    let group = map.get(unit.product_id);
    if (!group) {
      group = {
        product_id: unit.product_id,
        product_title: unit.product_title ?? "Unknown product",
        brand: unit.brand,
        selling_price: unit.selling_price,
        units: [],
      };
      map.set(unit.product_id, group);
    }
    group.units.push(unit);
  }

  const groups = Array.from(map.values());
  groups.forEach((g) => {
    g.units.sort((a, b) => {
      const colorCompare = (a.color ?? "").localeCompare(b.color ?? "");
      if (colorCompare !== 0) return colorCompare;
      return compareSizes(a.size ?? "", b.size ?? "");
    });
  });
  groups.sort((a, b) => a.product_title.localeCompare(b.product_title));

  return groups;
}

export interface ProductGroup<T> {
  product_id: number;
  product_title: string;
  brand?: string;
  category?: string | null;
  selling_price?: number;
  availableCount: number;
  damagedCount: number;
  units: T[]; // sorted by color then size
}

/**
 * Groups a flat list of inventory units into one entry per product, with
 * its variants pre-sorted by color then size. This is the shape the
 * Inventory table actually renders: one row per product, expandable to
 * show its full color/size breakdown.
 */
export function groupInventoryByProduct<
  T extends SortableUnit & { product_id: number; status: string; brand?: string; category?: string | null; selling_price?: number }
>(units: T[]): ProductGroup<T>[] {
  const byProduct = new Map<number, T[]>();
  for (const unit of units) {
    const list = byProduct.get(unit.product_id) ?? [];
    list.push(unit);
    byProduct.set(unit.product_id, list);
  }

  const groups: ProductGroup<T>[] = [];
  for (const [productId, productUnits] of byProduct) {
    const sorted = sortInventoryForDisplay(productUnits);
    const first = sorted[0];
    groups.push({
      product_id: productId,
      product_title: first.product_title ?? "",
      brand: first.brand,
      category: first.category,
      selling_price: first.selling_price,
      availableCount: sorted.filter((u) => u.status === "available").length,
      damagedCount: sorted.filter((u) => u.status === "damaged").length,
      units: sorted,
    });
  }

  return groups.sort((a, b) => a.product_title.localeCompare(b.product_title));
}
