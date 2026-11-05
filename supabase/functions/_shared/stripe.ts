// Stripe over its REST API, with no SDK: form-encoded requests, idempotency keys on every
// write, and webhook signature verification. Keys live only in function secrets:
//   STRIPE_SECRET_KEY      sk_test_… while testing, sk_live_… (or a restricted key) in production
//   STRIPE_WEBHOOK_SECRET  whsec_… for the stripe-webhook endpoint
// Requests use the account's default API version, so webhook payloads and responses match.

const API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly type?: string) { super(message); }
}

/** Stripe's form encoding: nested objects as a[b]=c, arrays as a[0]=x, booleans as "true"/"false". */
export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(prefix ? `${prefix}[${k}]` : k, v);
  return parts.join("&");
}

export function stripeConfigured(): boolean {
  return !!Deno.env.get("STRIPE_SECRET_KEY");
}

/**
 * Call the Stripe API. `idempotencyKey` makes a retried write safe: Stripe returns the first
 * result instead of doing the work twice. Use a key derived from the portal's own request.
 */
export async function stripe<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string,
  params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new StripeError("Stripe isn't configured: set STRIPE_SECRET_KEY in the function secrets.", 500);
  const body = formEncode(params);
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey && method === "POST") headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: string; type?: string } }).error ?? {};
    throw new StripeError(e.message ?? `Stripe error ${res.status}`, res.status, e.code, e.type);
  }
  return data as T;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Compare two strings in time that doesn't depend on where they differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a webhook's Stripe-Signature header (t=…,v1=…) against the raw body: HMAC-SHA256 of
 * "t.body" with the endpoint secret, within `toleranceSec` of now. Returns the parsed event.
 */
export async function verifyWebhook(rawBody: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()) {
  if (!header) throw new StripeError("Missing Stripe-Signature header", 400);
  const fields = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = fields.find(([k]) => k === "t")?.[1];
  const sigs = fields.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) throw new StripeError("Malformed Stripe-Signature header", 400);
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new StripeError("Webhook timestamp outside the tolerance", 400);
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${t}.${rawBody}`)));
  if (!sigs.some((s) => safeEqual(s, expected))) throw new StripeError("Webhook signature doesn't match", 400);
  return JSON.parse(rawBody) as { id: string; type: string; data: { object: Record<string, unknown> }; livemode: boolean };
}

/** The columns of public.invoices, from a Stripe invoice object. */
export function invoiceRow(inv: Record<string, any>) {
  const ts = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
  return {
    stripe_invoice_id: inv.id,
    number: inv.number ?? null,
    status: inv.status ?? "draft",
    currency: inv.currency ?? "usd",
    subtotal: inv.subtotal ?? null,
    tax: (inv.total_taxes ?? []).reduce((a: number, t: { amount: number }) => a + (t.amount ?? 0), 0) || inv.tax || 0,
    total: inv.total ?? null,
    amount_due: inv.amount_due ?? null,
    amount_paid: inv.amount_paid ?? null,
    amount_remaining: inv.amount_remaining ?? null,
    due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : null,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    finalized_at: ts(inv.status_transitions?.finalized_at),
    paid_at: ts(inv.status_transitions?.paid_at),
    updated_at: new Date().toISOString(),
  };
}
