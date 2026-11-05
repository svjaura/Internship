// Builds the Vajaha & Co. site into dist/. No dependencies. Run: node build.mjs
// Env: SITE_HOST (else VERCEL_PROJECT_PRODUCTION_URL), BOOKING_URL (Calendly or Google booking link),
//      PHOTO_PATH (local headshot for offline builds; otherwise it is downloaded from halfpan.app).
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = 'dist';
const HOST = (process.env.SITE_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'vajaha.vercel.app')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '');
const SITE = `https://${HOST}`;
const BOOKING_URL = (process.env.BOOKING_URL || '').trim();
const PHOTO_URL = 'https://halfpan.app/photos/sai-head-900.jpg';
const UPDATED = '2026-11-05';
const UPDATED_TEXT = 'November 5, 2026';

const BRAND = 'Vajaha & Co.';
const ONE_LINER = 'Vajaha & Co. is an AI automation studio in Hoover, Alabama. We build AI tools that take repetitive paperwork off small business teams: forms, quotes, document chasing, reports, inbox sorting and order checks.';
const EMAIL = 'vs.saicharan@gmail.com';
const PHONE = '(205) 207-9977';
const TEL = '+12052079977';
const LINKEDIN = 'https://www.linkedin.com/in/sai-vajaha/';
const HALFPAN = 'https://halfpan.app';
const MAIL_DEMO = `mailto:${EMAIL}?subject=${encodeURIComponent('Free demo for my business')}&body=${encodeURIComponent('Name:\nBusiness:\nWhat my team retypes every week:\nTwo or three times that work for a 15-minute call:\n')}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

// ---------- Content ----------
const SERVICES = [
  {
    slug: 'forms-and-deal-sheets', name: 'Forms and deal sheets',
    short: 'A planner or spreadsheet goes in. Every customer form comes out filled in, split into pages, and checked.',
    q: 'Can AI fill out our customer forms and deal sheets?',
    tldr: 'Yes. We build a tool that reads the planner or spreadsheet your team already keeps and fills in every customer form from it: deal sheets, vendor forms, order forms and new item forms. Each one comes out on the customer’s own template, split into pages where needed, with every number checked against your source files. Your team reviews it and sends it.',
    who: ['Food brokers and distributors filling retailer deal sheets and promo forms', 'Offices that type the same details into several PDFs, portals or spreadsheets', 'Any team that fills the same kind of form for different customers every week'],
    steps: ['You send the source file (a planner, price list or spreadsheet) plus one blank and one filled copy of each form.', 'We map every field on the form to where it comes from in your files, and write down every rule your team follows.', 'The tool fills every form at once, moves long lists onto extra pages, and checks each line.', 'You get the finished forms plus a short list of anything that looked wrong, like a code used twice or a price that does not match.'],
    inputs: ['The spreadsheet or planner you work from', 'A blank copy and a filled copy of each form', 'The rules your team follows, including the ones nobody wrote down'],
    outputs: ['Filled forms in Excel and PDF, on the original templates', 'A check list of anything a person should look at', 'A tool you keep, so new planners turn into forms in minutes'],
    example: ['/work/food-broker-deal-sheets/', 'See the food broker deal sheet demo'],
    faqs: [
      ['Do we have to change our forms or our spreadsheet?', 'No. The tool works with the files and templates you already use. If a customer changes their form, we update the mapping.'],
      ['What happens when the source file has a mistake?', 'The checks flag it before anything is sent. In our deal sheet demo, the checks caught item codes used twice, a UPC typo and costs that did not match the item list.'],
      ['Is this AI or just a script?', 'Both, each where it fits. Code and rules handle the numbers so they are exact. AI helps read messy inputs like emails, PDFs and notes.'],
    ],
  },
  {
    slug: 'quotes-and-estimates', name: 'Quotes and estimates',
    short: 'Photos, notes or a request for quote become a draft quote your team reviews and sends the same day.',
    q: 'Can AI write quotes and estimates for my business?',
    tldr: 'Yes, as a first draft your team approves. We build a tool that turns photos, job notes, measurements or a customer’s request into a draft quote using your prices, your line items and your terms. Your team checks it, adjusts it and sends it the same day instead of later in the week.',
    who: ['Contractors and home service companies quoting jobs from photos and site notes', 'Distributors and suppliers answering requests for quotes', 'Any business where quotes pile up because they take too long to write'],
    steps: ['You send your price list, a few past quotes and the way you like them laid out.', 'We set up your line items, markups, minimums and standard terms.', 'New requests (an email, photos, notes or a web form) become a draft quote in your format.', 'Your team reviews the draft, changes anything it needs, and sends it.'],
    inputs: ['Your price list or rate sheet', 'Three to five past quotes you were happy with', 'Your terms, minimums and anything you always include'],
    outputs: ['Draft quotes in your format, ready to review', 'A running list of open quotes and when to follow up', 'Quotes out the same day instead of days later'],
    faqs: [
      ['Will the AI make up prices?', 'No. Prices come only from your price list and your rules. If something is not on the list, the draft marks it for your team to price.'],
      ['Can it work from photos?', 'It reads photos and notes to draft the scope and line items. A person always confirms quantities and measurements before the quote goes out.'],
      ['Does it work with QuickBooks or our estimating software?', 'Often, yes. We can produce quotes in your current format or as a file your software imports. We confirm what your software accepts during the free demo.'],
    ],
  },
  {
    slug: 'document-collection', name: 'Missing documents',
    short: 'Track what each client still owes you and draft the reminder before anyone has to chase it.',
    q: 'How can AI help collect missing documents from clients?',
    tldr: 'We build a tracker that knows which documents each client still owes you, drafts the reminder for each one, and shows your team which files are stuck. No more spreadsheets of who sent what, and no more chasing from memory. Your team approves reminders before they go out.',
    who: ['Mortgage, lending and insurance offices waiting on client paperwork', 'Accountants and bookkeepers collecting tax documents', 'Property managers and any office with an onboarding checklist'],
    steps: ['You send your checklist for each type of client or file.', 'We set up the tracker so it can see what has come in, from email, a shared folder or your system.', 'Each day it lists what is missing for each client and drafts a short, polite reminder.', 'Your team approves the reminders, and the tracker updates as documents arrive.'],
    inputs: ['Your document checklist for each client type', 'Where documents arrive today (email, a folder or a portal)', 'How you like reminders worded'],
    outputs: ['A daily list of who still owes what', 'Reminder emails drafted for your approval', 'Fewer stalled files and less time spent chasing'],
    faqs: [
      ['Will it email my clients without asking me?', 'No. Reminders are drafted for your team to approve. Later you can choose to auto-send the routine ones.'],
      ['Is client information kept private?', 'Yes. Your files are used only for your project, and client documents stay in the systems you already use.'],
      ['Do my clients need a new portal?', 'No. It works with how documents already reach you, so your clients do not have to learn anything new.'],
    ],
  },
  {
    slug: 'reports-and-recaps', name: 'Reports and recaps',
    short: 'Weekly and monthly reports, client recaps and meeting notes, written from the data you already have.',
    q: 'Can AI write our weekly and monthly reports?',
    tldr: 'Yes. We build a tool that pulls the numbers you already track, builds the weekly or monthly report in your format, and writes a short summary of what changed. Meeting notes and client recaps can be drafted the same way. A person reads it before it goes anywhere.',
    who: ['Managers who spend Monday morning copying numbers into a report', 'Sales teams that send customers a monthly recap', 'Owners who want one clear page instead of five spreadsheets'],
    steps: ['You show us the report you make today and where each number comes from.', 'We connect the sources: spreadsheets, exports, Salesforce or another system.', 'The tool builds the report on schedule and summarizes what changed.', 'You review it and send it, or have it emailed to you every week.'],
    inputs: ['A recent copy of the report', 'Where each number comes from', 'Who gets it and how often'],
    outputs: ['The report, built on schedule in your format', 'A plain summary of what changed and what needs attention', 'Time back every week'],
    example: ['/work/moveshare/', 'See MoveShare, which emails a daily report'],
    faqs: [
      ['Which systems can it pull from?', 'Spreadsheets, Google Sheets, CSV exports and systems with an export or an API, such as Salesforce. MoveShare, for example, pulls moves from Salesforce and emails a daily report.'],
      ['Will the numbers be right?', 'Numbers are calculated with code, not guessed by AI. AI only writes the summary, and the report shows where each number came from.'],
      ['Can it send the report automatically?', 'Yes, once you trust it. Most teams review the first few, then let it send on a schedule.'],
    ],
  },
  {
    slug: 'inbox-sorting', name: 'Inbox sorting',
    short: 'Incoming requests get sorted, the details pulled out, and a reply drafted for your team to approve.',
    q: 'Can AI sort our inbox and draft replies?',
    tldr: 'Yes. We build a tool that reads incoming requests, sorts them by type, pulls out the details (names, order numbers, dates, addresses) and drafts a reply or a task for your team. Your team approves anything before it is sent.',
    who: ['Shared inboxes like info@, orders@ or service@', 'Offices that copy details from emails into another system', 'Teams that lose requests in long email threads'],
    steps: ['You show us the kinds of emails you get and what your team does with each.', 'We set up the categories and the details to pull out of each one.', 'New emails are sorted, their details go into a sheet or your system, and replies are drafted.', 'Your team approves replies and works from one clean list.'],
    inputs: ['Examples of the emails you get', 'What your team does with each type', 'Where the details should end up'],
    outputs: ['Sorted requests with the key details pulled out', 'Draft replies in your tone, ready to approve', 'Nothing slipping through the cracks'],
    faqs: [
      ['Does it read all of our email?', 'No. Only the inbox or labels you choose, and only for your project.'],
      ['Will the replies sound like a robot?', 'Replies are drafted from your past replies and your rules, and your team edits them before they go out.'],
      ['Does it work with Gmail and Outlook?', 'Gmail, yes. For Outlook and Microsoft 365, we confirm the setup with you during the free demo.'],
    ],
  },
  {
    slug: 'order-and-price-checks', name: 'Order and price checks',
    short: 'Orders, invoices and price changes compared against what was agreed, with anything off flagged.',
    q: 'Can AI check orders and invoices against what we agreed?',
    tldr: 'Yes. We build a check that compares orders, invoices and price changes against your agreed prices, deals and item lists, and flags anything that does not match. Your team gets a short list of problems instead of checking every line by hand.',
    who: ['Brokers and distributors checking warehouse orders against deal sheets', 'Restaurants checking vendor invoices against agreed prices', 'Any business that pays or bills from long line-item lists'],
    steps: ['You send your agreed prices or deals, plus a few recent orders or invoices.', 'We set up the matching rules: item codes, units, case packs, dates and allowances.', 'Each new order or invoice is checked line by line.', 'You get a short list of mismatches with the dollar amount on each.'],
    inputs: ['Agreed prices, deals or contracts', 'Recent orders or invoices', 'Your item list with codes and pack sizes'],
    outputs: ['A mismatch list for every order or invoice', 'The dollar amount behind each mismatch', 'Price changes reflected everywhere they need to be'],
    faqs: [
      ['What kinds of files can it check?', 'Spreadsheets, CSV exports and PDFs. PDFs are read with AI and then checked with exact rules. EDI orders can be checked once they are exported to a file.'],
      ['What does it do when it finds a problem?', 'It lists the line, what it expected, what it found and the dollar difference, so your team can fix it with the customer or vendor.'],
      ['Can it handle price increases?', 'Yes. A new price letter can update your item lists and show every open deal or order it affects.'],
    ],
  },
];
const svc = Object.fromEntries(SERVICES.map((s) => [s.slug, s]));

const INDUSTRIES = [
  {
    slug: 'food-brokers-and-distributors', name: 'Food brokers and distributors', title: 'AI for food brokers and distributors',
    tldr: 'Food brokers spend hours moving the same promo and pricing data from each principal’s planner into every retailer’s forms. We build tools that fill every retailer deal sheet from your planner and item list, check every line, and keep item lists current when prices change.',
    work: ['Retailer deal sheets and promotion forms, filled from each principal’s planner', 'Price increase letters that change item lists for every customer', 'New item forms for each retailer', 'Checking warehouse orders against the deal during each deal window'],
    services: ['forms-and-deal-sheets', 'order-and-price-checks', 'reports-and-recaps'],
    proof: ['/work/food-broker-deal-sheets/', 'We built a working demo on real promo files: a full year of promotions turned into every deal sheet in seconds, with checks that caught item codes used twice, a UPC typo and costs that did not match.'],
    faqs: [
      ['Can it use each retailer’s own form?', 'Yes. The tool fills the retailer’s own template, so the sheet looks exactly like the one you send today.'],
      ['What if each principal’s planner is laid out differently?', 'Each planner layout gets its own reader. Once a layout is set up, new planners in that layout run in seconds.'],
    ],
  },
  {
    slug: 'mortgage-and-lending', name: 'Mortgage and lending', title: 'AI for mortgage brokers and lenders',
    tldr: 'Loan files stall on paperwork. We build tools that track which documents each borrower still owes, draft the reminders, and keep your pipeline report current. For past clients, we can build refinance alerts on the borrower’s real numbers, with the borrower’s permission.',
    work: ['Borrower document checklists and reminders', 'Pipeline and status reports', 'Sorting the loan inbox and pulling out borrower details', 'Alerts on past clients when a refinance might make sense'],
    services: ['document-collection', 'reports-and-recaps', 'inbox-sorting'],
    note: 'Anything that touches borrower data is set up with your compliance and IT approvals. When live loan data is needed, borrowers connect their own accounts through a secure service built for that. We never store borrower passwords.',
    faqs: [
      ['Do you store borrower logins?', 'No. Borrowers connect their own accounts through a secure service built for that, and we never see their passwords.'],
      ['Will it use estimates?', 'Not for anything a borrower sees or a decision depends on. We use the borrower’s real numbers.'],
    ],
  },
  {
    slug: 'contractors-and-home-services', name: 'Contractors and home services', title: 'AI for contractors and home service companies',
    tldr: 'The office work behind every job (quotes, job recaps, change orders and invoice follow-ups) is what slows a growing crew down. We build tools that turn photos and notes into draft quotes, write the job recap, and track which quotes and invoices still need a nudge.',
    work: ['Quotes from photos, measurements and site notes', 'Job recaps and change orders', 'Following up on open quotes and unpaid invoices', 'Sorting service requests from email and web forms'],
    services: ['quotes-and-estimates', 'inbox-sorting', 'document-collection'],
    faqs: [
      ['Do my crews have to use a new app?', 'No. Crews keep sending photos and notes the way they do now. The tool works from what they already send.'],
      ['Can it follow up on quotes for me?', 'Yes. It keeps a list of open quotes and drafts each follow-up for your approval.'],
    ],
  },
  {
    slug: 'restaurants', name: 'Restaurants', title: 'AI for restaurants',
    tldr: 'Restaurants run on thin margins and long checklists. We started Half Pan, a free app that helps kitchen crews weigh food waste and make less of it, at our family’s Qdoba in Hoover. We also build tools that check vendor invoices against agreed prices and turn sales and waste data into a weekly report.',
    work: ['Tracking food waste by item and shift', 'Checking vendor invoices against agreed prices', 'Weekly sales, labor and waste reports', 'Sorting catering and event requests'],
    services: ['order-and-price-checks', 'reports-and-recaps', 'inbox-sorting'],
    proof: ['/work/half-pan/', 'Half Pan started in our family’s Qdoba kitchen in Hoover and is free for kitchen crews.'],
    faqs: [
      ['Is Half Pan free?', 'Yes. Half Pan is free for kitchen crews. Learn more at halfpan.app.'],
      ['Do you work with franchise locations?', 'Yes. Half Pan started in a franchise kitchen, and tools can be set up for each location.'],
    ],
  },
];

const WORK = [
  {
    slug: 'moveshare', name: 'MoveShare', kind: 'Logistics · Waypoint Investments',
    title: 'MoveShare: finding moves that can share a truck',
    summary: 'Through QuantHub’s Alabama Data Scholars internship, Sai Vajaha and a teammate built MoveShare for Waypoint Investments. It pulls moves from Waypoint’s Salesforce, finds moves that can share a truck and route, and emails a daily report.',
    result: 'Waypoint has recorded $15,000 to $20,000 a month in savings from it.',
    sections: [
      ['What it does', ['Pulls upcoming moves from Waypoint’s Salesforce', 'Finds moves that can share a truck and a route', 'Emails the team a daily report of the matches']],
      ['Why it matters for your business', ['The data to save money was already in Salesforce. Nobody had time to compare every move by hand.', 'Most businesses have the same kind of savings sitting in their own spreadsheets and systems.']],
    ],
  },
  {
    slug: 'food-broker-deal-sheets', name: 'Deal sheets in seconds', kind: 'Food broker · Demo',
    title: 'Food broker deal sheets, filled and checked in seconds',
    summary: 'A demo we built on real promo files. A principal’s promo planner and item list go in. Every retailer deal sheet for the year comes out on the retailer’s own form, split into pages, with each line checked against the source files.',
    result: 'The first run caught pricing and item code mistakes before anything went out.',
    sections: [
      ['What goes in', ['The principal’s promo planner, with one row per promo week', 'The item list, with codes, pack sizes and costs', 'The retailer’s blank deal sheet']],
      ['What comes out', ['Every deal sheet for the year, on the retailer’s own form', 'Extra pages when a product group runs past the lines on the form', 'A check list for a person to review']],
      ['What the checks caught', ['Item codes used on two different items', 'A UPC typo', 'Unit costs that did not match case costs', 'An ad price below the cost at list price']],
      ['A note on privacy', ['This is a demo, not a paid project. Names and numbers are left out on purpose.']],
    ],
  },
  {
    slug: 'half-pan', name: 'Half Pan', kind: 'Restaurants · Our company',
    title: 'Half Pan: a free food waste app for kitchen crews',
    summary: 'Half Pan is a free app that helps kitchen crews weigh what they throw out and make less of it. Sai Vajaha built it with co-founder Jai Varikuti, starting at their family’s Qdoba in Hoover. It works in English, Spanish and Telugu.',
    result: 'Free for kitchen crews at halfpan.app.',
    sections: [
      ['What it does', ['Crews weigh food waste by item during the shift', 'Managers see what gets thrown out most', 'Kitchens can prep less of what goes to waste']],
      ['Why we built it', ['It started in our own family’s kitchen, where we saw how much food was thrown out each day.']],
    ],
  },
];

const FAQS = [
  ['What does Vajaha & Co. do?', ONE_LINER],
  ['Who is Vajaha & Co. for?', 'Small and mid-size teams in Alabama with repetitive office work: food brokers, distributors, mortgage and insurance offices, contractors, restaurants and any office that retypes the same information every week.'],
  ['How much does AI automation cost?', 'Each project is a flat price, quoted after a free demo, based on how many workflows and forms are involved. You pay half up front and half when you sign off that it works. An optional monthly plan covers running it, changes and new files.'],
  ['How long does a project take?', 'We aim for one to three weeks per workflow once we have your sample files and answers. You get a firm timeline with the quote.'],
  ['What is the free demo?', 'We build a working version on your real files so you can see it next to how your team does the work today. There is no cost and no obligation.'],
  ['Do we need new software?', 'No. We build around the spreadsheets, forms, email and systems you already use.'],
  ['Is our data safe?', 'Your files are used only for your project and never shared. When the work ends, we return or delete your files if you ask. Your team approves anything before it goes to a customer.'],
  ['What if the AI makes a mistake?', 'Numbers are calculated with code and checked against your source files, and your team reviews the output before it is sent. If something we built is wrong, we fix it at no charge.'],
  ['Do you only work in Birmingham?', 'No. We are based in Hoover and meet in person around the Birmingham area. We work remotely with businesses anywhere in Alabama and beyond.'],
  ['Who is behind Vajaha & Co.?', 'Sai Vajaha, the founder. Sai built MoveShare at Waypoint Investments through QuantHub’s Alabama Data Scholars internship and co-founded Half Pan, a food waste app for kitchens.'],
  ['What tools do you work with?', 'Excel, Google Sheets, Gmail, Salesforce, PDFs and CSV exports are common. If you use something else, we confirm it works during the free demo.'],
  ['What happens if we stop the monthly plan?', 'You keep everything we built. The monthly plan is month to month, and either side can stop it with two weeks’ notice.'],
  ['Who owns what you build?', 'You do. Everything built for your business is yours to keep and use, even if the monthly plan stops.'],
];

const STEPS = [
  ['A 15-minute call', 'Tell us the task your team retypes most and send a sample file.'],
  ['A free demo', 'We build a working version on your real files so you can see it next to how you do it now.'],
  ['A flat price', 'You know the cost up front. Half to start, half when you sign off that it works.'],
  ['We keep it running', 'Send new files and get finished work back within one business day. Stop the monthly plan anytime.'],
];

const CITIES_NEAR = ['Hoover', 'Birmingham', 'Vestavia Hills', 'Homewood', 'Mountain Brook', 'Pelham', 'Alabaster', 'Trussville', 'Bessemer'];
const CITIES_STATE = ['Huntsville', 'Montgomery', 'Mobile', 'Tuscaloosa', 'Auburn', 'Dothan', 'Decatur', 'Florence', 'Gadsden'];

// ---------- Structured data ----------
const ORG_ID = `${SITE}/#org`;
const SITE_ID = `${SITE}/#website`;
const SAI_ID = `${SITE}/#sai`;
const ORG = {
  '@type': ['ProfessionalService', 'Organization'], '@id': ORG_ID, name: BRAND, alternateName: 'Vajaha and Co.',
  url: `${SITE}/`, logo: `${SITE}/logo.svg`, image: `${SITE}/sai.jpg`, description: ONE_LINER,
  slogan: 'AI that takes the paperwork off your team.', email: EMAIL, telephone: '+1-205-207-9977',
  address: { '@type': 'PostalAddress', addressLocality: 'Hoover', addressRegion: 'AL', addressCountry: 'US' },
  areaServed: [{ '@type': 'State', name: 'Alabama' }, ...CITIES_NEAR.concat(CITIES_STATE).map((c) => ({ '@type': 'City', name: `${c}, Alabama` }))],
  founder: { '@id': SAI_ID },
  knowsAbout: ['AI automation', 'Workflow automation', 'Document automation', 'Form filling', 'Data entry automation', 'Excel automation', 'Report automation', 'Email automation'],
  hasOfferCatalog: {
    '@type': 'OfferCatalog', name: 'AI automation services',
    itemListElement: SERVICES.map((s) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: s.name, url: `${SITE}/services/${s.slug}/` } })),
  },
};
const PERSON = {
  '@type': 'Person', '@id': SAI_ID, name: 'Sai Vajaha', jobTitle: 'Founder', worksFor: { '@id': ORG_ID },
  image: `${SITE}/sai.jpg`, url: `${SITE}/about/`, sameAs: [LINKEDIN],
  homeLocation: { '@type': 'Place', name: 'Hoover, Alabama' },
  knowsAbout: ['AI automation', 'Python', 'Salesforce data', 'Workflow automation'],
};
const WEBSITE = { '@type': 'WebSite', '@id': SITE_ID, url: `${SITE}/`, name: BRAND, publisher: { '@id': ORG_ID }, inLanguage: 'en-US' };
const faqLd = (faqs) => ({ '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });

// ---------- Layout ----------
const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#14201f"/><path d="M18 19l14 27 14-27" fill="none" stroke="#f7f5f0" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="46" r="4.5" fill="#62c2b5"/></svg>';
const NAV = [['/services/', 'Services'], ['/industries/', 'Industries'], ['/work/', 'Work'], ['/how-it-works/', 'How it works'], ['/faq/', 'FAQ'], ['/about/', 'About']];

const CSS = `
:root{--ink:#14201f;--paper:#f7f5f0;--card:#fff;--muted:#56625e;--line:#e2ddd2;--accent:#1f6f68;--accent-soft:#e3f1ee;--mint:#62c2b5;--clay:#b9542c;--radius:14px;--max:1120px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}img{max-width:100%;display:block}
.wrap{max-width:var(--max);margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:Fraunces,Georgia,serif;font-weight:600;line-height:1.15;margin:0 0 .5em;letter-spacing:-.01em}
h1{font-size:clamp(2.2rem,5vw,3.7rem)}h2{font-size:clamp(1.6rem,3.2vw,2.3rem)}h3{font-size:1.2rem}
p{margin:0 0 1em}.muted{color:var(--muted)}
.eyebrow{font-size:.8rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:.8rem}
header.top{position:sticky;top:0;z-index:10;background:rgba(247,245,240,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;gap:22px;min-height:66px}
.brand{display:flex;align-items:center;gap:10px;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.2rem;text-decoration:none;white-space:nowrap}
.brand svg{width:30px;height:30px}
.nav nav{margin-left:auto;display:flex;gap:20px}
.nav nav a{text-decoration:none;font-size:.95rem;color:var(--muted);white-space:nowrap}
.nav nav a:hover,.nav nav a[aria-current]{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:999px;font-weight:600;font-size:.95rem;text-decoration:none;border:1.5px solid var(--ink);transition:transform .15s ease,background .15s ease}
.btn:hover{transform:translateY(-1px)}.btn.solid{background:var(--ink);color:var(--paper)}.btn.solid:hover{background:#24332f}
.nav .btn{padding:9px 16px}
.hero{padding:80px 0 60px}
.hero-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:56px;align-items:center}
.lede{font-size:1.2rem;color:var(--muted);max-width:34em}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:26px 0 16px}
.small{font-size:.92rem;color:var(--muted)}
.portrait{position:relative}
.portrait img{border-radius:22px;aspect-ratio:4/5;object-fit:cover;width:100%;height:auto;box-shadow:0 24px 60px -28px rgba(20,32,31,.45)}
.portrait .tag{position:absolute;left:-18px;bottom:22px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;font-size:.85rem;box-shadow:0 10px 30px -18px rgba(20,32,31,.5)}
.portrait .tag b{display:block;font-size:.95rem}
.proof{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--card)}
.proof-grid{display:grid;grid-template-columns:repeat(3,1fr)}
.proof-item{padding:28px 24px;border-left:1px solid var(--line)}.proof-item:first-child{border-left:0}
.proof-item .big{font-family:Fraunces,Georgia,serif;font-size:1.5rem;font-weight:600;margin-bottom:6px}
.proof-item p{margin:0;color:var(--muted);font-size:.95rem}
section.block{padding:80px 0}.block.tight{padding-top:0}
.section-head{max-width:42em;margin-bottom:36px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.cards.two{grid-template-columns:repeat(2,1fr)}.cards.four{grid-template-columns:repeat(4,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:24px;text-decoration:none;display:block}
a.card:hover{border-color:var(--accent)}
.card p{color:var(--muted);margin:0;font-size:.97rem}
.card .more{display:inline-block;margin-top:12px;color:var(--accent);font-weight:600;font-size:.92rem}
.dark{background:var(--ink);color:var(--paper)}
.dark .eyebrow{color:var(--mint)}.dark .muted{color:#b9c4c0}
.dark .card{background:transparent;border-color:rgba(247,245,240,.16)}.dark .card p{color:#d5ddda}
.dark a.card:hover{border-color:var(--mint)}.dark .card .more{color:var(--mint)}
.kind{font-size:.76rem;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:8px}
.dark .kind{color:var(--mint)}
.result{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-weight:600;font-size:.95rem}
.dark .result{border-color:rgba(247,245,240,.16);color:var(--paper)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;counter-reset:step;padding:0;margin:0;list-style:none}
.steps li{padding:22px;border-radius:var(--radius);background:var(--card);border:1px solid var(--line)}
.steps li::before{counter-increment:step;content:counter(step);display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--ink);color:var(--paper);font-weight:600;margin-bottom:12px}
.steps p{color:var(--muted);margin:0;font-size:.96rem}
.steps.two{grid-template-columns:1fr 1fr}
.prose .steps li{padding:22px;margin:0}
.prose .steps li::before{content:counter(step);position:static;width:32px;height:32px;background:var(--ink)}
.assure{margin-top:26px;display:flex;flex-wrap:wrap;gap:10px 26px;color:var(--muted);font-size:.95rem}
.assure span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:9px;vertical-align:middle}
.page-head{padding:56px 0 8px}
.page-head h1{font-size:clamp(2rem,4.4vw,3.1rem);max-width:18em}
.crumbs{font-size:.88rem;color:var(--muted);margin-bottom:18px}.crumbs a{text-decoration:none}.crumbs a:hover{text-decoration:underline}
.tldr{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:20px 22px;margin:18px 0 8px;max-width:46em;font-size:1.06rem}
.tldr b{display:block;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.updated{font-size:.85rem;color:var(--muted);margin-top:10px}
.prose>*{max-width:46em}.prose>.steps,.prose>.cols,.prose>.cards{max-width:62em}.prose h2{font-size:1.6rem;margin-top:1.6em}
.prose ul,.checks{padding-left:0;list-style:none;margin:0 0 1.2em}
.prose li,.checks li{position:relative;padding-left:26px;margin-bottom:8px}
.prose li::before,.checks li::before{content:"";position:absolute;left:0;top:.62em;width:12px;height:2px;background:var(--clay)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.faq{max-width:46em}
.faq details{border-bottom:1px solid var(--line);padding:16px 0}
.faq summary{cursor:pointer;font-weight:600;font-size:1.05rem;list-style:none;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--accent);font-size:1.3rem;line-height:1}
.faq details[open] summary::after{content:"\\2212"}
.faq details p{margin:10px 0 0;color:var(--muted)}
.cta{background:var(--accent);color:#fff;border-radius:26px;padding:52px;display:grid;grid-template-columns:1.2fr .8fr;gap:36px;align-items:center}
.cta h2{color:#fff}.cta p{color:#d9efeb;font-size:1.06rem;margin:0}
.cta .lines{display:grid;gap:12px}
.cta .btn{border-color:#fff;color:#fff}.cta .btn.solid{background:#fff;color:var(--ink)}
.pills{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0 0 1em;list-style:none}
.pills li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:.92rem}
.booking{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:8px;min-height:200px}
.booking-fallback{padding:24px}
footer{margin-top:40px;border-top:1px solid var(--line);background:var(--card)}
.foot{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:28px;padding:44px 20px 24px}
.foot h4{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.foot ul{list-style:none;padding:0;margin:0;display:grid;gap:6px;font-size:.93rem}
.foot a{text-decoration:none}.foot a:hover{text-decoration:underline}
.foot p{font-size:.93rem;color:var(--muted)}
.legal{padding:0 20px 32px;font-size:.85rem;color:var(--muted)}
@media (max-width:900px){
.nav{flex-wrap:wrap;gap:10px 16px;padding-top:10px}
.nav .btn{margin-left:auto}
.nav nav{order:3;width:100%;margin:0;overflow-x:auto;padding-bottom:10px;gap:18px}
.hero{padding:40px 0 40px}
.hero-grid,.cta,.cols{grid-template-columns:1fr}
.portrait{max-width:340px}.portrait .tag{left:12px}
.proof-grid,.cards,.cards.two,.cards.four{grid-template-columns:1fr}
.proof-item{border-left:0;border-top:1px solid var(--line)}.proof-item:first-child{border-top:0}
.steps{grid-template-columns:1fr 1fr}
section.block{padding:56px 0}
.cta{padding:32px 22px}
.foot{grid-template-columns:1fr 1fr}
}
@media (max-width:520px){.steps,.steps.two{grid-template-columns:1fr}.foot{grid-template-columns:1fr}}
`;

function layout({ path, title, description, body, schema = [], crumbs = [], type = 'WebPage' }) {
  const url = `${SITE}${path}`;
  const full = path === '/' ? `${BRAND} | AI automation for Alabama businesses` : `${title} | ${BRAND}`;
  const graph = [ORG, WEBSITE, PERSON, {
    '@type': type, '@id': `${url}#page`, url, name: full, description, isPartOf: { '@id': SITE_ID },
    about: { '@id': ORG_ID }, dateModified: UPDATED, inLanguage: 'en-US',
  }];
  if (crumbs.length) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [['/', 'Home'], ...crumbs].map(([p, n], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: `${SITE}${p}` })),
    });
  }
  graph.push(...schema);
  const crumbHtml = crumbs.length
    ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${crumbs.map(([p, n], i) => ` / ${i === crumbs.length - 1 ? esc(n) : `<a href="${p}">${esc(n)}</a>`}`).join('')}</nav>`
    : '';
  const nav = NAV.map(([p, n]) => `<a href="${p}"${path.startsWith(p) ? ' aria-current="page"' : ''}>${n}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="${esc(BRAND)}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/sai.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#14201f">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
<script type="application/ld+json">${ld({ '@context': 'https://schema.org', '@graph': graph })}</script>
</head>
<body>
<header class="top"><div class="wrap nav">
<a class="brand" href="/" aria-label="${esc(BRAND)} home">${LOGO}${esc(BRAND)}</a>
<nav aria-label="Main">${nav}</nav>
<a class="btn solid" href="/book/">Book a call</a>
</div></header>
<main>
${crumbHtml ? `<div class="wrap" style="padding-top:28px">${crumbHtml}</div>` : ''}
${body}
${ctaBand()}
</main>
<footer>
<div class="wrap foot">
<div><a class="brand" href="/">${LOGO}${esc(BRAND)}</a><p style="margin-top:12px">${esc(ONE_LINER)}</p></div>
<div><h4>Services</h4><ul>${SERVICES.map((s) => `<li><a href="/services/${s.slug}/">${esc(s.name)}</a></li>`).join('')}</ul></div>
<div><h4>Industries</h4><ul>${INDUSTRIES.map((s) => `<li><a href="/industries/${s.slug}/">${esc(s.name)}</a></li>`).join('')}<li><a href="/alabama/">Alabama service area</a></li></ul></div>
<div><h4>Company</h4><ul><li><a href="/about/">About</a></li><li><a href="/work/">Work</a></li><li><a href="/how-it-works/">How it works</a></li><li><a href="/faq/">FAQ</a></li><li><a href="/book/">Book a call</a></li><li><a href="mailto:${EMAIL}">${EMAIL}</a></li><li><a href="tel:${TEL}">${PHONE}</a></li></ul></div>
</div>
<div class="wrap legal">© 2026 ${esc(BRAND)} · Hoover, Alabama · <a href="${HALFPAN}">Half Pan</a> · <a href="${LINKEDIN}">LinkedIn</a></div>
</footer>
</body>
</html>
`;
}

function ctaBand() {
  return `<section class="block tight"><div class="wrap"><div class="cta">
<div><h2>What does your team retype every week?</h2><p>Send one example. We'll show you a working version on your own files, free, before you decide anything.</p></div>
<div class="lines"><a class="btn solid" href="/book/">Book a 15-minute call</a><a class="btn" href="tel:${TEL}">Call ${PHONE}</a></div>
</div></div></section>`;
}

const list = (items, cls = 'checks') => `<ul class="${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const faqHtml = (faqs) => `<div class="faq">${faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`;
const tldr = (text) => `<div class="tldr"><b>The short answer</b>${esc(text)}</div><div class="updated">Updated ${UPDATED_TEXT} by Sai Vajaha</div>`;
const head = ({ eyebrow, h1, lead }) => `<section class="page-head"><div class="wrap"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(h1)}</h1>${lead || ''}</div></section>`;
const serviceCard = (s) => `<a class="card" href="/services/${s.slug}/"><h3>${esc(s.name)}</h3><p>${esc(s.short)}</p><span class="more">Learn more</span></a>`;
const industryCard = (s) => `<a class="card" href="/industries/${s.slug}/"><h3>${esc(s.name)}</h3><p>${esc(s.tldr.split('. ')[0])}.</p><span class="more">See what we build</span></a>`;
const workCard = (w) => `<a class="card" href="/work/${w.slug}/"><div class="kind">${esc(w.kind)}</div><h3>${esc(w.name)}</h3><p>${esc(w.summary)}</p><div class="result">${esc(w.result)}</div></a>`;
const stepsHtml = () => `<ol class="steps">${STEPS.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join('')}</ol>`;

// ---------- Pages ----------
const pages = [];
const add = (path, opts) => pages.push({ path, html: layout({ path, ...opts }) });

// Home
add('/', {
  title: 'Home',
  description: 'Vajaha & Co. builds AI tools for Alabama businesses. Forms, quotes, document chasing, reports and order checks done in minutes, checked, and ready for your team to send. Free demo on your files.',
  body: `
<section class="hero"><div class="wrap hero-grid">
<div>
<div class="eyebrow">AI automation for Alabama businesses</div>
<h1>AI that takes the paperwork off your team.</h1>
<p class="lede">${esc(BRAND)} builds AI tools for small teams. Forms, quotes, reports and follow-ups get done in minutes, checked, and handed to your team ready to send.</p>
<div class="actions"><a class="btn solid" href="/book/">Get a free demo on your files</a><a class="btn" href="/work/">See the work</a></div>
<div class="small">Based in Hoover. In person around Birmingham, remote across Alabama.</div>
</div>
<div class="portrait"><img src="/sai.jpg" width="900" height="1125" alt="Sai Vajaha, founder of Vajaha & Co., in a navy blazer with arms crossed"><div class="tag"><b>Sai Vajaha</b>Founder, ${esc(BRAND)}</div></div>
</div></section>
<section class="proof" aria-label="Results"><div class="wrap proof-grid">
<div class="proof-item"><div class="big">$15,000 to $20,000 a month</div><p>Waypoint has recorded $15,000 to $20,000 a month in savings from MoveShare.</p></div>
<div class="proof-item"><div class="big">Every line checked</div><p>Our tools check each number against your source files before anything goes out.</p></div>
<div class="proof-item"><div class="big">One business day</div><p>Turnaround on new files once your system is running.</p></div>
</div></section>
<section class="block"><div class="wrap">
<div class="section-head"><div class="eyebrow">What we build</div><h2>The work your team retypes every week, done for you.</h2><p class="muted">Every tool is built on your real files and your real process. Nothing gets sent without your team checking it first.</p></div>
<div class="cards">${SERVICES.map(serviceCard).join('')}</div>
</div></section>
<section class="block dark"><div class="wrap">
<div class="section-head"><div class="eyebrow">Work</div><h2>Built for real teams, on their real files.</h2><p class="muted">Business names stay private unless they say otherwise.</p></div>
<div class="cards">${WORK.map(workCard).join('')}</div>
</div></section>
<section class="block"><div class="wrap">
<div class="section-head"><div class="eyebrow">Industries</div><h2>Built for the way your industry already works.</h2></div>
<div class="cards four">${INDUSTRIES.map(industryCard).join('')}</div>
</div></section>
<section class="block tight"><div class="wrap">
<div class="section-head"><div class="eyebrow">How it works</div><h2>You see it working before you pay for it.</h2></div>
${stepsHtml()}
<div class="assure"><span>Your team checks everything before it goes out</span><span>Your files stay private and are used only for your project</span><span>Everything we build is yours to keep</span></div>
</div></section>
<section class="block tight"><div class="wrap cols">
<div><div class="eyebrow">Questions</div><h2>Common questions</h2><p class="muted">More answers on the <a href="/faq/">FAQ page</a>.</p></div>
${faqHtml(FAQS.slice(0, 5))}
</div></section>
<section class="block tight"><div class="wrap">
<div class="section-head"><div class="eyebrow">Our companies</div><h2>Everything we build lives here.</h2></div>
<div class="cards two">
<a class="card" href="/services/"><div class="kind">${esc(BRAND)}</div><h3>AI automation studio</h3><p>AI tools that take repetitive office work off small teams across Alabama.</p><span class="more">See services</span></a>
<a class="card" href="${HALFPAN}"><div class="kind">Half Pan</div><h3>Food waste app for kitchens</h3><p>A free app that helps restaurant kitchens weigh and cut food waste.</p><span class="more">halfpan.app</span></a>
</div></div></section>`,
  schema: [faqLd(FAQS.slice(0, 5))],
});

// Services index + pages
add('/services/', {
  title: 'AI automation services',
  description: 'AI automation services from Vajaha & Co. in Hoover, Alabama: forms and deal sheets, quotes and estimates, missing documents, reports, inbox sorting, and order and price checks.',
  crumbs: [['/services/', 'Services']], type: 'CollectionPage',
  body: `${head({ eyebrow: 'Services', h1: 'AI automation services for small teams', lead: tldr('We build AI tools that take one repetitive task off your team at a time: filling forms, writing quotes, chasing documents, building reports, sorting the inbox and checking orders. Each tool works with the files you already use, and your team approves everything before it goes out.') })}
<section class="block" style="padding-top:36px"><div class="wrap"><div class="cards">${SERVICES.map(serviceCard).join('')}</div></div></section>`,
});
for (const s of SERVICES) {
  const p = `/services/${s.slug}/`;
  add(p, {
    title: `${s.name}: AI automation`,
    description: `${s.tldr.split('. ').slice(0, 2).join('. ')}.`.slice(0, 300),
    crumbs: [['/services/', 'Services'], [p, s.name]],
    body: `${head({ eyebrow: 'Service', h1: s.q, lead: tldr(s.tldr) })}
<section class="block" style="padding-top:32px"><div class="wrap prose">
<h2>Who it's for</h2>${list(s.who)}
<h2>How it works</h2><ol class="steps two">${s.steps.map((t, i) => `<li><p>${esc(t)}</p></li>`).join('')}</ol>
<div class="cols" style="margin-top:28px"><div><h2 style="margin-top:0">What you send us</h2>${list(s.inputs)}</div><div><h2 style="margin-top:0">What you get</h2>${list(s.outputs)}</div></div>
${s.example ? `<p><a class="btn" href="${s.example[0]}">${esc(s.example[1])}</a></p>` : ''}
<h2>Questions about ${esc(s.name.toLowerCase())}</h2>${faqHtml(s.faqs)}
<h2>Related services</h2><ul>${SERVICES.filter((o) => o.slug !== s.slug).slice(0, 3).map((o) => `<li><a href="/services/${o.slug}/">${esc(o.name)}</a></li>`).join('')}</ul>
</div></section>`,
    schema: [
      { '@type': 'Service', '@id': `${SITE}${p}#service`, name: s.name, serviceType: s.name, description: s.tldr, url: `${SITE}${p}`, provider: { '@id': ORG_ID }, areaServed: { '@type': 'State', name: 'Alabama' } },
      faqLd(s.faqs),
    ],
  });
}

// Industries
add('/industries/', {
  title: 'Industries we build AI tools for',
  description: 'Vajaha & Co. builds AI tools for food brokers and distributors, mortgage and lending offices, contractors and home service companies, and restaurants in Alabama.',
  crumbs: [['/industries/', 'Industries']], type: 'CollectionPage',
  body: `${head({ eyebrow: 'Industries', h1: 'AI tools built for how your industry already works', lead: tldr('Every industry has its own forms, rules and paperwork. We start from the files your team already uses, then build the tool around them, so nobody has to change how they work.') })}
<section class="block" style="padding-top:36px"><div class="wrap"><div class="cards two">${INDUSTRIES.map(industryCard).join('')}</div></div></section>`,
});
for (const ind of INDUSTRIES) {
  const p = `/industries/${ind.slug}/`;
  add(p, {
    title: ind.title,
    description: ind.tldr.slice(0, 300),
    crumbs: [['/industries/', 'Industries'], [p, ind.name]],
    body: `${head({ eyebrow: 'Industry', h1: ind.title, lead: tldr(ind.tldr) })}
<section class="block" style="padding-top:32px"><div class="wrap prose">
<h2>Paperwork we take off your team</h2>${list(ind.work)}
${ind.note ? `<p class="muted">${esc(ind.note)}</p>` : ''}
${ind.proof ? `<h2>Proof</h2><p>${esc(ind.proof[1])}</p><p><a class="btn" href="${ind.proof[0]}">Read more</a></p>` : ''}
<h2>Services that fit</h2><div class="cards" style="grid-template-columns:1fr">${ind.services.map((k) => serviceCard(svc[k])).join('')}</div>
<h2>Questions</h2>${faqHtml(ind.faqs)}
</div></section>`,
    schema: [faqLd(ind.faqs)],
  });
}

// Work
add('/work/', {
  title: 'Work and case studies',
  description: 'Case studies from Vajaha & Co.: MoveShare at Waypoint Investments ($15,000 to $20,000 a month in recorded savings), a food broker deal sheet demo, and Half Pan.',
  crumbs: [['/work/', 'Work']], type: 'CollectionPage',
  body: `${head({ eyebrow: 'Work', h1: 'Built for real teams, on their real files', lead: tldr('MoveShare finds moves that can share a truck for Waypoint Investments, which has recorded $15,000 to $20,000 a month in savings from it. Our deal sheet demo fills a broker’s retailer forms in seconds and checks every line. Half Pan helps kitchens cut food waste.') })}
<section class="block" style="padding-top:36px"><div class="wrap"><div class="cards">${WORK.map(workCard).join('')}</div></div></section>`,
});
for (const w of WORK) {
  const p = `/work/${w.slug}/`;
  add(p, {
    title: w.title,
    description: `${w.summary} ${w.result}`.slice(0, 300),
    crumbs: [['/work/', 'Work'], [p, w.name]],
    body: `${head({ eyebrow: w.kind, h1: w.title, lead: tldr(`${w.summary} ${w.result}`) })}
<section class="block" style="padding-top:32px"><div class="wrap prose">
${w.sections.map(([h, items]) => `<h2>${esc(h)}</h2>${list(items)}`).join('')}
${w.slug === 'half-pan' ? `<p><a class="btn" href="${HALFPAN}">Visit halfpan.app</a></p>` : ''}
</div></section>`,
    schema: [{
      '@type': 'Article', headline: w.title, description: w.summary, author: { '@id': SAI_ID }, publisher: { '@id': ORG_ID },
      datePublished: UPDATED, dateModified: UPDATED, mainEntityOfPage: `${SITE}${p}`, image: `${SITE}/sai.jpg`,
    }],
  });
}

// How it works
add('/how-it-works/', {
  title: 'How it works and how pricing works',
  description: 'How a Vajaha & Co. project works: a 15-minute call, a free demo on your files, a flat price paid half up front, and an optional monthly plan.',
  crumbs: [['/how-it-works/', 'How it works']],
  body: `${head({ eyebrow: 'How it works', h1: 'You see it working before you pay for it', lead: tldr('It starts with a 15-minute call and a free demo built on your real files. If you like it, you get a flat price: half to start, half when you sign off that it works. After that, an optional monthly plan keeps it running, with finished work back within one business day.') })}
<section class="block" style="padding-top:32px"><div class="wrap">${stepsHtml()}</div></section>
<section class="block tight"><div class="wrap prose">
<h2>What we need from you</h2>${list(['One example of the task, like a spreadsheet and the form it fills', 'A blank and a finished copy of anything we fill in', 'Answers to our questions about your rules, usually a short list after the demo'])}
<h2>How pricing works</h2>${list(['Each workflow is a flat price, quoted after the free demo, so you know the cost before you commit', 'Half is paid when work starts and half when you sign off that it works', 'An optional monthly plan covers running it, changes and new files, and you can stop it with two weeks’ notice', 'Anything extra you ask for is quoted before we start'])}
<h2>How we keep it safe and correct</h2>${list(['Numbers are calculated with code and checked against your source files', 'Your team reviews everything before it goes to a customer', 'Your files are used only for your project and never shared', 'If something we built is wrong, we fix it at no charge'])}
<h2>Who owns it</h2><p>You do. Everything we build for your business is yours to keep and use, even if the monthly plan stops.</p>
</div></section>`,
  schema: [{ '@type': 'HowTo', name: 'How a Vajaha & Co. project works', step: STEPS.map(([n, t], i) => ({ '@type': 'HowToStep', position: i + 1, name: n, text: t })) }],
});

// FAQ
add('/faq/', {
  title: 'Frequently asked questions',
  description: 'Answers about Vajaha & Co.: what we do, who it is for, how much AI automation costs, how long it takes, data safety, and who owns what we build.',
  crumbs: [['/faq/', 'FAQ']], type: 'FAQPage',
  body: `${head({ eyebrow: 'FAQ', h1: 'Frequently asked questions', lead: `<div class="updated">Updated ${UPDATED_TEXT} by Sai Vajaha</div>` })}
<section class="block" style="padding-top:28px"><div class="wrap">${faqHtml(FAQS)}</div></section>`,
  schema: [{ '@type': 'FAQPage', '@id': `${SITE}/faq/#faq`, mainEntity: faqLd(FAQS).mainEntity }],
});

// About
add('/about/', {
  title: 'About Sai Vajaha and Vajaha & Co.',
  description: 'Vajaha & Co. was founded by Sai Vajaha in Hoover, Alabama. Sai built MoveShare at Waypoint Investments through QuantHub’s Alabama Data Scholars internship and co-founded Half Pan.',
  crumbs: [['/about/', 'About']], type: 'AboutPage',
  body: `<section class="block" style="padding-top:40px"><div class="wrap hero-grid">
<div>
<div class="eyebrow">About</div>
<h1>Hi, I'm Sai.</h1>
<p class="lede">I'm a senior at Spain Park High School in Hoover and the founder of ${esc(BRAND)}. I build AI tools that take repetitive work off small teams, so the people there can spend their time on customers instead of retyping.</p>
${list(['Built MoveShare at Waypoint Investments through QuantHub’s Alabama Data Scholars internship. Waypoint has recorded $15,000 to $20,000 a month in savings from it.', 'Co-founded Half Pan, a free food waste app that started at our family’s Qdoba in Hoover', 'Alabama DECA Vice President of Career Development, 2026-27'])}
<div class="actions"><a class="btn solid" href="/book/">Book a call</a><a class="btn" href="${LINKEDIN}">LinkedIn</a></div>
</div>
<div class="portrait"><img src="/sai.jpg" width="900" height="1125" alt="Sai Vajaha" loading="lazy"></div>
</div></section>
<section class="block tight"><div class="wrap prose">
<h2>What ${esc(BRAND)} is</h2><p>${esc(ONE_LINER)}</p>
<h2>How we work</h2><p>Every project starts with a free demo on your real files. We price each workflow flat, your team checks everything before it goes out, and you keep everything we build.</p>
<h2>Where we work</h2><p>We're based in Hoover and meet in person around Birmingham. We work remotely with businesses anywhere in Alabama. <a href="/alabama/">See the service area</a>.</p>
</div></section>`,
});

// Alabama service area
add('/alabama/', {
  title: 'AI automation in Alabama',
  description: 'Vajaha & Co. is based in Hoover, Alabama, and builds AI automation tools for businesses in Birmingham, Huntsville, Montgomery, Mobile, Tuscaloosa and across the state.',
  crumbs: [['/alabama/', 'Alabama']],
  body: `${head({ eyebrow: 'Service area', h1: 'AI automation for businesses across Alabama', lead: tldr('Vajaha & Co. is based in Hoover, Alabama. We meet in person around the Birmingham area and work remotely with businesses anywhere in the state. Most of the work happens on your files, so distance does not slow anything down.') })}
<section class="block" style="padding-top:32px"><div class="wrap prose">
<h2>In person around Birmingham</h2><ul class="pills">${CITIES_NEAR.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
<h2>Remote across Alabama</h2><ul class="pills">${CITIES_STATE.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
<p>Outside Alabama? We work remotely too. <a href="/book/">Book a call</a> and tell us what your team retypes every week.</p>
<h2>What we build</h2><ul>${SERVICES.map((s) => `<li><a href="/services/${s.slug}/">${esc(s.name)}</a>: ${esc(s.short)}</li>`).join('')}</ul>
</div></section>`,
});

// Book
const bookingEmbed = !BOOKING_URL ? '' : /calendly\.com/.test(BOOKING_URL)
  ? `<div class="calendly-inline-widget" data-url="${esc(BOOKING_URL)}?hide_gdpr_banner=1" style="min-width:300px;height:720px"></div><script src="https://assets.calendly.com/assets/external/widget.js" async></script>`
  : `<iframe src="${esc(BOOKING_URL)}" title="Book a call" style="border:0;width:100%;height:720px"></iframe>`;
add('/book/', {
  title: 'Book a 15-minute call',
  description: 'Book a free 15-minute call with Vajaha & Co. Tell us the task your team retypes most, and we will build a free demo on your files.',
  crumbs: [['/book/', 'Book a call']], type: 'ContactPage',
  body: `${head({ eyebrow: 'Book a call', h1: 'Book a free 15-minute call', lead: '<p class="lede">Tell us the task your team retypes most. If it is a fit, we build a free demo on your real files.</p>' })}
<section class="block" style="padding-top:28px"><div class="wrap cols">
<div class="booking">${bookingEmbed || `<div class="booking-fallback"><h3>Pick a time by email</h3><p class="muted">Send two or three times that work for you, and we will confirm within one business day.</p><div class="actions"><a class="btn solid" href="${MAIL_DEMO}">Email ${EMAIL}</a><a class="btn" href="tel:${TEL}">Call ${PHONE}</a></div></div>`}</div>
<div class="prose"><h2 style="margin-top:0">What happens on the call</h2>${list(['You tell us the task and how your team does it today', 'We ask a few questions about your files and rules', 'If it is a fit, you send one sample file and we build a free demo'])}<h2>Prefer to call?</h2><p><a href="tel:${TEL}">${PHONE}</a> or <a href="mailto:${EMAIL}">${EMAIL}</a></p></div>
</div></section>`,
});

// ---------- Write files ----------
rmSync(OUT, { recursive: true, force: true });
for (const { path, html } of pages) {
  const file = join(OUT, path, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}
writeFileSync(join(OUT, '404.html'), layout({
  path: '/404', title: 'Page not found', description: 'This page does not exist.',
  body: `${head({ eyebrow: '404', h1: 'That page does not exist', lead: '<p class="lede">Try the <a href="/">home page</a>, our <a href="/services/">services</a> or the <a href="/faq/">FAQ</a>.</p>' })}`,
}).replace('<link rel="canonical" href="' + SITE + '/404">', '<meta name="robots" content="noindex">'));
writeFileSync(join(OUT, 'logo.svg'), LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
writeFileSync(join(OUT, 'robots.txt'), `# ${BRAND}: search engines and AI assistants are welcome.
User-agent: *
Allow: /

User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: GPTBot
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Bingbot
User-agent: Googlebot
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(({ path }) => `<url><loc>${SITE}${path}</loc><lastmod>${UPDATED}</lastmod></url>`).join('\n')}
</urlset>
`);
writeFileSync(join(OUT, 'llms.txt'), `# ${BRAND}

> ${ONE_LINER}

- Founder: Sai Vajaha (${LINKEDIN})
- Location: Hoover, Alabama. In person around Birmingham, remote across Alabama.
- Contact: ${EMAIL}, ${PHONE}
- Book a free 15-minute call: ${SITE}/book/
- How it works: a free demo on your real files, then a flat price per workflow (half up front, half at sign-off), then an optional monthly plan.
- Proof: MoveShare, built with a teammate at Waypoint Investments through QuantHub's Alabama Data Scholars internship. Waypoint has recorded $15,000 to $20,000 a month in savings from it.

## Services
${SERVICES.map((s) => `- [${s.name}](${SITE}/services/${s.slug}/): ${s.short}`).join('\n')}

## Industries
${INDUSTRIES.map((s) => `- [${s.title}](${SITE}/industries/${s.slug}/)`).join('\n')}

## Work
${WORK.map((w) => `- [${w.title}](${SITE}/work/${w.slug}/): ${w.result}`).join('\n')}

## Company
- [How it works and pricing](${SITE}/how-it-works/)
- [FAQ](${SITE}/faq/)
- [About Sai Vajaha](${SITE}/about/)
- [Alabama service area](${SITE}/alabama/)
- [Half Pan](${HALFPAN}): a free food waste app for kitchen crews, co-founded by Sai Vajaha
`);

if (process.env.PHOTO_PATH) {
  copyFileSync(process.env.PHOTO_PATH, join(OUT, 'sai.jpg'));
} else {
  const r = await fetch(PHOTO_URL);
  if (!r.ok) throw new Error(`Photo download failed: ${r.status}`);
  writeFileSync(join(OUT, 'sai.jpg'), Buffer.from(await r.arrayBuffer()));
}
console.log(`Built ${pages.length} pages for ${SITE}${BOOKING_URL ? ' (booking embed on)' : ' (booking by email until BOOKING_URL is set)'}`);
