/**
 * Re-categorizes products that were imported from the spreadsheet with
 * the original 8 coarse categories (Pants, Tees, Boxers, Jackets,
 * Accessories, Shorts, Bags, Others) into a proper, more specific
 * category + sub-category taxonomy, built by reading every product's
 * actual title.
 *
 * Run with: npm run db:recategorize
 *
 * Matches products by product_title (spreadsheet product codes like
 * "P001" aren't stored in our products table — only titles are — so
 * titles are the join key here). Safe to run multiple times: it always
 * sets the category to the same target value, so re-running just
 * reapplies the same mapping rather than compounding changes.
 */
import { db } from "./connection";

// title -> [category, subCategory], built by reviewing every real product
// in the September 2026 import. Update this map if new spreadsheet
// products are imported later with titles not covered here.
const CATEGORY_MAP: Record<string, [string, string]> = {
  "MS-Ultimate Chino-OG": ["Pants & Chinos", "Chino"],
  "GP-Linen Slim Pant-FO": ["Pants & Chinos", "Linen Pant"],
  "MC-Cors Cargo-FO": ["Pants & Chinos", "Cargo"],
  "GP-90s Loose Fit Linen Pant-FO": ["Pants & Chinos", "Linen Pant"],
  "GP-Double Cotton Ladies Easy Shorts-FO": ["Shorts", "Casual Shorts"],
  "CR-Carhartt Cap-Regular": ["Headwear", "Cap"],
  "CR-Carhartt Cap-Premium": ["Headwear", "Cap"],
  "CB-Columbia Cap": ["Headwear", "Cap"],
  "NF-North Face Cap": ["Headwear", "Cap"],
  "LC-Lacoste Crewneck-OR": ["T-Shirts & Polos", "Crewneck"],
  "HK-Sport Polo T-Shirt-OG": ["T-Shirts & Polos", "Polo"],
  "RL-RL Shirt Red Dotted-OG": ["Shirts", "Casual Shirt"],
  "MS-Ladies Tailored Blouse-FO": ["Shirts", "Blouse"],
  "AZ-ADEAZ Jogger Bottom-FO": ["Joggers & Activewear", "Jogger"],
  "TH-Tommy Flag Bearer Slim Pant-OG": ["Pants & Chinos", "Slim Pant"],
  "TT-Tapered Fit Cargo-FO": ["Pants & Chinos", "Cargo"],
  "ML-Mix Lot Chinos-FO": ["Pants & Chinos", "Chino"],
  "GP-GAP Cargo Pant-FO": ["Pants & Chinos", "Cargo"],
  "CK-Infinite Flex Chino-OG": ["Pants & Chinos", "Chino"],
  "TH-TH Chino-FO": ["Pants & Chinos", "Chino"],
  "MC-Elastic Waist Pant-FO": ["Pants & Chinos", "Elastic Waist Pant"],
  "ML-Ladies Denim Wideleg Mix-FO": ["Jeans", "Wide Leg"],
  "LB-Big Boys Lucky Brand Denim-FO": ["Jeans", "Kids' Denim"],
  "EB-Eddie Bauer Denim-FO": ["Jeans", "Regular Denim"],
  "EB-Eddie Bauer Ranger Straight Leg Pant-FO": ["Pants & Chinos", "Straight Leg Pant"],
  "BR-Chambray Shirt-FO": ["Shirts", "Casual Shirt"],
  "TH-Oxford Cotton Shirt-OG": ["Shirts", "Oxford"],
  "TH-Oxford Cotton F/O Shirt-FO": ["Shirts", "Oxford"],
  "GP-Everyday Poplin Shirt-FO": ["Shirts", "Casual Shirt"],
  "UQ-Plain Tee Round Neck-FO": ["T-Shirts & Polos", "Round Neck"],
  "GP-Oxford Shirt-OR": ["Shirts", "Oxford"],
  "GP-Linen Long Sleeve Stripe Shirt-FO": ["Shirts", "Casual Shirt"],
  "GP-Linen Cuban Collar Shirt-FO": ["Shirts", "Cuban Collar"],
  "OK-BBQ Shirt-FO": ["Shirts", "Casual Shirt"],
  "UQ-Printed T-Shirt-FO": ["T-Shirts & Polos", "Printed Tee"],
  "LV-Levi's Denim Short High Rise-FO": ["Shorts", "Denim Shorts"],
  "HB-Regular Fit T-Shirt-OG": ["T-Shirts & Polos", "Crewneck"],
  "AI-Seamless Crewneck Tee-FO": ["T-Shirts & Polos", "Crewneck"],
  "WR-Wrangler Denim-FO": ["Jeans", "Regular Denim"],
  "LV-Levi's Men's Mix Lot-FO": ["Jeans", "Men's Denim Mix"],
  "TH-Tommy Hilfiger Pants Mix Lot-OG": ["Pants & Chinos", "Mix Lot Pant"],
  "GT-Regular Fit Twill Cotton Pant-FO": ["Pants & Chinos", "Twill Cotton Pant"],
  "CK-Standard Straight Pant-OG": ["Pants & Chinos", "Straight Pant"],
  "GP-Straight Drop Pant-FO": ["Pants & Chinos", "Straight Drop Pant"],
  "GT-Regular Fit Denim-OG": ["Jeans", "Regular Denim"],
  "US-Jetblack Denim-OG": ["Jeans", "Regular Denim"],
  "LV-Levi's Denim Mix Lot-OG": ["Jeans", "Men's Denim Mix"],
  "LV-Ladies Denim Mix Lot-OG": ["Jeans", "Women's Denim Mix"],
  "EB-Ladies Pant-FO": ["Pants & Chinos", "Women's Pant"],
  "GP-Baggy Fit Pant-OG": ["Pants & Chinos", "Baggy Fit Pant"],
  "TH-Jogger Pant-OG": ["Joggers & Activewear", "Jogger"],
  "US-USPA Polo T-Shirt-OG": ["T-Shirts & Polos", "Polo"],
  "GP-Linen Long Sleeve Shirt-FO": ["Shirts", "Casual Shirt"],
  "CS-Castore F1 Merch Mix Lot-FO": ["T-Shirts & Polos", "Graphic Tee"],
  "CS-Castore F1 Kids' Round Neck Tee Mix-FO": ["T-Shirts & Polos", "Kids' Round Neck"],
  "CS-Castore F1 Kids' Hoodie Mix-FO": ["Hoodies", "Kids' Hoodie"],
  "EL-Ellesse Mens Hipster Boxers-FO": ["Underwear", "Boxers"],
  "CR-Crocodile Talon Boxers-FO": ["Underwear", "Boxers"],
  "CK-CK Variety Waistband Boxers-FO": ["Underwear", "Boxers"],
  "GS-Gymshark Soft Sculpt Legging-OG": ["Joggers & Activewear", "Leggings"],
  "NK-Nike Pro Mens Training Short-OG": ["Shorts", "Training Shorts"],
  "CK-CK HP Brief Micro Fiber Mesh-OG": ["Underwear", "Boxer Briefs"],
  "GS-Guess Bags-Damages": ["Bags", "Handbag"],
  "CS-Castore Woven Training Short-FO": ["Shorts", "Training Shorts"],
  "CS-Castore Training Pant & Short Mix-FO": ["Joggers & Activewear", "Training Pant & Short Mix"],
  "CK OG T-Shirt Crewneck": ["T-Shirts & Polos", "Crewneck"],
  "CK Sleep Suit": ["Underwear", "Sleepwear"],
  "BR Dress Shirts Mix Styles-FO": ["Shirts", "Dress Shirt"],
  "OG BR Dress Shirts Mix Styles": ["Shirts", "Dress Shirt"],
  "OLD Navy Plain Shirts-FO": ["T-Shirts & Polos", "Plain Tee"],
  "Lacoste OG Kids' Jerseys Mix Lot": ["T-Shirts & Polos", "Kids' Jersey"],
  "Lacoste OG Mens Short": ["Shorts", "Casual Shorts"],
  "Castore Fleece Mix Hoodies": ["Hoodies", "Fleece Hoodie"],
  "Kids Muffler": ["Accessories", "Muffler"],
  "Lands End Formal Pant": ["Pants & Chinos", "Formal Pant"],
  "Sleeveless Puffy Jacket": ["Jackets & Coats", "Puffer Jacket"],
  "Hoodies Padded Mix Lot": ["Hoodies", "Padded Hoodie"],
  "Puffy Mix Jacket": ["Jackets & Coats", "Puffer Jacket"],
  "Roxy Backpack 20.5L": ["Bags", "Backpack"],
  "CK OG Straight Fit Pant": ["Pants & Chinos", "Straight Fit Pant"],
  "Superdry Biker Jacket": ["Jackets & Coats", "Biker Jacket"],
  "Lacoste OG Boxer Briefs": ["Underwear", "Boxer Briefs"],
  "Castore Quarter Zip Long Sleeve Performance Tee": ["T-Shirts & Polos", "Performance Tee"],
  "Pierre Cardin Pant": ["Pants & Chinos", "Formal Pant"],
  "Nike Sports Bra": ["Underwear", "Sports Bra"],
  "Uniqlo Pea Coat": ["Jackets & Coats", "Pea Coat"],
};

function run() {
  const update = db.prepare(`UPDATE products SET category = ? WHERE product_title = ?`);
  let updated = 0;
  const notFound: string[] = [];

  const runAll = db.transaction(() => {
    for (const [title, [category, subCategory]] of Object.entries(CATEGORY_MAP)) {
      const combined = `${category} / ${subCategory}`;
      const result = update.run(combined, title);
      if (result.changes > 0) {
        updated += result.changes;
      } else {
        notFound.push(title);
      }
    }
  });

  runAll();

  console.log(`Re-categorized ${updated} product(s).`);
  if (notFound.length > 0) {
    console.log(`\n${notFound.length} title(s) in the mapping were not found in the database (product title mismatch — check for typos or a title that changed since import):`);
    notFound.forEach((t) => console.log(`  - ${t}`));
  }

  // Show the final category breakdown so it's easy to eyeball correctness.
  const rows = db.prepare(`SELECT category, COUNT(*) as count FROM products GROUP BY category ORDER BY category`).all() as {
    category: string;
    count: number;
  }[];
  console.log("\nFinal category breakdown:");
  rows.forEach((r) => console.log(`  ${r.category ?? "(none)"}: ${r.count}`));
}

run();
