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

// What a search result shows per product: just the product and its units.
export interface SearchProductGroup<T> {
  product_id: number;
  product_title: string;
  brand?: string;
  selling_price?: number | null;
  units: T[];
}

/**
 * Groups a flat list of inventory units into one entry per product, each
 * containing its units already sorted by color then size. This is what
 * powers the "scan one item -> see everything else for that product"
 * lookup flow: the table shows one row per product, and expanding a row
 * reveals its full, sorted variant list.
 */
export function groupByProduct<T extends SortableUnit & { product_id: number; product_title?: string; brand?: string; selling_price?: number | null }>(
  units: T[]
): SearchProductGroup<T>[] {
  const map = new Map<number, SearchProductGroup<T>>();

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

export interface VariantSummary {
  color: string;
  size: string;
  count: number;
  skuSample: string;
  barcodeRange: string;
  status: string;
  // The supplier that actually delivered this batch, shown ONLY when
  // every unit in this variant/status group traces back to the same
  // known supplier — never a guess from the product's general
  // supplier_id, since that can be wrong once a product's been
  // restocked from more than one source.
  batchSupplierCode: string | null;
}

/**
 * Groups a product's units into one row per color+size+status, with a
 * start–end barcode range (barcodes are generated sequentially per batch)
 * and a sample SKU. This is the shared shape behind every "expand a
 * product row to see its variants" view in the app (Inventory, Browse
 * Categories) — kept in one place so that view looks and reads the same
 * everywhere a person expands a row, rather than drifting per page.
 */
export function summarizeProductVariants<
  T extends SortableUnit & { sku: string; barcode?: string | null; status: string; batch_supplier_code?: string | null }
>(productUnits: T[]): VariantSummary[] {
  const map = new Map<string, T[]>();
  for (const u of productUnits) {
    // Units of different status are kept separate even within the same
    // color+size, so an "available" row is never merged with a "damaged"
    // one under one misleading count.
    const key = `${u.color ?? ""}|${u.size ?? ""}|${u.status}`;
    const list = map.get(key) ?? [];
    list.push(u);
    map.set(key, list);
  }

  const summaries: VariantSummary[] = [];
  for (const list of map.values()) {
    const sorted = [...list].sort((a, b) => (a.barcode ?? "").localeCompare(b.barcode ?? ""));
    const barcodes = sorted.map((u) => u.barcode).filter((b): b is string => !!b);

    let barcodeRange = "—";
    if (barcodes.length === 1) {
      barcodeRange = barcodes[0];
    } else if (barcodes.length > 1) {
      barcodeRange = `${barcodes[0]} – ${barcodes[barcodes.length - 1]}`;
    }

    const supplierCodes = new Set(sorted.map((u) => u.batch_supplier_code ?? null));
    const batchSupplierCode = supplierCodes.size === 1 ? [...supplierCodes][0] ?? null : null;

    summaries.push({
      color: sorted[0].color ?? "—",
      size: sorted[0].size ?? "—",
      count: sorted.length,
      skuSample: sorted[0].sku,
      barcodeRange,
      status: sorted[0].status,
      batchSupplierCode,
    });
  }

  // Size is the primary axis (small → large); color is the tiebreaker
  // within each size, so all "M" rows cluster together regardless of
  // color, in alphabetical color order. Matches how you'd physically
  // scan a rack: one size at a time, all its colors together.
  return summaries.sort((a, b) => {
    const sizeCompare = compareSizes(a.size, b.size);
    if (sizeCompare !== 0) return sizeCompare;
    return a.color.localeCompare(b.color);
  });
}

export interface ProductGroup<T> {
  product_id: number;
  product_title: string;
  brand?: string;
  category?: string | null;
  selling_price?: number | null;
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
  T extends SortableUnit & { product_id: number; status: string; brand?: string; category?: string | null; selling_price?: number | null }
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
