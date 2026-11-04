// Public sample: an illustrative feasibility study for a fictional business, in the Sypher
// document design. Published on the website (assets/docs/sample-feasibility-report.pdf).
// Every name and figure here is invented. Build with:
//   node documents/build.mjs documents/samples/juniper-vine.mjs assets/docs/sample-feasibility-report.pdf
import { doc, chapter, two, kicker, p, list, stats, table, badge, callout, points, bars, note, questions } from "../kit/components.mjs";

const toc = [
  { id: "summary", num: two(1), title: "Executive summary", desc: "Six questions, six verdicts, and what decides it" },
  { id: "market", num: two(2), title: "Market and site", desc: "Trade-area demand, the corner site and the lease" },
  { id: "model", num: two(3), title: "The model", desc: "Cost to open, three-year results and break-even" },
  { id: "plan", num: two(4), title: "Recommended plan and decision gates", desc: "Funding, gates and the open questions ranked by impact" },
];

const summary = chapter({
  id: "summary", num: two(1), kicker: "Bottom line", title: "Executive summary",
  lede: "On the inputs as given, a second Juniper &amp; Vine is feasible with conditions. The neighbourhood has the demand and the first store's numbers travel, but the lease as offered pushes break-even past Month 24. With a larger tenant allowance and a staged opening, break-even comes at Month 19.",
  body: `
${stats([
    { value: "$1.18m", label: "all-in cost to open, including working capital", tone: "rust" },
    { value: "$287k", label: "Year 3 EBITDA on $2.05m revenue (14.0%)", tone: "teal" },
    { value: "6%", label: "of trade-area café and grocery spend needed in Year 1", tone: "navy" },
    { value: "Month 19", label: "cash break-even with the recommended lease", tone: "bronze" },
  ])}
${kicker("Six questions, six verdicts")}
${table({
    head: ["Question", "Finding", "Verdict"], widths: ["31%", "43%", "26%"],
    rows: [
      [{ v: "Is there demand?", c: "q" }, "The plan needs about 6% of estimated café and specialty grocery spend within a ten-minute drive in Year 1, and 8% by Year 3.", badge("Yes", "yes", "Yes. Strongest at breakfast and weekends")],
      [{ v: "Does the site work?", c: "q" }, "Corner frontage, 28 shared spaces and an existing grease trap. The offered allowance of $35 per SF covers about half the build-out.", badge("Yes, if", "if", "Yes, at $60 per SF allowance or a rent-free fit-out period")],
      [{ v: "Do the unit economics work?", c: "q" }, "Year 3 EBITDA of $287k on $2.05m revenue (14.0%), against 16.1% at the first store.", badge("Yes", "yes", "Yes, with prep shared across both stores")],
      [{ v: "Is the financing feasible?", c: "q" }, "$450k of owner equity plus a $730k SBA 7(a) loan covers the cost to open with a $90k reserve.", badge("Yes, if", "if", "Yes, if the reserve is held until Month 12")],
      [{ v: "Can the first store carry the ramp alone?", c: "q" }, "Store 1 generates about $16k a month of free cash; the ramp consumes up to $31k a month in Months 2 to 7.", badge("No", "no", "No. The reserve has to carry it")],
      [{ v: "Should the commissary come first?", c: "q" }, "A shared prep kitchen saves about $6 per $100 of sales, but only above roughly $3.2m of combined revenue.", badge("Yes, if", "if", "Yes, on a volume trigger, not at opening")],
    ],
  })}
${kicker("What decides it")}
${points([
    "<strong>The lease.</strong> Every $5 per SF of tenant allowance moves break-even by about one month. At the offered $35 per SF the store breaks even in Month 25; at $60 per SF, in Month 19.",
    "<strong>Weekday lunch.</strong> The model assumes 140 lunch covers a day by Month 6, against 165 at the first store. Each 10 covers is worth about $26k a year of EBITDA.",
    "<strong>The manager.</strong> The first store's results trace to an owner on site six days a week. The second store needs a general manager hired before construction ends.",
  ])}
`,
});

const market = chapter({
  id: "market", num: two(2), kicker: "Demand and site", title: "Market and site",
  lede: "The trade area can absorb a second store. The open question is the lease, not the demand.",
  body: `
${p("<strong>Trade-area spend (our estimate).</strong> About 31,000 households live within a ten-minute drive of the proposed corner. Applying regional café, bakery and specialty grocery spend per household gives roughly $24m to $27m a year. The plan needs $1.4m of that in Year 1 and $2.05m by Year 3.")}
${bars({
    title: "A second store needs a small share of local spend",
    sub: "Planned café and grocery sales against estimated trade-area spend",
    rows: [
      { label: "Year 1 plan", sub: "$1.4m of sales", value: 6, display: "about 6%" },
      { label: "Year 3 plan", sub: "$2.05m of sales", value: 8, display: "about 8%" },
      { label: "First store today", sub: "its own trade area", value: 9, display: "about 9%", tone: "navy" },
    ],
    max: 100,
    note: "Full bar: about $25m a year of café, bakery and specialty grocery spend within a ten-minute drive. Illustrative figures.",
  })}
${kicker("The site")}
${table({
    head: ["Item", "Detail", "Effect"], widths: ["24%", "44%", "32%"], align: ["lead"],
    rows: [
      ["Space", "2,850 SF end-cap with corner glazing; 28 shared parking spaces", "Fits the first store's layout with 12 more seats"],
      ["Rent", "$26 per SF base plus $7 common area charges, five years with two options", "In line with the area; escalations of 3% a year"],
      ["Tenant allowance", "$35 per SF offered", "Covers about half the build-out; ask for $60"],
      ["Kitchen", "Existing grease trap and hood chase from a former bakery", "Saves an estimated $45k to $60k"],
      ["Neighbours", "Pharmacy, fitness studio, two dentists", "Morning and lunch traffic; quiet evenings"],
    ],
  })}
${callout("What to negotiate", "Ask for a $60 per SF allowance, or $45 per SF plus four months of free rent during fit-out. Either one brings break-even inside two years.", "gold")}
`,
});

const model = chapter({
  id: "model", num: two(3), kicker: "Cost and results", title: "The model",
  lede: "The store costs about $1.18m to open and reaches $287k of EBITDA in Year 3. Cash break-even falls between Month 19 and Month 25, depending on the lease.",
  body: `
${bars({
    title: "Cost to open: $1.18m",
    sub: "Base case, building on the existing kitchen services",
    waterfall: true,
    max: 1180,
    rows: [
      { label: "Build-out", value: 520, offset: 0, display: "$520k", tone: "navy" },
      { label: "Kitchen and bar equipment", value: 310, offset: 520, display: "$310k" },
      { label: "Design, permits and fees", value: 140, offset: 830, display: "$140k", tone: "teal-light" },
      { label: "Pre-opening and working capital", value: 210, offset: 970, display: "$210k", tone: "gold" },
    ],
    note: "Before the tenant allowance. At $35 per SF the landlord funds about $100k; at $60 per SF, about $171k.",
  })}
${table({
    title: "Three-year results, recommended case",
    head: ["", "Year 1", "Year 2", "Year 3"], align: ["lead", "r", "r", "r"],
    rows: [
      ["Revenue", "$1,420,000", "$1,860,000", "$2,050,000"],
      ["Food and beverage cost", "$454,400", "$576,600", "$625,300"],
      ["Labour", "$511,200", "$613,800", "$656,000"],
      ["Occupancy", "$113,000", "$116,400", "$119,900"],
      ["Other operating costs", "$255,600", "$334,800", "$361,800"],
      ["EBITDA", "$85,800", "$218,400", "$287,000"],
      ["Debt service ($730k, 10 years)", "$98,500", "$98,500", "$98,500"],
      ["Free cash after debt service", "($12,700)", "$119,900", "$188,500"],
    ],
    rowClass: { 5: "sub", 7: "total" },
    note: "Illustrative figures. Year 1 is negative after debt service, which is why the $90k reserve is held until Month 12.",
  })}
`,
});

const plan = chapter({
  id: "plan", num: two(4), kicker: "The plan", title: "Recommended plan and decision gates",
  lede: "Fund the store with $450k of owner equity and a $730k SBA 7(a) loan, hold $90k in reserve until Month 12, and release spending in three gates.",
  body: `
${table({
    head: ["Gate", "Release", "Evidence required"], widths: ["18%", "30%", "52%"], align: ["lead"],
    rows: [
      ["Gate 1", "Sign the lease", "A tenant allowance of $60 per SF, or $45 per SF with four months of free rent; a general manager candidate identified"],
      ["Gate 2", "Start construction", "Contractor bid within 5% of $520k; SBA commitment letter; general manager hired"],
      ["Gate 3", "Add the commissary", "Combined sales above $3.2m a year for three months running"],
    ],
  })}
${kicker("Open questions, ranked by impact")}
${questions([
    "<strong>B4.</strong> Will the landlord fund $60 per SF, or $45 per SF with free rent? (moves break-even by up to six months)",
    "<strong>C2.</strong> What do the first store's weekday lunch covers look like by month for the last two years?",
    "<strong>A7.</strong> Who runs the second store day to day, and what would they be paid?",
    "<strong>E1.</strong> Does the existing hood chase meet current code, or does it need replacing?",
    "<strong>D3.</strong> Will the supplier extend the first store's terms and pricing to both stores?",
    "<strong>B9.</strong> How much catering demand does the first store turn away today?",
  ])}
${note("Illustrative sample prepared to show the format of a Sypher Solutions feasibility report. The business, the site and every figure are fictional.")}
`,
});

export default doc({
  title: "Juniper &amp;<br>Vine Provisions",
  short: "Juniper &amp; Vine",
  docType: "Feasibility study",
  date: "Illustrative sample",
  kicker: "Café and specialty grocery · A second location",
  subtitle: "Second location feasibility study",
  lede: "Feasible with conditions. The demand is there; the lease decides the timing. A larger tenant allowance and a staged opening bring break-even to Month 19.",
  coverStats: [
    { value: "$1.18m", label: "all-in cost to open the second store" },
    { value: "Month 19", label: "cash break-even with the recommended lease" },
    { value: "$287k", label: "Year 3 EBITDA on $2.05m revenue" },
  ],
  longTitle: true,
  toc,
  body: [summary, market, model, plan],
  disclaimer: "Illustrative sample. The business, the site and every figure in this report are fictional, and it is not advice of any kind. It shows the format of a Sypher Solutions feasibility report.",
  titleMeta: "Sample feasibility report: Juniper & Vine Provisions (illustrative)",
});
