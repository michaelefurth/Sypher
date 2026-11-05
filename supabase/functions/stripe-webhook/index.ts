// POST from Stripe (no portal sign-in; the Stripe-Signature header is verified instead).
//
// Keeps public.invoices current and tells Michael what needs him. Each event is applied once
// (public.stripe_events records the ones already handled), and a slow or failed delivery is
// safe because Stripe retries and the handlers re-read the invoice rather than trusting order.
//
// Events to subscribe the endpoint to (Stripe Dashboard → Developers → Webhooks):
//   invoice.finalized  invoice.sent  invoice.updated  invoice.paid  invoice.payment_failed
//   invoice.voided  invoice.marked_uncollectible  charge.refunded  credit_note.created
//   cash_balance.funds_available
import { json } from "../_shared/http.ts";
import { admin, logActivity } from "../_shared/supabase.ts";
import { escapeHtml, layout, sendEmail } from "../_shared/email.ts";
import { invoiceRow, stripe, StripeError, verifyWebhook } from "../_shared/stripe.ts";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sypher.solutions";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "michael@sypher.solutions";
const money = (cents: number | null | undefined, cur = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur.toUpperCase() }).format((cents ?? 0) / 100);

type Inv = Record<string, any>;

/** Bring the portal's row up to date with a Stripe invoice. Only invoices the portal created (metadata.engagement_id) are tracked. */
async function upsertInvoice(inv: Inv) {
  const engagementId = inv.metadata?.engagement_id;
  const { data: existing } = await admin.from("invoices").select("id, engagement_id, status, description").eq("stripe_invoice_id", inv.id).maybeSingle();
  if (!existing && !engagementId) return null; // created elsewhere in Stripe; not an engagement invoice
  const row = invoiceRow(inv);
  if (existing) {
    await admin.from("invoices").update(row).eq("id", existing.id);
    return { ...existing, ...row, before: existing.status };
  }
  const { data: eng } = await admin.from("engagements").select("client_id").eq("id", engagementId).maybeSingle();
  if (!eng) return null;
  const { data } = await admin.from("invoices").insert({ ...row, engagement_id: engagementId, client_id: eng.client_id, kind: ["deposit", "milestone", "retainer", "one_off"].includes(inv.metadata?.kind) ? inv.metadata.kind : "one_off", description: inv.description ?? null }).select("id, engagement_id, status, description").single();
  return data ? { ...data, before: null } : null;
}

const adminLink = (engagementId: string) => `${SITE_URL}/portal/admin.html#engagement=${engagementId}/billing`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return json({ error: "STRIPE_WEBHOOK_SECRET is not set" }, 500);
  const raw = await req.text();
  let event;
  try {
    event = await verifyWebhook(raw, req.headers.get("Stripe-Signature"), secret);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  // Applied already? A retried delivery is acknowledged and skipped.
  const { error: dupErr } = await admin.from("stripe_events").insert({ id: event.id, type: event.type });
  if (dupErr) {
    if (dupErr.code === "23505") return json({ received: true, duplicate: true });
    console.error("stripe_events insert:", dupErr.message);
    return json({ error: "Could not record the event" }, 500); // Stripe will retry
  }

  try {
    const obj = event.data.object as Inv;
    switch (event.type) {
      case "invoice.finalized":
      case "invoice.sent":
      case "invoice.updated":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        const r = await upsertInvoice(obj);
        if (r && event.type === "invoice.marked_uncollectible") await logActivity(r.engagement_id, null, "invoice_uncollectible", { title: r.description, number: obj.number });
        break;
      }
      case "invoice.paid": {
        const r = await upsertInvoice(obj);
        if (r && r.before !== "paid") {
          await logActivity(r.engagement_id, null, "invoice_paid", { title: r.description, number: obj.number, amount: obj.amount_paid });
          await sendEmail(ADMIN_EMAIL, `Paid: invoice ${obj.number ?? ""} (${money(obj.amount_paid, obj.currency)})`,
            layout("An invoice was paid", `<p><strong>${escapeHtml(r.description ?? "")}</strong>, invoice ${escapeHtml(obj.number ?? "")}: ${money(obj.amount_paid, obj.currency)} paid${obj.total_taxes?.length ? `, including ${money(obj.total_taxes.reduce((a: number, t: { amount: number }) => a + t.amount, 0), obj.currency)} of sales tax` : ""}.</p><p>A bank (ACH) payment can take a few business days to settle after it shows as paid.</p>`,
              { label: "Open the engagement", url: adminLink(r.engagement_id) }));
        }
        break;
      }
      case "invoice.payment_failed": {
        const r = await upsertInvoice(obj);
        if (r) {
          await admin.from("invoices").update({ last_payment_error: "A payment attempt failed" }).eq("id", r.id);
          await logActivity(r.engagement_id, null, "invoice_payment_failed", { title: r.description, number: obj.number });
          await sendEmail(ADMIN_EMAIL, `Payment failed: invoice ${obj.number ?? ""}`,
            layout("A payment attempt failed", `<p><strong>${escapeHtml(r.description ?? "")}</strong>, invoice ${escapeHtml(obj.number ?? "")}, ${money(obj.amount_due, obj.currency)}. The invoice stays open and the client can try again from the link in their email or their Billing tab.</p>`,
              { label: "Open the engagement", url: adminLink(r.engagement_id) }));
        }
        break;
      }
      case "charge.refunded": {
        // A charge doesn't name its invoice; the invoice's payment record does. Find it by the
        // charge's PaymentIntent, then re-read the invoice and record the refund.
        const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
        const pays = pi ? await stripe<{ data: { invoice: string }[] }>("GET", "/invoice_payments", { payment: { type: "payment_intent", payment_intent: pi }, limit: 1 }) : { data: [] };
        const invoiceId = pays.data[0]?.invoice ?? null;
        if (invoiceId) {
          const inv = await stripe<Inv>("GET", `/invoices/${invoiceId}`);
          const r = await upsertInvoice(inv);
          if (r) {
            await admin.from("invoices").update({ refunded: obj.amount_refunded ?? 0 }).eq("id", r.id);
            await logActivity(r.engagement_id, null, "invoice_refunded", { title: r.description, number: inv.number, amount: obj.amount_refunded });
          }
        }
        break;
      }
      case "credit_note.created": {
        const inv = await stripe<Inv>("GET", `/invoices/${obj.invoice}`);
        const r = await upsertInvoice(inv);
        if (r) {
          await admin.from("invoices").update({ credited: inv.post_payment_credit_notes_amount ?? 0 }).eq("id", r.id);
          await logActivity(r.engagement_id, null, "invoice_credited", { title: r.description, number: inv.number, amount: obj.amount });
        }
        break;
      }
      case "cash_balance.funds_available": {
        // A bank transfer arrived that Stripe couldn't match to an invoice: it waits in the customer's
        // cash balance until someone applies it (Dashboard → the customer → Cash balance).
        await sendEmail(ADMIN_EMAIL, "A bank transfer needs matching to an invoice",
          layout("Unmatched bank transfer", `<p>A customer's bank transfer is sitting in their Stripe cash balance because its amount or reference didn't match an open invoice exactly. Open the customer in the Stripe Dashboard and apply the funds to the right invoice.</p><p>Customer: ${escapeHtml(String(obj.customer ?? ""))}</p>`));
        break;
      }
      default:
        break; // subscribed by mistake, or a type this handler ignores: acknowledged
    }
    return json({ received: true });
  } catch (err) {
    // Let Stripe retry: forget the event so the retry is applied.
    await admin.from("stripe_events").delete().eq("id", event.id);
    console.error(err instanceof StripeError ? `Stripe ${err.status}: ${err.message}` : err);
    return json({ error: "Handler failed" }, 500);
  }
});
