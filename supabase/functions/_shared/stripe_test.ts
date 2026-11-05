// deno test supabase/functions/_shared/stripe_test.ts
import { formEncode, invoiceRow, verifyWebhook } from "./stripe.ts";

const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
async function sign(secret: string, t: number, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };

Deno.test("form encoding nests objects and arrays the way Stripe expects", () => {
  const s = formEncode({ customer: "cus_1", automatic_tax: { enabled: true }, metadata: { engagement_id: "e1" }, expand: ["payments"], skip: undefined, address: { line1: "1 Main & Co" } });
  assert(s === "customer=cus_1&automatic_tax%5Benabled%5D=true&metadata%5Bengagement_id%5D=e1&expand%5B0%5D=payments&address%5Bline1%5D=1%20Main%20%26%20Co", s);
});

Deno.test("a correctly signed webhook verifies; tampering, a wrong secret and a stale timestamp don't", async () => {
  const secret = "whsec_test", body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });
  const now = Date.now(), t = Math.floor(now / 1000);
  const good = `t=${t},v1=${await sign(secret, t, body)}`;
  const ev = await verifyWebhook(body, good, secret, 300, now);
  assert(ev.id === "evt_1" && ev.type === "invoice.paid", "parsed event");
  assert(await verifyWebhook(body, `t=${t},v1=deadbeef,v1=${await sign(secret, t, body)}`, secret, 300, now), "any matching v1 is enough");
  assert(await rejects(verifyWebhook(body.replace("in_1", "in_2"), good, secret, 300, now)), "tampered body must fail");
  assert(await rejects(verifyWebhook(body, good, "whsec_other", 300, now)), "wrong secret must fail");
  assert(await rejects(verifyWebhook(body, good, secret, 300, now + 301_000)), "stale timestamp must fail");
  assert(await rejects(verifyWebhook(body, null, secret, 300, now)), "missing header must fail");
});

Deno.test("an invoice maps to the portal's columns, with tax summed from total_taxes", () => {
  const r = invoiceRow({ id: "in_1", number: "SYP-0001", status: "open", currency: "usd", subtotal: 500000, total: 541250, amount_due: 541250, amount_paid: 0, amount_remaining: 541250,
    total_taxes: [{ amount: 41250 }], due_date: 1767225600, hosted_invoice_url: "https://invoice.stripe.com/i/x", invoice_pdf: "https://pay.stripe.com/invoice/x/pdf", status_transitions: { finalized_at: 1767000000, paid_at: null } });
  assert(r.tax === 41250 && r.total === 541250 && r.status === "open", JSON.stringify(r));
  assert(r.due_date === "2026-01-01" && r.paid_at === null && r.finalized_at?.startsWith("2025-12-29"), JSON.stringify(r));
});
