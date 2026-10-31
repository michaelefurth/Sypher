// Client Portal configuration.
//
// The Supabase project behind the portal, the diagnostic and proposals
// ("Sypher Client Portal", Project Settings → API). The anon key is designed
// to be public; row level security protects the data. Never put the
// service-role key here. See docs/client-portal.md for the full setup.
export const SUPABASE_URL = "https://pswzqwmluigojvizvfdc.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzd3pxd21sdWlnb2p2aXp2ZmRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MzM2OTQsImV4cCI6MjEwOTAwOTY5NH0.ryC_NuXNSYAZnvXFH4OTbY_q71Uqd1xXByQnbqKrIKg";

export const ADMIN_CONTACT = {
  name: "Michael Furth",
  title: "Managing Principal",
  email: "michael@sypher.solutions",
  // Optional. Shown in each client's room when set.
  phone: "",            // a direct line, e.g. "(505) 555-0100"
  response_promise: "", // e.g. "Every message answered by Michael within one business day."
};
