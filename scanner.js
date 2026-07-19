
/* ====== CONFIG ====== */
const LEAD_ENDPOINT = "https://formsubmit.co/ajax/3bd8ef4252086e696e8c59cd240104e9";
const BUY_URL = "https://aoaudit.gumroad.com/l/playbook";
/* ==================== */

const PILLARS = [
  { id:"entity", name:"Entity" }, { id:"content", name:"Content" },
  { id:"code", name:"Code" }, { id:"agents", name:"Agents" },
];

/* ---------- fetch through CORS relays ---------- */
const PRIVATE_RELAY = "https://ao-relay.aojedamedia.workers.dev"; // our own Cloudflare Worker — primary relay
async function relayFetch(url){
  const targets = [
    ...(PRIVATE_RELAY ? [u => `${PRIVATE_RELAY}/?url=${encodeURIComponent(u)}`] : []),
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  for(const t of targets){
    try{
      const turl = t(url);
      const r = await fetch(turl, {signal: AbortSignal.timeout(12000)});
      if(r.status === 404 && turl.includes("/raw?")) return {ok:false, status:404, text:""};
      if(!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      if(ct.includes("application/json") && turl.includes("/get?")){
        const j = await r.json();
        const code = j.status && j.status.http_code;
        if(code && code >= 400) return {ok:false, status:code, text:""};
        if(j.contents) return {ok:true, status:code||200, text:j.contents};
        continue;
      }
      const text = await r.text();
      if(text) return {ok:true, status:r.status, text};
    }catch(e){ /* try next relay */ }
  }
  return {ok:false, status:0, text:""};
}

/* ---------- scan logic ---------- */
const auto = []; // {id,p,w,label,pass,detail,fix}
function add(p,w,label,pass,detail,fix){ auto.push({p,w,label,pass,detail,fix}); }
function skipCheck(p,label,what){ auto.push({p, w:0, skip:true, pass:false, label,
  detail:`NOT READABLE this run — our scanner couldn't fetch ${what} (a hiccup on our side, not yours). It may well exist; this check was NOT counted against your score, and we verify it by hand before your full report.`,
  fix:""}); }

function extractJsonLd(doc){
  const out = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try{
      const j = JSON.parse(s.textContent);
      (Array.isArray(j) ? j : (j["@graph"] || [j])).forEach(o => o && out.push(o));
    }catch(e){}
  });
  return out;
}

const ENGINE_BOTS = {
  "ChatGPT / OpenAI": ["gptbot","oai-searchbot","chatgpt-user"],
  "Claude / Anthropic": ["claudebot","claude-user","claude-searchbot","anthropic-ai"],
  "Gemini (apps & training)": ["google-extended"],
  "Perplexity": ["perplexitybot","perplexity-user"],
  "Meta AI": ["meta-externalagent","facebookbot"],
  "Apple Intelligence / Siri": ["applebot-extended"],
  "Amazon Alexa+": ["amazonbot"],
  "DuckDuckGo AI": ["duckassistbot"],
  "Model training (Common Crawl)": ["ccbot"],
  "ByteDance / Doubao": ["bytespider"],
};
function robotsBlocks(txt){
  const lines = txt.split(/\r?\n/).map(l => l.replace(/#.*$/,"").trim()).filter(Boolean);
  const groups = {}; let current = [];
  lines.forEach(l => {
    const m = l.match(/^user-agent:\s*(.+)$/i);
    if(m){ current = [m[1].toLowerCase().trim()]; current.forEach(a => groups[a] = groups[a] || []); return; }
    const d = l.match(/^disallow:\s*(.*)$/i);
    if(d && current.length) current.forEach(a => groups[a].push(d[1].trim()));
  });
  // training-class tokens: blocking these costs future model knowledge, NOT today's live answers
  const TRAINING_ONLY = new Set(["gptbot","claudebot","anthropic-ai","google-extended","ccbot","bytespider","meta-externalagent","applebot-extended"]);
  const blockedEngines = [];
  Object.entries(ENGINE_BOTS).forEach(([engine, bots]) => {
    const hitBots = bots.filter(b => {
      const rules = groups[b] !== undefined ? groups[b] : groups["*"];
      return rules && rules.some(r => r === "/");
    });
    if(hitBots.length){
      const trainingOnly = hitBots.every(b => TRAINING_ONLY.has(b));
      blockedEngines.push(engine + (trainingOnly ? " (training-only — affects future model knowledge, not today's answers)" : " (LIVE answer/search bots — costs you answers today)"));
    }
  });
  return blockedEngines;
}

async function runScan(rawUrl){
  auto.length = 0;
  let url = rawUrl.trim();
  if(!/^https?:\/\//i.test(url)) url = "https://" + url;
  let origin;
  try{ origin = new URL(url).origin; }catch(e){ return {fatal:"That doesn't look like a valid address — try something like yourbusiness.com"}; }

  const con = document.getElementById("console");
  con.innerHTML = "";
  const log = (cls, msg) => { const d = document.createElement("div"); d.className = cls; d.textContent = msg; con.appendChild(d); d.scrollIntoView({block:"nearest"}); return d; };
  const upd = (el, cls, msg) => { el.className = cls; el.textContent = msg; };

  let l = log("run", `Fetching ${url} …`);
  const page = await relayFetch(url);
  if(!page.ok || page.text.length < 100){
    // Control check: can we reach a site that is never down? If not, OUR relay is the problem — never blame their site.
    const control = await relayFetch("https://example.com/");
    if(!control.ok){
      upd(l, "bad", "Our scanning service is briefly overloaded — this is on our side, not yours.");
      log("warn", "Answer the quick questions below anyway: leave your email and we'll run your full scan ourselves and send your AO Score in the report.");
      return {fatal:"unreachable", relayDown:true, origin, url};
    }
    upd(l, "bad", `Couldn't fetch ${url} — the site may be down, or it blocks automated readers entirely.`);
    log("warn", "Ironically, that's itself a finding: if we can't read it, many AI crawlers can't either.");
    return {fatal:"unreachable", origin, url};
  }
  upd(l, "ok", `Fetched ${url} (${Math.round(page.text.length/1024)} KB of HTML)`);

  const doc = new DOMParser().parseFromString(page.text, "text/html");
  const bodyText = (doc.body ? doc.body.textContent : "").replace(/\s+/g," ").trim();
  const htmlLower = page.text.toLowerCase();

  /* Loop deeper: follow up to 2 key interior pages so pricing/FAQ/booking claims
     are verified against more than the homepage. */
  l = log("run", "Scanning key interior pages\u2026");
  const wantedLink = /(pricing|prices|price-list|rates|visit|tasting|experience|menu|services|faq|book|shop|wines|store|about|story|roots|team|contact|events|club|gallery)/i;
  const seenPages = new Set(); const candidates = [];
  for(const a of doc.querySelectorAll("a")){
    const h = a.getAttribute("href") || "";
    if(!wantedLink.test(h)) continue;
    let u; try{ u = new URL(h, url).href; }catch(e){ continue; }
    if(!u.startsWith(origin)) continue;
    const key = u.replace(/[#?].*$/,"").replace(/\/$/,"");
    if(!key || seenPages.has(key) || key === url.replace(/\/$/,"")) continue;
    seenPages.add(key); candidates.push(key);
    if(candidates.length >= 5) break;
  }
  const interior = [];
  if(candidates.length){
    const rs = await Promise.all(candidates.map(u => relayFetch(u)));
    rs.forEach((r,i) => { if(r.ok && r.text.length > 300)
      interior.push({u: candidates[i], d: new DOMParser().parseFromString(r.text, "text/html")}); });
  }
  const pageDocs = [{u: url, d: doc}, ...interior];
  const pathOf = x => { try{ return new URL(x).pathname || "/"; }catch(e){ return x; } };
  const textOf = d => (d.body ? d.body.textContent : "").replace(/\s+/g," ");
  upd(l, "ok", interior.length
    ? `Also scanned ${interior.length} interior page(s): ${interior.map(p=>pathOf(p.u)).join(", ")}`
    : "No key interior pages reachable \u2014 judging from the homepage");


  /* CODE pillar */
  l = log("run", "Checking structured data (JSON-LD schema)…");
  const ld = extractJsonLd(doc);
  const types = [...new Set(ld.map(o => o["@type"]).flat().filter(Boolean))];
  // legacy formats: microdata (itemtype attrs) and RDFa (typeof attrs) — Google/Bing parse them, most AI pipelines don't
  const microTypes = [...new Set([...doc.querySelectorAll("[itemtype]")]
      .map(el => (el.getAttribute("itemtype")||"").split("/").pop()).filter(Boolean))];
  const rdfa = doc.querySelector("[typeof]") !== null;
  const legacyNote = microTypes.length
      ? `Legacy microdata found instead (${microTypes.slice(0,4).join(", ")}) — valid microdata works fine for Google (their docs: all three formats are equally fine), but Google recommends JSON-LD as easier to maintain, and most third-party AI tooling extracts JSON-LD blocks. The facts are already written: converting takes ~20 minutes.`
      : (rdfa ? "Legacy RDFa markup found instead — valid RDFa works for Google, but Google recommends JSON-LD and most third-party AI tooling extracts JSON-LD blocks. Convert (~20 minutes)."
              : "No machine-readable schema found on the homepage — not modern JSON-LD, not legacy microdata. (If your website builder injects schema with JavaScript, know that most non-Google AI crawlers read raw HTML and won't see it either — that's the problem to fix.)");
  add("code", 7, "JSON-LD structured data present", ld.length > 0,
    ld.length ? `Found: ${types.slice(0,6).join(", ")}` : legacyNote,
    (microTypes.length || rdfa)
      ? "Convert your existing legacy markup to JSON-LD — same facts, the format Google officially recommends (easier to maintain) and the one third-party AI tooling actually extracts. Validate free at validator.schema.org."
      : "Add JSON-LD structured data. It's how you speak to machines in their native language — industry studies find sites with clean schema get cited up to 3.2× more.");
  upd(l, ld.length ? "ok" : "bad", ld.length ? `Schema found: ${types.slice(0,6).join(", ")}`
      : (microTypes.length || rdfa) ? "Only LEGACY schema (microdata/RDFa) — convert to JSON-LD" : "No JSON-LD schema found");

  const hasOrg = types.some(t => /organization|localbusiness|store|restaurant|professionalservice|medicalbusiness|homeandconstructionbusiness|legalservice|dentist|physician|autorepair|realestateagent/i.test(String(t)));
  const sameAs = ld.some(o => Array.isArray(o.sameAs) && o.sameAs.length >= 2);
  add("code", 6, "Organization / LocalBusiness identity schema", hasOrg,
    hasOrg ? (sameAs ? "Identity schema with sameAs profile links — excellent" : "Identity schema found, but add a sameAs list of your profiles") : "Machines have no structured 'ID card' for your business",
    "Add Organization or LocalBusiness JSON-LD with name, description, contact info, and a sameAs array linking every profile (Google, LinkedIn, socials, Yelp). Google's rule: structured data must match your visible page text — never mark up facts the page doesn't show.");
  log(hasOrg ? "ok" : "bad", hasOrg ? "Business identity schema present" : "No Organization/LocalBusiness schema");

  const hasFaq = pageDocs.some(p => extractJsonLd(p.d).some(o =>
    String(o["@type"]).toLowerCase().includes("faqpage")));
  add("code", 5, "FAQPage schema (highest-impact type for AI answers)", hasFaq,
    hasFaq ? "FAQ schema found — pre-chunked answers machines love" : "No FAQPage schema",
    "Find the real questions your customers ask — Google's 'People also ask', your reviews, what people actually email and call about — then answer the top 10 on a FAQ page with FAQPage schema. The single highest-impact schema for AI answers.");
  log(hasFaq ? "ok" : "warn", hasFaq ? "FAQPage schema present" : "No FAQPage schema found");

  l = log("run", `Checking ${origin}/robots.txt for AI-crawler blocks…`);
  const robots = await relayFetch(origin + "/robots.txt");
  let blocked = [];
  if(!robots.ok && robots.status === 0){
    // relay failed — we did NOT read their robots.txt; never guess pass or fail
    upd(l, "warn", "Couldn't reach robots.txt this run — check not counted");
    skipCheck("code", "All major AI engines allowed to read your site", "your robots.txt");
  } else {
    if(robots.ok && /user-agent/i.test(robots.text)) blocked = robotsBlocks(robots.text);
    lastBlocked = blocked;
    // classic-crawler safety net: a by-name Googlebot/Bingbot block is catastrophic and easy to miss
    const classicBlocked = ["googlebot","bingbot"].filter(b =>
      new RegExp("user-agent:\\s*" + b + "[\\s\\S]{0,80}?disallow:\\s*/\\s*($|\\n)", "i").test(robots.text));
    if(classicBlocked.length)
      log("bad", `CRITICAL: robots.txt blocks ${classicBlocked.join(" and ")} by name — that removes you from ${classicBlocked.includes("googlebot") ? "Google Search AND its AI features" : ""}${classicBlocked.length === 2 ? " plus " : ""}${classicBlocked.includes("bingbot") ? "Bing, Copilot, and most of ChatGPT's search" : ""}. Fix this before anything else in this report.`);
    add("code", 6, "All major AI engines allowed to read your site", blocked.length === 0,
      blocked.length ? `robots.txt blocks: ${blocked.join(" · ")}` : `Open to all ${Object.keys(ENGINE_BOTS).length} AI ecosystems we check: ChatGPT, Claude, Gemini, Perplexity, Meta AI, Apple Intelligence, Alexa+, DuckDuckGo, and model-training crawlers`,
      "Unblock the AI crawlers in robots.txt (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Meta-ExternalAgent, Applebot-Extended, Amazonbot and friends). Every blocked engine is an audience you can never appear in. (Precision note: Google-Extended governs Gemini apps and model training — Google Search\u2019s own AI answers ride the normal Googlebot.)");
    upd(l, blocked.length ? "bad" : "ok", blocked.length ? `robots.txt blocks AI engines: ${blocked.join(", ")}` : `All ${Object.keys(ENGINE_BOTS).length} major AI ecosystems can read this site`);
  }

  l = log("run", `Checking ${origin}/llms.txt …`);
  const llms = await relayFetch(origin + "/llms.txt");
  if(!llms.ok && llms.status === 0){
    upd(l, "warn", "Couldn't reach llms.txt this run — check not counted");
    skipCheck("code", "llms.txt present", "your llms.txt");
  } else {
    const hasLlms = llms.ok && llms.status < 400 && llms.text.trim().length > 20 && !/^\s*</.test(llms.text.trim());
    add("code", 3, "llms.txt present", hasLlms,
      hasLlms ? "Found — read by some AI agent tools (note: Google says its Search ignores llms.txt)" : "Not found — a 20-minute nice-to-have for AI agent tools; Google's Search ignores it either way",
      "Add an llms.txt file — a short markdown index of your business for AI agent tools. Honest note: Google states its Search ignores llms.txt; this is for the other agents. 20 minutes, cheap insurance.");
    upd(l, hasLlms ? "ok" : "warn", hasLlms ? "llms.txt found" : "No llms.txt (minor)");
  }

  l = log("run", `Checking ${origin}/sitemap.xml …`);
  const sm = await relayFetch(origin + "/sitemap.xml");
  if(!sm.ok && sm.status === 0){
    upd(l, "warn", "Couldn't reach sitemap.xml this run — check not counted");
    skipCheck("code", "sitemap.xml present (feeds Google AND Bing→ChatGPT)", "your sitemap.xml");
  } else {
    const hasSm = sm.ok && sm.status < 400 && /<(urlset|sitemapindex)/i.test(sm.text);
    add("code", 3, "sitemap.xml present (feeds Google AND Bing→ChatGPT)", hasSm,
      hasSm ? "Sitemap found" : "No sitemap.xml found at the standard location",
      "Add a sitemap.xml and submit it to Google Search Console AND Bing Webmaster Tools (bing.com/webmasters) — analyses find the large majority (~87% in one 2026 study) of ChatGPT search citations come from Bing's index, and most businesses never claim it. (Google notes small, well-linked sites may not strictly need one — the Bing submission is the prize most skip.)");
    upd(l, hasSm ? "ok" : "warn", hasSm ? "sitemap.xml found" : "No sitemap.xml");
  }

  const metaRobots = (doc.querySelector('meta[name="robots"]')||{content:""}).content || "";
  const noindex = /noindex/i.test(metaRobots);
  const hasCanonical = !!doc.querySelector('link[rel="canonical"]');
  add("code", 6, "Indexable — no noindex tag", !noindex,
    noindex ? "A noindex meta tag is telling EVERY search engine and AI to ignore this page" :
      (hasCanonical ? "No noindex; canonical URL set" : "No noindex (tip: add a canonical link tag)"),
    "Remove the noindex meta tag — it tells every search engine and AI engine to skip the page entirely. Then set a canonical link tag so machines know the one true address of each page.");
  log(noindex ? "bad" : "ok", noindex ? "CRITICAL: noindex tag found — invisible to all engines" : "Indexable — no noindex tag");

  const snippetBlocked = /nosnippet/i.test(metaRobots) || /max-snippet\s*:\s*0(?!\d)/i.test(metaRobots);
  add("code", 4, "Snippet-eligible (AI Overviews kill switch off)", !snippetBlocked,
    snippetBlocked ? "A nosnippet or max-snippet:0 directive is set — by Google's own rules this makes the page INELIGIBLE for AI Overviews and AI Mode" :
      "No nosnippet/max-snippet restrictions — eligible for AI answers per Google's documentation",
    "Remove nosnippet / max-snippet:0 from your robots meta tag. Google's documentation: a page must be eligible to show with a snippet to appear in AI Overviews or AI Mode.");
  const dns = (htmlLower.match(/data-nosnippet/g) || []).length;
  if(dns) log("warn", `data-nosnippet found on ${dns} element${dns>1?"s":""} — that content is invisible to Google's AI answers (fine if intentional; costly if it wraps prices, hours, or your best answers)`);
  log(snippetBlocked ? "bad" : "ok", snippetBlocked ? "CRITICAL: snippet controls block AI Overviews eligibility" : "Snippet-eligible — no AI Overviews kill switch (Google)");

  const msBlocked = /noarchive/i.test(metaRobots);
  const msLimited = /nocache/i.test(metaRobots);
  add("code", 4, "Copilot-eligible (Microsoft's AI kill switch off)", !msBlocked,
    msBlocked ? "A noarchive tag is set — by Microsoft's rules this EXCLUDES your content from Copilot answers entirely (not even a link). Many older sites carry this tag innocently: for 20 years it just hid the 'Cached' link. Now it erases you from Microsoft's AI." :
      msLimited ? "A nocache tag limits Copilot to your URL, title and snippet only — partial visibility in Microsoft's AI answers" :
      "No noarchive/nocache restrictions — fully eligible for Copilot answers per Microsoft's rules",
    "Remove the legacy noarchive meta tag (it once merely hid the 'Cached' link; today Microsoft's rules make it a total Copilot exclusion). This is for BING and COPILOT — the index that also feeds most of ChatGPT's search citations.");
  log(msBlocked ? "bad" : msLimited ? "warn" : "ok",
    msBlocked ? "CRITICAL: noarchive tag erases this site from Copilot (Microsoft)" :
    msLimited ? "nocache limits Copilot to snippet-only (Microsoft)" : "Copilot-eligible — no Microsoft AI kill switch");

  const jsOnly = bodyText.length < 400;
  add("code", 6, "Content readable without JavaScript", !jsOnly,
    jsOnly ? `Only ${bodyText.length} characters of visible text in raw HTML — AI crawlers likely see a blank page` : `${Math.round(bodyText.length/100)/10}k characters of machine-readable text`,
    "Your text must exist in the raw HTML (static pages or server-side rendering). Most AI crawlers don't run JavaScript — a JS-only site looks empty to them.");
  log(jsOnly ? "bad" : "ok", jsOnly ? "Very little text in raw HTML — likely JavaScript-only rendering" : "Real text present in raw HTML");

  /* CONTENT pillar */
  l = log("run", "Analyzing content signals…");
  const title = (doc.querySelector("title")||{}).textContent || "";
  const desc = (doc.querySelector('meta[name="description"]')||{content:""}).content || "";
  add("content", 4, "Title & meta description", title.length >= 15 && desc.length >= 60,
    `Title: ${title ? '"' + title.slice(0,60) + '"' : "missing"} · Description: ${desc ? desc.length + " chars" : "missing"}`,
    "Write a specific title and 120–160 character meta description that state what you do, for whom, where — the first thing retrieval engines read. This is for EVERY engine: Google, Bing (→ChatGPT and Copilot), and the LLM crawlers all read it first.");

  const h1s = [...doc.querySelectorAll("h1")].map(h => h.textContent.trim()).filter(Boolean);
  add("content", 3, "Clear H1 headline", h1s.length >= 1,
    h1s.length ? `H1: "${h1s[0].slice(0,70)}"` : "No H1 heading — the page never states its main topic in the strongest signal position",
    "Add one H1 that says what you do, for whom, where — it's the heading search and AI engines weight most. For EVERY engine — and Google's Essentials names keywords in headings as a top-impact practice.");

  const imgs = [...doc.querySelectorAll("img")];
  const noAlt = imgs.filter(im => !(im.getAttribute("alt")||"").trim()).length;
  add("content", 2, "Images described for machines (alt text)", imgs.length === 0 || noAlt <= imgs.length * 0.2,
    imgs.length === 0 ? "No images on the page — nothing to describe" :
      noAlt === 0 ? `All ${imgs.length} images have alt text` :
      `${noAlt} of ${imgs.length} images have no alt text — invisible to AI and screen readers`,
    "Give every meaningful image a short, specific alt description. Machines can't see your photos — alt text is how they know what's there. For Google (their Essentials names alt text explicitly), accessibility law, and multimodal AI.");

  const hasOg = !!doc.querySelector('meta[property^="og:"]');
  add("code", 2, "Open Graph tags (link previews & social signals)", hasOg,
    hasOg ? "Open Graph tags present" : "No Open Graph tags — links to your site show bare, title-less previews when shared",
    "Add og:title, og:description, og:url and an og:image (1200×630). Every share of your link becomes a proper card instead of a bare URL. For link previews everywhere: Messages, WhatsApp, Slack, social — and the AI assistants that share links.");

  const heads = pageDocs.flatMap(p => [...p.d.querySelectorAll("h1,h2,h3")].map(h => h.textContent.trim())).filter(Boolean);
  const qHeads = heads.filter(h => /\?|^(how|what|why|when|where|who|which|can|should|do|does|is|are)\b/i.test(h));
  add("content", 5, "Question-style headings (answer-ready structure)", qHeads.length >= 1,
    qHeads.length ? `${qHeads.length} question-style heading(s), e.g. "${qHeads[0].slice(0,60)}"` : `${heads.length} headings found, none phrased as customer questions`,
    "Rephrase key headings as the real questions customers ask, and answer each completely in the first 40–80 words below it. AI engines quote answer-shaped chunks.");

  const year = new Date().getFullYear().toString();
  const fresh = htmlLower.includes(year) || doc.querySelector("time") !== null || ld.some(o => o.dateModified || o.datePublished);
  add("content", 4, "Freshness signals (dates, current year)", fresh,
    fresh ? "Current-year or dated content detected" : "No visible dates or current-year references found",
    "Add visible published/updated dates and current-year references. AI engines prefer quoting provably-current content.");

  const priceRe = /\$\s?\d|€\s?\d|£\s?\d|pricing|price list|our prices|rates\b/i;
  const pricePage = pageDocs.find(p => priceRe.test(textOf(p.d)));
  const price = !!pricePage || [...doc.querySelectorAll("a")].some(a => /pricing|prices|rates/i.test(a.getAttribute("href")||""));
  add("content", 5, "Pricing transparency", price,
    price ? (pricePage ? `Price information found on ${pathOf(pricePage.u)}` : "Pricing page linked from your homepage") : `No prices found on your homepage${interior.length ? " or " + interior.map(p=>pathOf(p.u)).join(", ") : ""}`,
    "Publish prices or honest ranges. “Contact us for pricing” means the AI quotes your competitor's transparent page instead — and the agent books them.");
  upd(l, "ok", "Content signals analyzed");

  /* ENTITY pillar */
  l = log("run", "Checking entity signals…");
  const links = [...doc.querySelectorAll("a")].map(a => (a.getAttribute("href")||"").toLowerCase());
  const socials = [...new Set(links.map(h => (h.match(/(instagram|facebook|linkedin|youtube|tiktok|yelp|x)\.com/)||[])[1]).filter(Boolean))];
  add("entity", 5, "Linked profiles (socials, review sites)", socials.length >= 2,
    socials.length ? `Linked: ${socials.join(", ")}` : "No profile links found on the homepage",
    "Link your Google, LinkedIn company page, social and review profiles from your site and list them in schema sameAs — LinkedIn is Microsoft-owned, ranks in Bing (which feeds ChatGPT and Copilot), and is how machines confirm all your profiles are one entity.");

  const tel = links.some(h => h.startsWith("tel:")) || ld.some(o => o.telephone) || /\(\d{3}\)\s?\d{3}[- ]\d{4}|\+\d{7,}/.test(bodyText);
  const mail = links.some(h => h.startsWith("mailto:")) || ld.some(o => o.email);
  add("entity", 4, "Machine-readable contact info", tel || mail,
    tel ? "Phone/contact detected" : mail ? "Clickable email contact detected" : "No clickable phone or email, and no contact info in your schema",
    "Add a clickable tel: phone link (or mailto: email) and put contact details in your schema — agents verify businesses they can contact.");
  upd(l, "ok", "Entity signals checked");

  /* AGENTS pillar */
  l = log("run", "Checking agent-readiness…");
  const bookRe = /book (now|online|an appointment)|add to cart|buy now|order online|reserve/i;
  const bookish = links.some(h => /calendly|acuity|booksy|squareup|square\.site|setmore|appointlet|bookings?|schedule|checkout|cart|shop|store|buy|order|reserv/i.test(h)) || pageDocs.some(p => bookRe.test(textOf(p.d)));
  add("agents", 6, "Online booking / purchase path", bookish,
    bookish ? "Booking or purchase path detected" : "No booking link, cart, or ordering path found",
    "Add a real booking link (Calendly or your industry's platform) or online checkout. Agents route to businesses whose calendars and carts they can act on.");

  add("agents", 3, "Secure connection (https)", origin.startsWith("https"),
    origin.startsWith("https") ? "HTTPS in place" : "Site not served over HTTPS",
    "Move your site to HTTPS — table stakes for both AI crawlers and human trust.");
  upd(l, "ok", "Agent-readiness checked");

  const passed = auto.filter(a => a.pass).length;
  log("info", `Scan complete: ${passed} of ${auto.length} automated checks passed.`);
  return {origin, url};
}

/* ---------- manual questions ---------- */
const MQS = [
 {p:"entity", w:6, t:"Is your Google Business Profile claimed, 100% complete, and updated in the last 30 days?",
   h:"It feeds Google's AI answers directly; inactive profiles lose impressions.",
   fix:"Claim and complete your Google Business Profile and post 1–2× per week — it feeds Gemini-powered answers directly. And get your primary category exactly right: local-ranking studies rate it the #1 positive factor, and the wrong one the #1 negative."},
 {p:"entity", w:5, t:"Have you received (and responded to) reviews in the last 30 days?",
   h:"Volume, recency, and responses are core AI trust signals.",
   fix:"Set up a review ask after every sale and respond to every review — recent, answered reviews are a core AI trust signal. Local-ranking studies (Sterling Sky) find rankings dip after ~3 weeks without a fresh review, so build the habit, not a blitz."},
 {p:"entity", w:5, t:"Have you claimed Bing Places AND Apple Business (formerly Business Connect)?",
   h:"Bing Places feeds Microsoft Copilot and Alexa; Apple Business is what Siri checks for local businesses (Siri's harder questions hand off to ChatGPT — fed by Bing).",
   fix:"Claim both free profiles: bingplaces.com (feeds Copilot + Alexa + ChatGPT's ecosystem) and business.apple.com (the only data source Siri and Apple Intelligence check for local businesses)."},
 {p:"entity", w:4, t:"Is your business listed with current info on Yelp (or your industry's main review site)?",
   h:"Alexa+ pulls local business data primarily from Yelp; Perplexity uses it for local answers too.",
   fix:"Claim your free Yelp listing at biz.yelp.com and keep hours/services current — it's the primary local data source for Alexa+ and a key one for Perplexity."},
 {p:"agents", w:6, t:"Live test: ask 2–3 AI assistants (ChatGPT, Gemini, Claude, Grok…) “What is [your business name]?” — do they answer accurately?",
   h:"Copy that prompt into a couple of them right now. Accurate = yes. Wrong or “I don't know” = no.",
   fix:"The machines haven't formed an entity for you yet. Fix profiles, schema and consistency, then re-test monthly across ChatGPT, Gemini, Claude, Perplexity, Copilot and Grok."},
 {p:"agents", w:5, t:"Live test: ask ChatGPT, Perplexity or Google AI Mode “best [your category] in [your area]” — are you mentioned?",
   h:"This is the money question your customers already ask, on every AI platform.",
   fix:"You're losing the recommendation moment. Work the full system — entity, answer-first content, schema, reviews — and re-run monthly on each major engine."},
];
const manswers = new Array(MQS.length).fill(null);

function buildQuiz(){
  const quiz = document.getElementById("quiz");
  quiz.innerHTML = MQS.map((q,i) => `<div class="q" data-i="${i}">
    <h3 class="qt">${q.t}</h3><p class="qh">${q.h}</p>
    <div class="opts">
      <button type="button" data-v="yes">Yes</button>
      <button type="button" data-v="no">No</button>
      <button type="button" data-v="ns">Not sure</button>
    </div></div>`).join("");
  quiz.onclick = e => {
    const btn = e.target.closest("button[data-v]");
    if(!btn) return;
    const qEl = btn.closest(".q"); const i = +qEl.dataset.i;
    manswers[i] = btn.dataset.v;
    qEl.querySelectorAll("button").forEach(b => b.className = "");
    btn.className = "sel-" + btn.dataset.v;
    if(manswers.every(a => a !== null) && !unlocked) showResults(true);
  };
}

/* ---------- scoring & results ---------- */
let scannedUrl = "";
let relayOutage = false;
let scannedBiz = "";
let lastBlocked = [];
let unlocked = false;
function computeScore(){
  let got = 0, max = 0;
  const per = {}; PILLARS.forEach(pl => per[pl.id] = {got:0, max:0, name:pl.name});
  auto.forEach(a => { max += a.w; per[a.p].max += a.w; if(a.pass){ got += a.w; per[a.p].got += a.w; } });
  MQS.forEach((q,i) => { max += q.w; per[q.p].max += q.w; if(manswers[i] === "yes"){ got += q.w; per[q.p].got += q.w; } });
  return {score: Math.round(got/max*100), per};
}
function grade(s){
  if(s >= 85) return ["Agent-ready","You're ahead of ~99% of businesses. Protect the lead — this landscape shifts quarterly."];
  if(s >= 65) return ["Visible, with gaps","Machines can find you, but you're losing citations and agent-driven revenue at specific, fixable points."];
  if(s >= 40) return ["Half-invisible","You exist to machines, but they can't confidently cite or transact with you. The fixes below change that fast."];
  return ["Invisible to AI","Right now, AI engines can't see, verify, or recommend you — every AI answer in your category goes to someone else. The good news: everything below is fixable in weeks."];
}
function showResults(locked){
  const {score, per} = computeScore();
  const [g, verdict] = grade(score);
  document.getElementById("r-head").textContent =
    `AO Score for ${scannedBiz || scannedUrl.replace(/^https?:\/\//,"")}`;
  document.getElementById("results").style.display = "block";
  document.getElementById("r-score").textContent = score;
  document.getElementById("r-grade").textContent = g;
  document.getElementById("r-verdict").textContent = verdict;
  document.getElementById("ring").style.background =
    `conic-gradient(${score>=65?"var(--teal)":score>=40?"var(--amber)":"var(--red)"} ${score*3.6}deg, var(--line) 0deg)`;
  document.getElementById("r-pillars").innerHTML = PILLARS.map(pl => {
    const p = per[pl.id]; const pct = p.max ? Math.round(p.got/p.max*100) : 0;
    return `<div class="pbar"><span>${p.name}</span>
      <div class="bar"><i style="width:${pct}%;background:${pct>=65?"var(--teal)":pct>=40?"var(--amber)":"var(--red)"}"></i></div>
      <span>${pct}%</span></div>`;
  }).join("");
  document.getElementById("r-findings").innerHTML = "<h3>What the scan found</h3>" +
    auto.map(a => `<div class="finding ${a.skip?"check":a.pass?"pass":"fail"}"><span class="fi">${a.skip?"?":a.pass?"✓":"✗"}</span>
      <span>${a.label}<br><span class="fd">${a.detail}</span></span></div>`).join("") +
    MQS.map((q,i) => `<div class="finding ${manswers[i]==="yes"?"pass":manswers[i]==="no"?"fail":"check"}">
      <span class="fi">${manswers[i]==="yes"?"✓":manswers[i]==="no"?"✗":"?"}</span>
      <span>${q.t.replace("Live test: ","")}</span></div>`).join("");
  const missedAuto = auto.filter(a => !a.pass && !a.skip).map(a => ({w:a.w, t:a.label, fix:a.fix, ns:false}));
  const missedMan = MQS.map((q,i) => ({w:q.w, t:q.t.replace("Live test: ",""), fix:q.fix, ns:manswers[i]==="ns", a:manswers[i]}))
    .filter(q => q.a !== "yes");
  const missed = [...missedAuto, ...missedMan].sort((a,b) => b.w - a.w).slice(0,5);
  document.getElementById("r-fixes").innerHTML =
    missed.length === 0
    ? `<h3>No critical gaps found. Seriously impressive.</h3><p class="dim">Re-audit monthly — AI surfaces change fast.</p>`
    : `<h3>Fix these first (highest impact)</h3>` + missed.map((q,n) =>
      `<div class="fix"><b>${n+1}. ${q.ns?"Verify: ":""}${q.t}</b><p>${q.fix}</p></div>`).join("");
  if(BUY_URL){ const b = document.getElementById("buybtn"); b.href = BUY_URL; b.hidden = false; }
  else { document.getElementById("buysoon").hidden = false; }
  const rc = document.getElementById("r-content");
  const gate = document.getElementById("gate");
  if(locked){ rc.classList.add("locked"); gate.hidden = false; }
  else { unlocked = true; rc.classList.remove("locked"); gate.hidden = true; }
  document.getElementById("results").scrollIntoView({behavior:"smooth"});
}

/* ---------- wiring ---------- */
document.getElementById("scanform").addEventListener("submit", async e => {
  e.preventDefault();
  const raw = document.getElementById("url").value.trim();
  scannedBiz = document.getElementById("bizname").value.trim();
  const err = document.getElementById("urlerr");
  if(!raw || !raw.includes(".")){ err.textContent = "Enter your website address — like yourbusiness.com"; return; }
  err.textContent = "";
  const btn = document.getElementById("scanbtn");
  btn.disabled = true; btn.textContent = "Scanning…";
  document.getElementById("scanpanel").style.display = "block";
  document.getElementById("results").style.display = "none";
  document.getElementById("manual").style.display = "none";
  document.getElementById("gate").hidden = true;
  manswers.fill(null);
  unlocked = false;
  document.getElementById("scanpanel").scrollIntoView({behavior:"smooth"});
  if(typeof gtag === "function") gtag("event", "scan_started", {});
  const res = await runScan(raw);
  btn.disabled = false; btn.textContent = "Scan my website →";
  relayOutage = !!res.relayDown;
  if(res.fatal === "unreachable"){
    scannedUrl = res.url || raw;
    document.getElementById("scantitle").textContent = relayOutage
      ? "Our scanner is briefly busy — we'll run your scan for you"
      : "We couldn't read your site";
  } else if(res.fatal){
    err.textContent = res.fatal;
    document.getElementById("scanpanel").style.display = "none";
    return;
  } else {
    scannedUrl = res.url;
    document.getElementById("scantitle").textContent = "Scan complete";
  }
  buildQuiz();
  document.getElementById("manual").style.display = "block";
  setTimeout(() => document.getElementById("manual").scrollIntoView({behavior:"smooth"}), 600);
});

document.getElementById("gateform").addEventListener("submit", e => {
  e.preventDefault();
  const email = document.getElementById("g-email").value.trim();
  const gerr = document.getElementById("gerr");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ gerr.textContent = "Please enter a valid email address."; return; }
  gerr.textContent = "";
  if(typeof gtag === "function") gtag("event", "generate_lead", {method: "report_gate"});
  const leadName = document.getElementById("g-name").value.trim();
  const btn = document.getElementById("gbtn");
  btn.disabled = true; btn.textContent = "Unlocking…";
  const {score, per} = computeScore();
  const failed = auto.filter(a => !a.pass && !a.skip).map(a => a.label).join(" · ") || "none";
  const gname = leadName;
  const [g] = grade(score);
  const pillarsTxt = PILLARS.map(pl => `${pl.name} ${per[pl.id].max?Math.round(per[pl.id].got/per[pl.id].max*100):0}%`).join(" · ");
  const wins = [...auto.filter(a => !a.pass && !a.skip).sort((a,b) => b.w - a.w),
                ...MQS.map((q,i) => manswers[i] !== "yes" ? {label:q.t.replace("Live test: ",""), fix:q.fix, w:q.w} : null).filter(Boolean)]
               .slice(0,3);
  const autoreply =
`Hi ${gname || "there"},

Here is your AO snapshot (Answer Optimization) for ${scannedBiz || scannedUrl.replace(/^https?:\/\//,"")} (${scannedUrl.replace(/^https?:\/\//,"")}):

SCORE: ${score}/100 — ${g}
PILLARS: ${pillarsTxt}

Your 3 fastest wins:
${wins.map((f,n) => `${n+1}. ${f.fix}`).join("\n")}

Your full illustrated AO Report — every finding explained, charts, and your prioritized 30-day fix plan — is being prepared now and will arrive in this inbox within 48 hours.

Talk soon,
Alejandro
Be the Answer — aoaudit.com`;
  fetch(LEAD_ENDPOINT, {
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body: JSON.stringify({
      name: gname,
      email,
      business: scannedBiz || "(not given)",
      website: scannedUrl,
      score: String(score),
      grade: g,
      pillars: pillarsTxt,
      failed_checks: failed,
      next_action: relayOutage
        ? "RELAY OUTAGE during their scan — automated checks are missing. Run the full scan manually, then send their PDF report within 48 hours"
        : "Send their full PDF report within 48 hours",
      report_json: JSON.stringify({
        business: scannedBiz, site: scannedUrl.replace(/^https?:\/\//,"").replace(/\/$/,""),
        name: gname, email, score, grade: g, relay_outage: relayOutage,
        pillars: Object.fromEntries(PILLARS.map(pl =>
          [pl.name, per[pl.id].max ? Math.round(per[pl.id].got/per[pl.id].max*100) : 0])),
        blocked: lastBlocked,
        findings: [
          ...auto.map(a => [a.label, a.skip ? "verify" : a.pass ? "pass" : "fail", a.detail]),
          ...MQS.map((q,i) => [q.t.replace("Live test: ",""),
            manswers[i]==="yes" ? "pass" : manswers[i]==="no" ? "fail" : "verify", q.h])
        ],
        fixes: [...auto.filter(a => !a.pass && !a.skip).map(a => ({t:a.label, f:a.fix, w:a.w})),
                ...MQS.map((q,i) => manswers[i] !== "yes"
                  ? {t:q.t.replace("Live test: ",""), f:q.fix, w:q.w} : null).filter(Boolean)]
               .sort((a,b) => b.w - a.w).slice(0,5)
      }),
      _subject: `AO Audit lead — ${scannedBiz || scannedUrl.replace(/^https?:\/\//,"")} scored ${score}`,
      _template: "table",
      _autoresponse: autoreply
    })
  }).catch(()=>{}).finally(() => {
    btn.disabled = false; btn.textContent = "Send it & unlock my report";
    showResults(false);
  });
});

document.getElementById("reset").addEventListener("click", e => { e.preventDefault(); location.href = "#"; location.reload(); });
