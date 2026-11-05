// deno test supabase/functions/_shared/agent_test.ts
import { fileType, fromBase64, keyMatches, safeName } from "./agent.ts";

const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const KEY = "k".repeat(16) + "0123456789abcdef0123";

Deno.test("only the exact configured key is accepted, and a short configured key switches it off", () => {
  assert(keyMatches(KEY, KEY), "exact key");
  assert(!keyMatches(KEY + "x", KEY) && !keyMatches(KEY.slice(0, -1), KEY), "longer or shorter keys fail");
  assert(!keyMatches(KEY.replace(/.$/, "x"), KEY), "one character off fails");
  assert(!keyMatches(null, KEY) && !keyMatches("", KEY), "missing key fails");
  assert(!keyMatches("short", "short") && !keyMatches(KEY, undefined), "a short or unset configured key accepts nothing");
});

Deno.test("only the portal's file types are accepted", () => {
  assert(fileType("Review.PDF") === "application/pdf", "pdf, any case");
  assert(fileType("Lease.docx")?.includes("wordprocessingml"), "docx");
  assert(fileType("run.exe") === null && fileType("page.html") === null && fileType("pdf") === null, "others refused");
});

Deno.test("file names are made safe for a storage path", () => {
  assert(safeName("Islas Review (final).pdf") === "Islas_Review_final_.pdf", safeName("Islas Review (final).pdf"));
  assert(!safeName("../../etc/passwd").includes("/"), "no slashes survive");
});

Deno.test("base64 decodes, and anything else is refused", () => {
  const b = fromBase64(btoa("%PDF-1.7 hello"));
  assert(b && new TextDecoder().decode(b) === "%PDF-1.7 hello", "round trip");
  assert(fromBase64("JVBERi0xLjc") !== null, "missing padding is fine");
  assert(fromBase64("not base64!*") === null, "garbage refused");
});
