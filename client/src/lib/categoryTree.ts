import { InventoryUnit } from "./types";

export interface CategoryTreeNode {
  category: string;
  count: number;
  subCategories: { name: string; count: number }[];
}

// Category strings look like "Pants & Chinos / Slim Pant (Male)" — this
// splits off the gender tag and the category/sub-category pair. Shared by
// the Inventory page (pill nav) and the Browse Categories page (card
// grid) so both read the exact same structure out of the same data.
export function splitCategory(raw?: string | null): { category: string; subCategory: string } {
  if (!raw) return { category: "", subCategory: "" };
  const withoutGender = raw.replace(/\s*\([^)]*\)\s*$/, "");
  const [category, subCategory] = withoutGender.split(" / ").map((s) => s.trim());
  return { category: category ?? "", subCategory: subCategory ?? "" };
}

// The raw trailing "(Gender)" tag text (e.g. "(Male)"), or "" if there
// isn't one — kept separate from splitCategoryWithGender's normalized
// ProductGender so an edit form can restore it byte-for-byte on save
// without needing to know the tag vocabulary itself.
export function extractGenderSuffix(raw?: string | null): string {
  const match = (raw ?? "").match(/\s*(\([^)]*\))\s*$/);
  return match ? match[1] : "";
}

// The inverse of splitCategory + extractGenderSuffix — rebuilds the
// stored "Category / SubCategory (Gender)" string from its parts.
export function composeCategory(category: string, subCategory: string, genderSuffix: string): string {
  let s = category;
  if (subCategory) s += ` / ${subCategory}`;
  if (genderSuffix) s += ` ${genderSuffix}`;
  return s;
}

// Category tree (with unit counts) — derived from what's actually in the
// data, not a fixed list, so imported/legacy category names (e.g. "Pants",
// "Tees" from a spreadsheet import) always show up correctly instead of
// silently mismatching a hardcoded list.
export function buildCategoryTree(units: InventoryUnit[]): CategoryTreeNode[] {
  const map = new Map<string, { count: number; subCategories: Map<string, number> }>();
  units.forEach((u) => {
    const { category, subCategory } = splitCategory(u.category);
    if (!category) return;
    if (!map.has(category)) map.set(category, { count: 0, subCategories: new Map() });
    const entry = map.get(category)!;
    entry.count += 1;
    if (subCategory) entry.subCategories.set(subCategory, (entry.subCategories.get(subCategory) ?? 0) + 1);
  });
  return Array.from(map.entries())
    .map(([category, { count, subCategories }]) => ({
      category,
      count,
      subCategories: Array.from(subCategories.entries())
        .map(([name, subCount]) => ({ name, count: subCount }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export type ProductGender = "male" | "female" | "kids" | "unspecified";

const GENDER_TAGS: Record<string, ProductGender> = { Male: "male", Female: "female", Kids: "kids" };

// Same category string, but also pulls out the trailing gender tag (e.g.
// "Jeans (Female)") — only ~15% of products carry one so far (the rest
// are "unspecified"), used to group browsing by Men/Women/Kids.
export function splitCategoryWithGender(raw?: string | null): { category: string; subCategory: string; gender: ProductGender } {
  const { category, subCategory } = splitCategory(raw);
  const tagMatch = (raw ?? "").match(/\(([^)]*)\)\s*$/);
  const gender = (tagMatch && GENDER_TAGS[tagMatch[1].trim()]) || "unspecified";
  return { category, subCategory, gender };
}

export interface GenderGroup {
  gender: ProductGender;
  label: string;
  count: number;
  categories: CategoryTreeNode[];
}

const GENDER_ORDER: ProductGender[] = ["male", "female", "kids", "unspecified"];
const GENDER_LABELS: Record<ProductGender, string> = { male: "Men", female: "Women", kids: "Kids", unspecified: "Unspecified" };

// Groups units by gender first, then builds each gender's own category
// tree — the "unspecified" bucket is real and often the largest, since
// most stock predates gender tagging; it's kept (not hidden) so nothing
// becomes unreachable through this view.
export function buildGenderCategoryTree(units: InventoryUnit[]): GenderGroup[] {
  const byGender = new Map<ProductGender, InventoryUnit[]>();
  units.forEach((u) => {
    const { gender } = splitCategoryWithGender(u.category);
    const list = byGender.get(gender) ?? [];
    list.push(u);
    byGender.set(gender, list);
  });

  return GENDER_ORDER.filter((g) => byGender.has(g)).map((gender) => ({
    gender,
    label: GENDER_LABELS[gender],
    count: byGender.get(gender)!.length,
    categories: buildCategoryTree(byGender.get(gender)!),
  }));
}
