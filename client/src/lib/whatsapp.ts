import { whatsappNumber } from "./phone";

// A WhatsApp chat link with the message already typed in — opens WhatsApp
// (web or app) addressed to the customer, ready to press send. Sri Lankan
// numbers get 94 put in front; international ones already carry their code.
export function whatsappMessageLink(phone: string, message: string): string {
  return `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(message)}`;
}

// What to tell a customer who asks "how many loyalty points do I have?" —
// their balance, and what it's worth: 1 point = Rs. 1 of store credit once
// they've reached 500 points; they earn 1 point per Rs. 100 spent.
const REDEEM_FROM = 500;
export function loyaltyPointsMessage(name: string, points: number): string {
  const balance = Math.max(0, points);
  const detail =
    balance >= REDEEM_FROM
      ? `That's worth Rs. ${balance.toLocaleString()} in store credit (1 point = Rs. 1) — you can redeem it whenever you like.`
      : balance > 0
      ? `Points can be redeemed for store credit (1 point = Rs. 1) once you reach ${REDEEM_FROM} — just ${(REDEEM_FROM - balance).toLocaleString()} to go.`
      : "You earn 1 point for every Rs. 100 you spend, and they can be redeemed for store credit.";
  return `Hi ${name}, you currently have ${balance.toLocaleString()} loyalty point${balance === 1 ? "" : "s"} with M&M Clothing. ${detail} Thank you for shopping with us!`;
}
