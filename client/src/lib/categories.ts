// Category -> sub-category structure for the Add Product form.
// Kept as a fixed list (not free text) so category values stay consistent
// for filtering and reporting. Built from a full review of the real
// product catalog (see server/src/db/recategorize-products.ts), extended
// with a few sensible extra sub-categories for future stock in the same
// categories.

export const categoryStructure: Record<string, string[]> = {
  "T-Shirts & Polos": [
    "Crewneck", "Polo", "Round Neck", "Printed Tee", "Plain Tee", "Graphic Tee",
    "Performance Tee", "Kids' Round Neck", "Kids' Jersey",
  ],
  "Shirts": ["Casual Shirt", "Oxford", "Cuban Collar", "Dress Shirt", "Blouse", "Chambray"],
  "Pants & Chinos": [
    "Chino", "Cargo", "Linen Pant", "Slim Pant", "Elastic Waist Pant", "Straight Leg Pant",
    "Straight Pant", "Straight Drop Pant", "Straight Fit Pant", "Mix Lot Pant",
    "Twill Cotton Pant", "Baggy Fit Pant", "Formal Pant", "Women's Pant",
  ],
  "Jeans": ["Regular Denim", "Wide Leg", "Men's Denim Mix", "Women's Denim Mix", "Kids' Denim", "Skinny", "Bootcut"],
  "Joggers & Activewear": ["Jogger", "Leggings", "Training Pant & Short Mix", "Track Pants", "Sweatpants"],
  "Shorts": ["Casual Shorts", "Denim Shorts", "Training Shorts", "Cargo Shorts", "Swim Shorts"],
  "Hoodies": ["Fleece Hoodie", "Padded Hoodie", "Kids' Hoodie", "Pullover", "Zip-Up"],
  "Jackets & Coats": ["Puffer Jacket", "Biker Jacket", "Pea Coat", "Bomber", "Blazer", "Windbreaker"],
  "Underwear": ["Boxers", "Boxer Briefs", "Sleepwear", "Sports Bra", "Briefs"],
  "Bags": ["Backpack", "Handbag", "Tote Bag", "Duffel Bag"],
  "Headwear": ["Cap", "Beanie", "Bucket Hat"],
  "Accessories": ["Muffler", "Belt", "Scarf", "Socks", "Sunglasses", "Jewelry"],
  "Footwear": ["Sneakers", "Casual Shoes", "Formal Shoes", "Sandals", "Slippers"],
};

export const mainCategories = Object.keys(categoryStructure);

export const genderOptions = ["Male", "Female", "Unisex"];
