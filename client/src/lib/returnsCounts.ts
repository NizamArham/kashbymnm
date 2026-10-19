import { api } from "./api";

// Everything on its way back to the shop: returns by courier, the old items of delivered exchanges, and parcels the courier couldn't deliver.
export async function countOpenPickups(): Promise<number> {
  const [returns, exchanges, parcels] = await Promise.all([
    api.get<unknown[]>("/return-pickups?status=open"),
    api.get<{ delivery_status: string | null }[]>("/exchanges?status=open"),
    api.get<unknown[]>("/deliveries/coming-back"),
  ]);
  // An exchange's old items are on their way back once its replacement has been delivered.
  return returns.length + exchanges.filter((x) => x.delivery_status === "delivered").length + parcels.length;
}
