// A sale after a return. Items taken back that had not been paid for come off sales.total, and a courier return's delivery share can be added to it, so
// sales.total is the NET figure. The bill the customer was given is the total before those: work it back from the two adjustments, so every place that
// shows an invoice can say "billed X, returned Y, total after return Z" instead of only the new figure.
type Adjusted = { total: number; returned_off?: number | null; return_charge_added?: number | null };

export const hasReturnAdjustment = (sale: Adjusted): boolean => (sale.returned_off ?? 0) > 0 || (sale.return_charge_added ?? 0) > 0;

export const billedTotal = (sale: Adjusted): number => Math.round((sale.total + (sale.returned_off ?? 0) - (sale.return_charge_added ?? 0)) * 100) / 100;
