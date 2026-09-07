// Sequential barcode generation shared between Add Product and Restock
// flows. A random 10-digit base is picked once per batch, then each unit
// gets base+0, base+1, base+2... — this is what makes a truthful
// "start–end" range display possible, unlike fully random codes.

export function makeBarcodeBatch(count: number, startFrom: number): string[] {
  const prefix = "890";
  return Array.from({ length: count }, (_, i) => `${prefix}${String(startFrom + i).padStart(10, "0")}`);
}

export function randomBatchStart(): number {
  return Math.floor(Math.random() * 9_000_000_000) + 100_000_000;
}
