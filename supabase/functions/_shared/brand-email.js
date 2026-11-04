// Sypher Solutions brand email shell, shared by the edge functions (via email.ts) and by the
// Supabase sign-in emails (supabase/templates/auth-emails.mjs). Plain JavaScript so Node and
// Deno can both import it.
//
// Every argument is inserted as-is: callers escape their own text. The sign-in templates pass
// Supabase template tags such as {{ .ConfirmationURL }}, which must reach Supabase untouched.
//
// Email-client rules followed here: tables for layout, inline styles, web-safe fonts (Georgia
// stands in for Cormorant, Arial for Jost), a bulletproof button, a light-only colour scheme,
// and images hosted on the website with alt text and fixed sizes.

const SITE = "https://sypher.solutions";
const IMG = `${SITE}/assets/img/email`;

const C = {
  navy: "#0B2D3B",
  paper: "#FDFBF7",
  stone: "#EAE6DF",
  hairline: "#D9D3C8",
  champagne: "#D4B483",
  gold: "#E8C98F",
  bronze: "#85663A",
  teal: "#1E7F7A",
  ink: "#3C4852",
  muted: "#6B7780",
  onDarkMuted: "#A9B8BE",
};

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Arial,Helvetica,sans-serif";

/** A pill button that renders in Outlook as well as webmail. */
export function button(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 6px"><tr>
<td bgcolor="${C.navy}" style="border-radius:999px">
<a href="${url}" target="_blank" style="display:inline-block;padding:16px 32px;font:bold 12px/1 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.paper};text-decoration:none;border-radius:999px">${label}</a>
</td></tr></table>`;
}

/** A one-time code, set large with room between the digits. */
export function codeBlock(intro, code) {
  return `<p style="margin:26px 0 8px;font:14px/1.5 ${SANS};color:${C.muted}">${intro}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${C.stone}" style="padding:14px 24px;border:1px solid ${C.hairline};font:bold 30px/1 ${SERIF};letter-spacing:8px;color:${C.navy}">${code}</td>
</tr></table>`;
}

/** The address to paste if the button doesn't work. */
export function fallbackLink(url) {
  return `<p style="margin:22px 0 0;font:13px/1.55 ${SANS};color:${C.muted}">If the button doesn't work, copy this address into your browser:<br>
<a href="${url}" style="color:${C.teal};word-break:break-all">${url}</a></p>`;
}

const signoffRow = `<tr><td class="px" style="padding:6px 48px 34px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" width="56"><img src="${IMG}/michael-furth-signature.png" width="56" height="56" alt="Michael Furth" style="display:block;border:0;border-radius:50%"></td>
<td valign="middle" style="padding-left:14px">
<div style="font:17px/1.3 ${SERIF};color:${C.navy}">Michael Furth</div>
<div style="font:11px/1.6 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${C.bronze}">Managing Principal</div>
</td></tr></table>
</td></tr>`;

/**
 * The full email.
 * @param {object} o
 * @param {string} o.heading   the headline (escaped)
 * @param {string} o.body      body HTML (paragraphs, button, code block)
 * @param {string} [o.preheader]  the inbox preview line (escaped)
 * @param {string} [o.note]    small print under the body: expiry, "if this wasn't you" (HTML)
 * @param {boolean} [o.signoff] add Michael's name and photo
 */
export function emailShell({ heading, body, preheader = "", note = "", signoff = false }) {
  const pad = "&#847;&zwnj;&nbsp;".repeat(40);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${heading}</title>
<style>
  @media (max-width:620px) {
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:26px !important; }
    .hide-sm { display:none !important; }
  }
  a { color:${C.teal}; }
</style>
</head>
<body style="margin:0;padding:0;background:${C.stone};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${preheader}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.stone}" style="background:${C.stone}">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" style="width:100%;max-width:600px;background:${C.paper}">

<tr><td class="px" bgcolor="${C.navy}" style="background:${C.navy};padding:22px 48px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" width="44"><a href="${SITE}" style="text-decoration:none"><img src="${IMG}/sypher-emblem-signature.png" width="40" height="41" alt="Sypher Solutions" style="display:block;border:0"></a></td>
<td valign="middle" style="padding-left:14px">
<div style="font:20px/1 ${SERIF};letter-spacing:5px;color:${C.gold}">SYPHER</div>
<div style="font:9px/1 ${SANS};letter-spacing:5px;color:${C.champagne};padding-top:7px">SOLUTIONS</div>
</td>
<td class="hide-sm" align="right" valign="middle" style="font:10px/1 ${SANS};letter-spacing:3px;text-transform:uppercase;color:${C.onDarkMuted}">Client portal</td>
</tr></table>
</td></tr>
<tr><td height="3" bgcolor="${C.champagne}" style="height:3px;line-height:3px;font-size:0;background:${C.champagne};background-image:linear-gradient(90deg,${C.teal},${C.champagne})">&nbsp;</td></tr>

<tr><td class="px" style="padding:44px 48px 10px;font:16px/1.65 ${SERIF};color:${C.ink}">
<h1 class="h1" style="margin:0 0 18px;font:normal 30px/1.2 ${SERIF};color:${C.navy}">${heading}</h1>
${body}
</td></tr>
${note ? `<tr><td class="px" style="padding:22px 48px ${signoff ? "26px" : "38px"}"><p style="margin:0;padding-top:18px;border-top:1px solid ${C.stone};font:13px/1.6 ${SANS};color:${C.muted}">${note}</p></td></tr>` : `<tr><td style="height:28px;font-size:0;line-height:0">&nbsp;</td></tr>`}
${signoff ? signoffRow : ""}
<tr><td class="px" bgcolor="${C.navy}" style="background:${C.navy};padding:24px 48px;font:12px/1.7 ${SANS};color:${C.onDarkMuted}">
<span style="font:italic 15px/1.4 ${SERIF};color:${C.gold}">Decoding complexity. Revealing solutions.</span><br>
Sypher Solutions &middot; Principal-led advisory &middot; <a href="${SITE}" style="color:${C.onDarkMuted};text-decoration:underline">sypher.solutions</a><br>
Questions? <a href="mailto:michael@sypher.solutions" style="color:${C.onDarkMuted};text-decoration:underline">michael@sypher.solutions</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
