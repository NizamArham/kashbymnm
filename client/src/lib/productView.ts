import { writeMemory } from "./viewMemory";

// Opens one product's own panel (Restock or Details) on the Inventory → Products list. That list already remembers which product was open and on
// which tab (see ManageProductsPage's "products.*" keys), so this sets exactly that, clears any search / filter that could hide the product, and
// asks the list to scroll to it once it has opened.
export function openProductInInventory(navigate: (to: string) => void, productId: number, tab: "restock" | "details") {
  writeMemory("products.q", "");
  writeMemory("products.g", null);
  writeMemory("products.f", {});
  writeMemory("products.scroll", null);
  writeMemory("products.expanded", productId);
  writeMemory("products.tab", tab);
  writeMemory("products.focus", productId);
  navigate("/products");
}
