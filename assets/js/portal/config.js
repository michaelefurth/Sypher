// Client Portal configuration.
//
// Leave both values empty to run the portal in DEMO MODE: fictional sample
// data stored only in this browser, so the experience can be previewed safely.
//
// To go live, create a Supabase project and paste its Project URL and
// publishable/anon key below (Supabase dashboard → Project Settings → API).
// The anon key is designed to be public; row level security protects the data.
// See docs/client-portal.md for the full setup.
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

export const ADMIN_CONTACT = {
  name: "Michael Furth",
  title: "Managing Principal",
  email: "michael@sypher.solutions",
  // Optional. Shown in each client's room when set.
  phone: "",            // a direct line, e.g. "(505) 555-0100"
  response_promise: "", // e.g. "Every message answered by Michael within one business day."
};
