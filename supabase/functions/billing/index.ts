// POST { action, ... }   (signed in)
//
// Invoices for an engagement, sent through Stripe with Stripe Tax:
//   create_invoice  (admin)  { engagement_id, kind, description?, lines: [{ description, amount_cents, tax_code? }],
//                             days_until_due?, proposal_id?, request_id }
//                   Makes sure the client is a Stripe customer with a billing address, creates the invoice
//                   (send_invoice, automatic tax, metadata linking it to the engagement), adds the lines,
//                   finalizes it and has Stripe email it. Returns the portal's invoice row with the hosted page link.
//   save_address    (admin, or the client for themself) { client_id?, billing_name, billing_email, line1, line2?, city, state, postal_code, country? }
//   void_invoice    (admin)  { invoice_id }      an open invoice the client should no longer pay
//   sync_invoice    (admin)  { invoice_id }      re-read from Stripe (if a webhook was missed)
//
// `request_id` (a UUID the page generates once per form) makes create_invoice safe to retry: every
// Stripe write uses an idempotency key derived from it, so a double click never bills twice.
import { json, preflight } from "../_shared/http.ts";
import { admin, getCaller, logActivity } from "../_shared/supabase.ts";
import { invoiceRow, stripe, stripeConfigured, StripeError } from "../_shared/stripe.ts";

/** Stripe tax codes the portal offers: consulting by default; accounting for bookkeeping and forensic work. */
const TAX_CODES = new Set(["txcd_20060048", "txcd_20060001", "txcd_20030000"]);
const KINDS = new Set(["deposit", "milestone", "retainer", "one_off"]);
const UUID = /^[0-9a-f-]{36}$/i;

type Profile = { client_id: string; stripe_customer_id: string | null; billing_name: string | null; billing_email: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; postal_code: string | null; country: string };
const addressOf = (p: Profile) => ({ line1: p.line1, line2: p.line2 || undefined, city: p.city, state: p.state, postal_code: p.postal_code, country: p.country || "US" });
const hasAddress = (p: Profile | null) => !!(p && p.line1 && p.city && p.state && p.postal_code);

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in first" }, 401);
  const body = await req.json().catch(() => ({}));
  const isAdmin = caller.role === "admin";

  try {
    if (body.action === "save_address") {
      const clientId = isAdmin ? body.client_id : caller.id;
      if (typeof clientId !== "string" || !UUID.test(clientId)) return json({ error: "client_id is required" }, 400);
      const s = (k: string, max = 200) => (typeof body[k] === "string" ? body[k].trim().slice(0, max) : "") || null;
      const row = { client_id: clientId, billing_name: s("billing_name"), billing_email: s("billing_email"), line1: s("line1"), line2: s("line2"), city: s("city", 100), state: s("state", 50), postal_code: s("postal_code", 20), country: (s("country", 2) || "US").toUpperCase(), updated_at: new Date().toISOString() };
      if (!row.line1 || !row.city || !row.state || !row.postal_code) return json({ error: "Street, city, state and ZIP code are needed: Stripe uses them to work out sales tax." }, 400);
      const { data: existing } = await admin.from("billing_profiles").select("stripe_customer_id").eq("client_id", clientId).maybeSingle();
      const { error } = await admin.from("billing_profiles").upsert(row);
      if (error) throw error;
      if (existing?.stripe_customer_id && stripeConfigured()) {
        await stripe("POST", `/customers/${existing.stripe_customer_id}`, { name: row.billing_name ?? undefined, email: row.billing_email ?? undefined, address: addressOf({ ...row, stripe_customer_id: null } as Profile) });
      }
      return json({ ok: true });
    }

    if (!isAdmin) return json({ error: "Admin only" }, 403);
    if (!stripeConfigured()) return json({ error: "Stripe isn't connected yet: set STRIPE_SECRET_KEY in the Supabase function secrets." }, 503);

    if (body.action === "create_invoice") {
      const { engagement_id, kind = "one_off", description = null, proposal_id = null, request_id } = body;
      const days = Math.min(Math.max(Number(body.days_until_due) || 15, 0), 90);
      if (typeof engagement_id !== "string" || !UUID.test(engagement_id)) return json({ error: "engagement_id is required" }, 400);
      if (typeof request_id !== "string" || !UUID.test(request_id)) return json({ error: "request_id is required" }, 400);
      if (!KINDS.has(kind)) return json({ error: "Unknown invoice kind" }, 400);
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (!lines.length || lines.length > 20) return json({ error: "Add between one and twenty lines" }, 400);
      for (const l of lines) {
        if (!l || typeof l.description !== "string" || !l.description.trim()) return json({ error: "Every line needs a description" }, 400);
        if (!Number.isInteger(l.amount_cents) || l.amount_cents <= 0) return json({ error: "Every line needs an amount above zero" }, 400);
        if (l.tax_code && !TAX_CODES.has(l.tax_code)) return json({ error: "Unknown tax code" }, 400);
      }

      const { data: eng } = await admin.from("engagements").select("id, title, client_id, profiles:client_id (full_name, email, company)").eq("id", engagement_id).single();
      if (!eng) return json({ error: "Engagement not found" }, 404);
      const client = eng.profiles as unknown as { full_name: string | null; email: string; company: string | null };
      const { data: prof } = await admin.from("billing_profiles").select("*").eq("client_id", eng.client_id).maybeSingle();
      if (!hasAddress(prof as Profile | null)) return json({ error: "Add the client's billing address first (Billing tab): Stripe Tax needs it to work out sales tax." }, 400);
      const p = prof as Profile;

      // 1. The Stripe customer, created once per client.
      let customerId = p.stripe_customer_id;
      if (!customerId) {
        const c = await stripe<{ id: string }>("POST", "/customers", {
          name: p.billing_name || client.company || client.full_name || client.email,
          email: p.billing_email || client.email,
          address: addressOf(p),
          tax: { validate_location: "immediately" },
          metadata: { client_id: eng.client_id },
        }, `customer-${request_id}`);
        customerId = c.id;
        await admin.from("billing_profiles").update({ stripe_customer_id: customerId }).eq("client_id", eng.client_id);
      }

      // 2. A draft invoice, linked to the engagement by metadata (it rides along in every webhook).
      const meta = { engagement_id, kind, proposal_id: proposal_id ?? "", portal_request: request_id };
      const inv = await stripe<{ id: string }>("POST", "/invoices", {
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: days,
        auto_advance: true,
        automatic_tax: { enabled: true },
        pending_invoice_items_behavior: "exclude",
        description: description || `${eng.title}`,
        footer: "Sypher Solutions · El Paso, Texas · Questions: michael@sypher.solutions",
        metadata: meta,
      }, `invoice-${request_id}`);
      const { data: row, error: insErr } = await admin.from("invoices").upsert({
        engagement_id, client_id: eng.client_id, proposal_id: proposal_id && UUID.test(proposal_id) ? proposal_id : null,
        stripe_invoice_id: inv.id, kind, description: description || eng.title, created_by: caller.id, status: "draft",
      }, { onConflict: "stripe_invoice_id" }).select().single();
      if (insErr) throw insErr;

      // 3. The lines, each with its tax code; prices are exclusive of tax, so tax is added on top.
      // If anything from here on fails, the draft is deleted so nothing half-made is left behind.
      try {
      for (const [i, l] of lines.entries()) {
        await stripe("POST", "/invoiceitems", {
          customer: customerId, invoice: inv.id, currency: "usd", amount: l.amount_cents,
          description: l.description.trim().slice(0, 500), tax_code: l.tax_code || "txcd_20060048", tax_behavior: "exclusive",
          metadata: { engagement_id },
        }, `item-${request_id}-${i}`);
      }

      // 4. Finalize (tax is calculated here) and email it with the hosted payment page.
      await stripe("POST", `/invoices/${inv.id}/finalize`, { auto_advance: true }, `finalize-${request_id}`);
      } catch (err) {
        await stripe("DELETE", `/invoices/${inv.id}`).catch(() => {});
        await admin.from("invoices").delete().eq("id", row.id);
        throw err;
      }
      const sent = await stripe<Record<string, unknown>>("POST", `/invoices/${inv.id}/send`, {}, `send-${request_id}`);
      const { data: final } = await admin.from("invoices").update(invoiceRow(sent)).eq("id", row.id).select().single();
      await logActivity(engagement_id, caller.id, "invoice_sent", { title: description || eng.title, invoice_id: row.id, number: (sent as { number?: string }).number, total: (sent as { total?: number }).total });
      return json({ invoice: final });
    }

    if (body.action === "void_invoice" || body.action === "sync_invoice") {
      const { data: row } = await admin.from("invoices").select("id, stripe_invoice_id, engagement_id, description").eq("id", body.invoice_id).maybeSingle();
      if (!row) return json({ error: "Invoice not found" }, 404);
      const inv = body.action === "void_invoice"
        ? await stripe<Record<string, unknown>>("POST", `/invoices/${row.stripe_invoice_id}/void`, {}, `void-${row.id}`)
        : await stripe<Record<string, unknown>>("GET", `/invoices/${row.stripe_invoice_id}`);
      const { data: updated } = await admin.from("invoices").update(invoiceRow(inv)).eq("id", row.id).select().single();
      if (body.action === "void_invoice") await logActivity(row.engagement_id, caller.id, "invoice_voided", { title: row.description, invoice_id: row.id });
      return json({ invoice: updated });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    if (err instanceof StripeError) {
      console.error(`Stripe: ${err.status} ${err.code ?? ""} ${err.message}`);
      const msg = err.code === "customer_tax_location_invalid" ? "Stripe couldn't place the billing address for tax: check the street, city, state and ZIP." : err.message;
      return json({ error: msg, code: err.code }, err.status >= 500 ? 502 : 400);
    }
    console.error(err);
    return json({ error: (err as Error).message ?? "Something went wrong" }, 500);
  }
});
