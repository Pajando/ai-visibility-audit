
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
  const groups = {}; let current = []; let expecting = false;
  lines.forEach(l => {
    const m = l.match(/^user-agent:\s*(.+)$/i);
    if(m){
      // Stacked agents share one rule block:
      //   User-agent: GPTBot
      //   User-agent: CCBot
      //   Disallow: /
      // Resetting `current` on every line dropped GPTBot's block silently.
      if(!expecting) current = [];
      const agent = m[1].toLowerCase().trim();
      current.push(agent);
      groups[agent] = groups[agent] || [];
      expecting = true;
      return;
    }
    const d = l.match(/^disallow:\s*(.*)$/i);
    if(d && current.length){
      expecting = false;
      current.forEach(a => groups[a].push(d[1].trim()));
      return;
    }
    // any other directive also ends the user-agent run
    if(/^(allow|crawl-delay|sitemap|host|noindex):/i.test(l)) expecting = false;
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
  try{ origin = new URL(url).origin; }catch(e){ return {fatal:"That doesn't look like a valid address — try something like website.com"}; }

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
      log("warn", "No score this time. Leave your email below and we'll run your scan ourselves.");
      return {fatal:"unreachable", relayDown:true, origin, url};
    }
    upd(l, "bad", `Couldn't open ${url} this time. The site may be down for a moment, or it turns away automated readers like ours.`);
    log("warn", "That doesn't mean AI can't read it. It means our scanner couldn't. No score this time.");
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
      ? "Your business details are already in your site's code, but in an older format many AI tools skip (legacy microdata or RDFa). Switch them to the format Google recommends: same facts, easier to keep up to date, and the one outside AI tools actually pull (JSON-LD). Check it free at validator.schema.org."
      : "Add a short code block that tells Google and AI tools your business name, address, hours and what you sell, so they don't have to guess (JSON-LD schema). Visitors never see it. Check it free at validator.schema.org.");
  upd(l, ld.length ? "ok" : "bad", ld.length ? `Schema found: ${types.slice(0,6).join(", ")}`
      : (microTypes.length || rdfa) ? "Only LEGACY schema (microdata/RDFa) — convert to JSON-LD" : "No JSON-LD schema found");

  // Organization + every schema.org subtype of it (LocalBusiness and its full tree included).
  // Generated from schemaorg-current-https-types.csv on 2026-10-14. A hand-picked regex here
  // missed AutomotiveBusiness/AutoDealer, so dealers with perfect identity schema failed.
  const ORG_TYPES = new Set(("AccountingService AdultEntertainment Airline AmusementPark AnimalShelter ArchiveOrganization ArtGallery Attorney Audiology AutoBodyShop AutoDealer " +
    "AutoPartsStore AutoRental AutoRepair AutoWash AutomatedTeller AutomotiveBusiness Bakery BankOrCreditUnion BarOrPub BeautySalon BedAndBreakfast " +
    "BikeStore BookStore BowlingAlley Brewery CafeOrCoffeeShop Campground Casino ChildCare ClothingStore CollegeOrUniversity ComedyClub CommunityHealth " +
    "ComputerStore Consortium ConvenienceStore Cooperative Corporation CovidTestingFacility DanceGroup DaySpa Dentist DepartmentStore Dermatology " +
    "DiagnosticLab DietNutrition Distillery DryCleaningOrLaundry EducationalOrganization Electrician ElectronicsStore ElementarySchool Emergency " +
    "EmergencyService EmploymentAgency EntertainmentBusiness ExerciseGym FastFoodRestaurant FinancialService FireStation Florist FoodEstablishment " +
    "FundingAgency FundingScheme FurnitureStore GardenStore GasStation GeneralContractor Geriatric GolfCourse GovernmentOffice GovernmentOrganization " +
    "GroceryStore Gynecologic HVACBusiness HairSalon HardwareStore HealthAndBeautyBusiness HealthClub HighSchool HobbyShop HomeAndConstructionBusiness " +
    "HomeGoodsStore Hospital Hostel Hotel HousePainter IceCreamShop IndividualPhysician InsuranceAgency InternetCafe JewelryStore LegalService Library " +
    "LibrarySystem LiquorStore LocalBusiness Locksmith LodgingBusiness MedicalBusiness MedicalClinic MedicalOrganization MensClothingStore MiddleSchool " +
    "Midwifery MobilePhoneStore Motel MotorcycleDealer MotorcycleRepair MovieRentalStore MovieTheater MovingCompany MusicGroup MusicStore NGO NailSalon " +
    "NewsMediaOrganization NightClub Notary Nursing Obstetric OfficeEquipmentStore Oncologic OnlineBusiness OnlineMarketplace OnlineStore Ophthalmology " +
    "Optician Optometric Organization Otolaryngologic OutletStore PawnShop Pediatric PerformingGroup PetStore Pharmacy Physician PhysiciansOffice " +
    "Physiotherapy PlasticSurgery Plumber Podiatric PoliceStation PoliticalParty PostOffice Preschool PrimaryCare ProfessionalService Project Psychiatric " +
    "PublicHealth PublicSwimmingPool RadioStation RealEstateAgent RecyclingCenter ResearchOrganization ResearchProject Resort Restaurant RoofingContractor " +
    "School SearchRescueOrganization SelfStorage ShoeStore ShoppingCenter SkiResort SportingGoodsStore SportsActivityLocation SportsClub " +
    "SportsOrganization SportsTeam StadiumOrArena Store TattooParlor TelevisionStation TennisComplex TheaterGroup TireShop TouristInformationCenter " +
    "ToyStore TravelAgency VacationRental VeterinaryCare WholesaleStore Winery WorkersUnion").toLowerCase().split(" "));
  // "https://schema.org/AutoDealer" or "schema:AutoDealer" -> "autodealer"
  const localName = t => String(t).split(/[\/#:]/).pop().toLowerCase();
  const orgObj = ld.find(o => [].concat(o["@type"] || []).some(t => ORG_TYPES.has(localName(t))))
    // custom or misspelled @type, but it still carries a business name + street address: that IS an identity card
    || ld.find(o => o.name && o.address && !/^(webpage|website|breadcrumblist|faqpage|product|offer|event)$/i.test(localName([].concat(o["@type"]||[""])[0])));
  const hasOrg = !!orgObj;
  const sameAs = ld.some(o => Array.isArray(o.sameAs) && o.sameAs.length >= 2);
  add("code", 6, "Organization / LocalBusiness identity schema", hasOrg,
    hasOrg ? `${[].concat(orgObj["@type"]||"Business")[0]} identity schema found` + (sameAs ? " with sameAs profile links — excellent" : ", but add a sameAs list of your profiles") : "Machines have no structured 'ID card' for your business",
    "Give Google and AI tools a clear ID card for your business: your name, what you do, your phone, and links to your Google, Yelp and social pages (Organization or LocalBusiness JSON-LD with a sameAs list). Google's rule: this code must match what your page actually shows, so never add facts the page doesn't show.");
  log(hasOrg ? "ok" : "bad", hasOrg ? "Business identity schema present" : "No Organization/LocalBusiness schema");

  const hasFaq = pageDocs.some(p => extractJsonLd(p.d).some(o =>
    String(o["@type"]).toLowerCase().includes("faqpage")));
  add("code", 5, "FAQPage schema (answers in a format machines can read)", hasFaq,
    hasFaq ? "FAQ schema found — pre-chunked answers machines love" : "No FAQPage schema",
    "Answer the questions customers already ask you (prices, hours, parking, walk-ins) on one page, so Google and AI tools can quote your answer instead of guessing (an FAQ page with FAQPage schema). Find the real questions in Google's 'People also ask', your reviews, and what people call and email about, then answer the top 10.");
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
      "Your site is telling some AI tools to stay out, so they can't read your pages (a block in your robots.txt file). Remove the blocks for the AI readers you want: GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Meta-ExternalAgent, Applebot-Extended, Amazonbot and the rest. Precision note: Google-Extended controls Gemini apps and model training; Google Search\u2019s own AI answers use the normal Googlebot.");
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
      "Add a short plain-text summary of your business and your key pages that some AI tools look for (an llms.txt file). Honest note: Google says its Search ignores llms.txt, so this is only for other AI tools. It takes about 20 minutes.");
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
      "Give Google and Bing a list of every page on your site so they don't miss any, and send it to both (a sitemap.xml submitted in Google Search Console and Bing Webmaster Tools at bing.com/webmasters). Bing matters for ChatGPT too: a Seer Interactive study (Feb 2025) found about 87% of ChatGPT's search citations matched Bing's top results. Google notes small, well-linked sites may not strictly need a sitemap; the Bing step is the one most businesses skip.");
    upd(l, hasSm ? "ok" : "warn", hasSm ? "sitemap.xml found" : "No sitemap.xml");
  }

  const metaRobots = (doc.querySelector('meta[name="robots"]')||{content:""}).content || "";
  const noindex = /noindex/i.test(metaRobots);
  const hasCanonical = !!doc.querySelector('link[rel="canonical"]');
  add("code", 6, "Indexable — no noindex tag", !noindex,
    noindex ? "A noindex meta tag is telling EVERY search engine and AI to ignore this page" :
      (hasCanonical ? "No noindex; canonical URL set" : "No noindex (tip: add a canonical link tag)"),
    "Your page is telling Google and every AI tool to skip it, so customers searching can't find it (a noindex tag). Remove it, then add a canonical tag so machines know the one true address of each page.");
  log(noindex ? "bad" : "ok", noindex ? "CRITICAL: noindex tag found — invisible to all engines" : "Indexable — no noindex tag");

  const snippetBlocked = /nosnippet/i.test(metaRobots) || /max-snippet\s*:\s*0(?!\d)/i.test(metaRobots);
  add("code", 4, "Snippet-eligible (AI Overviews kill switch off)", !snippetBlocked,
    snippetBlocked ? "A nosnippet or max-snippet:0 directive is set — by Google's own rules this makes the page INELIGIBLE for AI Overviews and AI Mode" :
      "No nosnippet/max-snippet restrictions — eligible for AI answers per Google's documentation",
    "Your page is set so Google can't show a preview of it, and that also keeps it out of Google's AI answers (nosnippet or max-snippet:0 in your robots meta tag). Remove it. Google's documentation: a page must be eligible to show with a snippet to appear in AI Overviews or AI Mode.");
  const dns = (htmlLower.match(/data-nosnippet/g) || []).length;
  if(dns) log("warn", `data-nosnippet found on ${dns} element${dns>1?"s":""} — that content is invisible to Google's AI answers (fine if intentional; costly if it wraps prices, hours, or your best answers)`);
  log(snippetBlocked ? "bad" : "ok", snippetBlocked ? "CRITICAL: snippet controls block AI Overviews eligibility" : "Snippet-eligible — no AI Overviews kill switch (Google)");

  const msBlocked = /noarchive/i.test(metaRobots);
  const msLimited = /nocache/i.test(metaRobots);
  add("code", 4, "Copilot-eligible (Microsoft's AI kill switch off)", !msBlocked,
    msBlocked ? "A noarchive tag is set — by Microsoft's rules this EXCLUDES your content from Copilot answers entirely (not even a link). Many older sites carry this tag innocently: for 20 years it just hid the 'Cached' link. Now it erases you from Microsoft's AI." :
      msLimited ? "A nocache tag limits Copilot to your URL, title and snippet only — partial visibility in Microsoft's AI answers" :
      "No noarchive/nocache restrictions — fully eligible for Copilot answers per Microsoft's rules",
    "An old setting on your page keeps it out of Microsoft Copilot's answers (the noarchive meta tag). It used to only hide the 'Cached' link; under Microsoft's current rules it excludes your content from Copilot. Remove it. This one is for Bing and Copilot.");
  log(msBlocked ? "bad" : msLimited ? "warn" : "ok",
    msBlocked ? "CRITICAL: noarchive tag erases this site from Copilot (Microsoft)" :
    msLimited ? "nocache limits Copilot to snippet-only (Microsoft)" : "Copilot-eligible — no Microsoft AI kill switch");

  const jsOnly = bodyText.length < 400;
  add("code", 6, "Content readable without JavaScript", !jsOnly,
    jsOnly ? `Only ${bodyText.length} characters of visible text in raw HTML — AI crawlers likely see a blank page` : `${Math.round(bodyText.length/100)/10}k characters of machine-readable text`,
    "Your words only show up after the page runs extra code, and most AI readers don't run that code, so to them your site looks almost empty (JavaScript-only rendering). Put your text in the page itself (static pages or server-side rendering).");
  log(jsOnly ? "bad" : "ok", jsOnly ? "Very little text in raw HTML — likely JavaScript-only rendering" : "Real text present in raw HTML");

  /* CONTENT pillar */
  l = log("run", "Analyzing content signals…");
  const title = (doc.querySelector("title")||{}).textContent || "";
  const desc = (doc.querySelector('meta[name="description"]')||{content:""}).content || "";
  add("content", 4, "Title & meta description", title.length >= 15 && desc.length >= 60,
    `Title: ${title ? '"' + title.slice(0,60) + '"' : "missing"} · Description: ${desc ? desc.length + " chars" : "missing"}`,
    "Say what you do, for whom, and where in your page title and in the short summary under it in search results, because that's the first thing Google, Bing and AI tools read (the title tag and a 120–160 character meta description).");

  const h1s = [...doc.querySelectorAll("h1")].map(h => h.textContent.trim()).filter(Boolean);
  add("content", 3, "Clear H1 headline", h1s.length >= 1,
    h1s.length ? `H1: "${h1s[0].slice(0,70)}"` : "No H1 heading — the page never states its main topic in the strongest signal position",
    "Put one big headline at the top of the page that says what you do and where, for example 'Family taqueria in downtown Napa' (one H1 heading). It's the clearest signal of what the page is about, for Google, Bing and AI tools alike.");

  const imgs = [...doc.querySelectorAll("img")];
  const noAlt = imgs.filter(im => !(im.getAttribute("alt")||"").trim()).length;
  add("content", 2, "Images described for machines (alt text)", imgs.length === 0 || noAlt <= imgs.length * 0.2,
    imgs.length === 0 ? "No images on the page — nothing to describe" :
      noAlt === 0 ? `All ${imgs.length} images have alt text` :
      // passes up to 20% missing (weight 2: a few unlabeled images is a nudge, not a failure) —
      // but say so, or a PASS card reading "invisible to AI" looks like a scanner bug
      noAlt <= imgs.length * 0.2 ? `${imgs.length - noAlt} of ${imgs.length} images have alt text — passes (up to 20% missing allowed), but the other ${noAlt} have no text description for AI tools or screen readers` :
      `${noAlt} of ${imgs.length} images have no alt text, so AI tools and screen readers get no description of them`,
    "Add a short description to each photo, because machines can't see pictures, only the words attached to them (alt text). Something like 'carne asada plate with rice and beans' works. It also helps customers who use screen readers, and Google's own basics name alt text explicitly.");

  const hasOg = !!doc.querySelector('meta[property^="og:"]');
  add("code", 2, "Open Graph tags (link previews & social signals)", hasOg,
    hasOg ? "Open Graph tags present" : "No Open Graph tags — links to your site show bare, title-less previews when shared",
    "Make your link show a title, photo and description when someone texts or shares it, instead of a bare web address (Open Graph tags: og:title, og:description, og:url and a 1200×630 og:image). That works in Messages, WhatsApp, social apps and the AI assistants that share links.");

  const heads = pageDocs.flatMap(p => [...p.d.querySelectorAll("h1,h2,h3")].map(h => h.textContent.trim())).filter(Boolean);
  const qHeads = heads.filter(h => /\?|^(how|what|why|when|where|who|which|can|should|do|does|is|are)\b/i.test(h));
  add("content", 5, "Question-style headings (answer-ready structure)", qHeads.length >= 1,
    qHeads.length ? `${qHeads.length} question-style heading(s), e.g. "${qHeads[0].slice(0,60)}"` : `${heads.length} headings found, none phrased as customer questions`,
    "Turn your section headings into the questions customers really ask, and answer each one right below in a few plain sentences (question-style headings with answer-first paragraphs). AI tools tend to quote short, direct answers like that.");

  const year = new Date().getFullYear().toString();
  const fresh = htmlLower.includes(year) || doc.querySelector("time") !== null || ld.some(o => o.dateModified || o.datePublished);
  add("content", 4, "Freshness signals (dates, current year)", fresh,
    fresh ? "Current-year or dated content detected" : "No visible dates or current-year references found",
    "Show when your page was last updated and keep the info current, so customers and machines can tell it's still true (visible dates, plus dateModified in your schema).");

  // Left word boundaries are required: a bare `rates\b` also matches "United Arab EmiRATES",
  // which appears in the embedded country list of many contact-form / phone-input widgets.
  const priceRe = /\$\s?\d|€\s?\d|£\s?\d|\bpricing\b|\bprice list\b|\bour prices\b|\brates\b/i;
  const pricePage = pageDocs.find(p => priceRe.test(textOf(p.d)));
  const price = !!pricePage || [...doc.querySelectorAll("a")].some(a => /\bpricing\b|\bprices\b|\brates\b/i.test(a.getAttribute("href")||""));
  add("content", 5, "Pricing transparency", price,
    price ? (pricePage ? `Price information found on ${pathOf(pricePage.u)}` : "Pricing page linked from your homepage") : `No prices found on your homepage${interior.length ? " or " + interior.map(p=>pathOf(p.u)).join(", ") : ""}`,
    "Put your prices, or honest price ranges, on your site so customers and AI tools can answer “how much?” without calling (visible pricing). If your site only says “Contact us for pricing,” an AI answer has nothing from you to quote.");
  upd(l, "ok", "Content signals analyzed");

  /* ENTITY pillar */
  l = log("run", "Checking entity signals…");
  const links = [...doc.querySelectorAll("a")].map(a => (a.getAttribute("href")||"").toLowerCase());
  const socials = [...new Set(links.map(h => (h.match(/(instagram|facebook|linkedin|youtube|tiktok|yelp|x)\.com/)||[])[1]).filter(Boolean))];
  add("entity", 5, "Linked profiles (socials, review sites)", socials.length >= 2,
    socials.length ? `Linked: ${socials.join(", ")}` : "No profile links found on the homepage",
    "Link your Google, Yelp, Facebook, Instagram and LinkedIn pages from your site, so machines can tell they all belong to the same business (profile links, plus a sameAs list in your schema). LinkedIn is owned by Microsoft and shows up in Bing.");

  const tel = links.some(h => h.startsWith("tel:")) || ld.some(o => o.telephone) || /\(\d{3}\)\s?\d{3}[- ]\d{4}|\+\d{7,}/.test(bodyText);
  const mail = links.some(h => h.startsWith("mailto:")) || ld.some(o => o.email);
  add("entity", 4, "Machine-readable contact info", tel || mail,
    tel ? "Phone/contact detected" : mail ? "Clickable email contact detected" : "No clickable phone or email, and no contact info in your schema",
    "Make your phone number and email tappable, so customers can reach you in one tap and machines can confirm how to contact you (a tel: or mailto: link, plus contact details in your schema).");
  upd(l, "ok", "Entity signals checked");

  /* AGENTS pillar */
  l = log("run", "Checking agent-readiness…");
  const bookRe = /book (now|online|an appointment)|add to cart|buy now|order online|reserve/i;
  const bookish = links.some(h => /calendly|acuity|booksy|squareup|square\.site|setmore|appointlet|bookings?|schedule|checkout|cart|shop|store|buy|order|reserv/i.test(h)) || pageDocs.some(p => bookRe.test(textOf(p.d)));
  add("agents", 6, "Online booking / purchase path", bookish,
    bookish ? "Booking or purchase path detected" : "No booking link, cart, or ordering path found",
    "Give customers a way to book or buy online, so they (or an AI assistant acting for them) can do it without calling (a booking link like Calendly or your industry's platform, or online checkout).");

  add("agents", 3, "Secure connection (https)", origin.startsWith("https"),
    origin.startsWith("https") ? "HTTPS in place" : "Site not served over HTTPS",
    "Make your site load securely so browsers don't warn customers away (move it to HTTPS).");
  upd(l, "ok", "Agent-readiness checked");

  const passed = auto.filter(a => a.pass).length;
  log("info", `Scan complete: ${passed} of ${auto.length} automated checks passed.`);
  return {origin, url};
}

/* ---------- manual questions ---------- */
const MQS = [
 {p:"entity", w:6, t:"Is your Google Business Profile claimed, 100% complete, and updated in the last 30 days?",
   h:"It feeds Google's AI answers directly; inactive profiles lose impressions.",
   fix:"Claim your free Google listing, fill in every field, and post 1–2 times a week, because it's what Google shows (and feeds its AI answers) when people look for you (Google Business Profile). Get your main category exactly right: Whitespark's 2026 Local Search Ranking Factors survey rates the primary category the #1 factor for the map results, and an incorrect one the #2 negative factor."},
 {p:"entity", w:5, t:"Have you received (and responded to) reviews in the last 30 days?",
   h:"Volume, recency, and responses are core AI trust signals.",
   fix:"Ask every happy customer for a Google review and reply to every review, because recent, answered reviews are what new customers and machines use to decide if you're trustworthy (a review habit). Ask on Google; Yelp prohibits asking for reviews. Local-ranking research (Sterling Sky) finds rankings dip after about 3 weeks without a fresh review, so build the habit, not a blitz."},
 {p:"entity", w:5, t:"Have you claimed Bing Places AND Apple Business (formerly Business Connect)?",
   h:"Bing Places feeds Microsoft Copilot and Alexa; Apple's registry is what Siri reads for local place lookups (Siri hands harder questions to a general AI model that reads the open web instead).",
   fix:"Claim your free Bing and Apple listings, so Copilot, Alexa and Siri have your right hours and address (Bing Places at bing.com/forbusiness and Apple Business at business.apple.com). Apple's listing is the source behind Siri and Apple Intelligence local place lookups, but never the only one: broader questions go to a general AI model reading the web. Apple is folding Business Connect into a platform called Apple Business; the claiming step is unchanged."},
 {p:"entity", w:4, t:"Is your business listed with current info on Yelp (or your industry's main review site)?",
   h:"Alexa+ pulls local business data primarily from Yelp; Perplexity uses it for local answers too.",
   fix:"Claim your free Yelp page and keep your hours and services current, because Alexa+ pulls local business info mainly from Yelp and Perplexity uses it too (your listing at biz.yelp.com)."},
 {p:"agents", w:6, t:"Live test: ask 2–3 AI assistants (ChatGPT, Gemini, Claude, Grok…) “What is [your business name]?” — do they answer accurately?",
   h:"Copy that prompt into a couple of them right now. Accurate = yes. Wrong or “I don't know” = no.",
   fix:"AI tools don't have a clear picture of your business yet, so they answer wrong or not at all when asked about you (no entity formed). Fix your profiles, schema and consistency, then re-test monthly across ChatGPT, Gemini, Claude, Perplexity, Copilot and Grok."},
 {p:"agents", w:5, t:"Live test: ask ChatGPT, Perplexity or Google AI Mode “best [your category] in [your area]” — are you mentioned?",
   h:"This is the money question your customers already ask, on every AI platform.",
   fix:"When customers ask AI for the best business like yours nearby, you're not in the answer yet (no AI mentions). Work the full system: business profiles, answer-first content, schema and reviews, then re-run this test monthly on each major engine."},
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
let scannedIndustry = "";
let lastBlocked = [];
let unlocked = false;
let scanFailed = false; // true when runScan returned fatal "unreachable": no automated check ran, so NO score may be shown
const NOSCORE_MSG = "We couldn't read your site this time. That doesn't mean AI can't \u2014 it means our scanner couldn't open it. Try again in a few minutes, or leave your email below and we'll run it for you.";
function noScore(){
  // never turn "we couldn't look" into a grade: a 0 here would be a false "invisible" verdict
  return scanFailed || computeScore().max === 0;
}
function computeScore(){
  // AO Score counts ONLY verified automated checks — never self-reported answers,
  // and never penalizes a check we couldn't read (skips excluded from the denominator).
  let got = 0, max = 0;
  const per = {}; PILLARS.forEach(pl => per[pl.id] = {got:0, max:0, name:pl.name});
  auto.forEach(a => { if(a.skip) return; max += a.w; per[a.p].max += a.w; if(a.pass){ got += a.w; per[a.p].got += a.w; } });
  return {score: max ? Math.round(got/max*100) : 0, per, max};
}
function grade(s){
  if(s >= 85) return ["Agent-ready","You're in good shape. Re-check every few months; this changes fast."];
  if(s >= 65) return ["Visible, with gaps","Machines can read most of your site. The fixes below close the gaps."];
  if(s >= 40) return ["Half-readable","Machines can read parts of your site, but key details are hard for them to find. The fixes below show what's in the way."];
  return ["Hard for machines to read","Google and AI have trouble reading your site right now. The fixes below are what's in the way."];
}
const gateDefaults = {};
function setGateMode(noscore){
  const h = document.querySelector("#gate h3"), p = document.querySelector("#gate .gate > p"), b = document.getElementById("gbtn");
  if(!gateDefaults.h){ gateDefaults.h = h.textContent; gateDefaults.p = p.textContent; gateDefaults.b = b.textContent; }
  h.textContent = noscore ? "Want us to run it for you?" : gateDefaults.h;
  p.textContent = noscore ? "Leave your email and we'll open your site by hand and send you what we find." : gateDefaults.p;
  b.textContent = noscore ? "Send it" : gateDefaults.b;
  document.getElementById("gate").classList.toggle("inline", noscore);
  document.getElementById("results").classList.toggle("noscore", noscore);
}
function showNoScore(locked){
  setGateMode(true);
  document.getElementById("r-head").textContent =
    `We couldn't read ${scannedBiz || scannedUrl.replace(/^https?:\/\//,"") || "your site"} this time`;
  const box = document.getElementById("r-noscore");
  box.hidden = false;
  document.getElementById("r-noscore-msg").textContent = locked ? NOSCORE_MSG
    : "Got it. We'll open your site by hand and email you what we find. Nothing to do on your end.";
  document.getElementById("results").style.display = "block";
  const rc = document.getElementById("r-content");
  rc.classList.remove("locked");
  const gate = document.getElementById("gate");
  if(locked){ gate.hidden = false; }
  else { unlocked = true; gate.hidden = true; }
  document.getElementById("results").scrollIntoView({behavior:"smooth"});
}
function showResults(locked){
  if(noScore()){ showNoScore(locked); return; }
  setGateMode(false);
  document.getElementById("r-noscore").hidden = true;
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
  document.getElementById("r-findings").innerHTML = "<h3>What the scan verified</h3>" +
    auto.map(a => `<div class="finding ${a.skip?"check":a.pass?"pass":"fail"}"><span class="fi">${a.skip?"?":a.pass?"✓":"✗"}</span>
      <span>${a.label}<br><span class="fd">${a.detail}</span></span></div>`).join("") +
    `<h3 style="margin-top:1.5rem">Your self-assessment <span style="font-weight:400;font-size:.78rem;color:var(--dim)">— you told us these; they don't affect your verified score. We confirm them in your full audit.</span></h3>` +
    MQS.map((q,i) => `<div class="finding ${manswers[i]==="yes"?"pass":manswers[i]==="no"?"fail":"check"}">
      <span class="fi">${manswers[i]==="yes"?"✓":manswers[i]==="no"?"✗":"?"}</span>
      <span>${q.t.replace("Live test: ","").replace("[your category]", scannedIndustry || "[your category]")} <span class="fd">(self-reported)</span></span></div>`).join("");
  const missedAuto = auto.filter(a => !a.pass && !a.skip).map(a => ({w:a.w, t:a.label, fix:a.fix, self:false}));
  const missedMan = MQS.map((q,i) => ({w:q.w, t:q.t.replace("Live test: ","").replace("[your category]", scannedIndustry || "[your category]"), fix:q.fix, a:manswers[i], self:true}))
    .filter(q => q.a !== "yes");
  const missed = [...missedAuto, ...missedMan].sort((a,b) => b.w - a.w).slice(0,5);
  document.getElementById("r-fixes").innerHTML =
    missed.length === 0
    ? `<h3>No verified gaps found. Seriously impressive.</h3><p class="dim">Re-audit monthly — AI surfaces change fast.</p>`
    : `<h3>Fix these first (in priority order)</h3>` + missed.map((q,n) =>
      `<div class="fix"><b>${n+1}. ${q.t}${q.self?' <span style="font-weight:400;font-size:.72rem;color:var(--dim)">(self-reported \u2014 we verify this in your audit)</span>':""}</b><p>${q.fix}</p></div>`).join("");
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
  scannedIndustry = document.getElementById("industry").value.trim();
  const err = document.getElementById("urlerr");
  if(!raw || !raw.includes(".")){ err.textContent = "Enter your website address — like website.com"; return; }
  err.textContent = "";
  const btn = document.getElementById("scanbtn");
  btn.disabled = true; btn.textContent = "Scanning…";
  document.getElementById("scanpanel").style.display = "block";
  document.getElementById("results").style.display = "none";
  document.getElementById("manual").style.display = "none";
  document.getElementById("gate").hidden = true;
  manswers.fill(null);
  unlocked = false;
  scanFailed = false;
  document.getElementById("scanpanel").scrollIntoView({behavior:"smooth"});
  if(typeof gtag === "function") gtag("event", "scan_started", {});
  const res = await runScan(raw);
  btn.disabled = false; btn.textContent = "Scan my website →";
  relayOutage = !!res.relayDown;
  if(res.fatal === "unreachable"){
    scannedUrl = res.url || raw;
    scanFailed = true;
    document.getElementById("scantitle").textContent = relayOutage
      ? "Our scanner is briefly busy — we'll run your scan for you"
      : "We couldn't read your site";
    // no automated check ran: skip the quiz and the score entirely, go straight to the message + email capture
    showResults(true);
    return;
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
  if(typeof fbq === "function") fbq("track", "Lead");
  const leadName = document.getElementById("g-name").value.trim();
  const btn = document.getElementById("gbtn");
  const ns = noScore();
  btn.disabled = true; btn.textContent = ns ? "Sending…" : "Unlocking…";
  const {score, per} = computeScore();
  const failed = ns ? "not scanned (our scanner couldn't open the site)" : (auto.filter(a => !a.pass && !a.skip).map(a => a.label).join(" · ") || "none");
  const gname = leadName;
  const g = ns ? "Not scored" : grade(score)[0];
  const pillarsTxt = ns ? "not scanned" : PILLARS.map(pl => `${pl.name} ${per[pl.id].max?Math.round(per[pl.id].got/per[pl.id].max*100):0}%`).join(" · ");
  const wins = [...auto.filter(a => !a.pass && !a.skip).sort((a,b) => b.w - a.w)].slice(0,3);
  const site = scannedUrl.replace(/^https?:\/\//,"");
  const autoreply = ns ?
`Hi ${gname || "there"},

Thanks for asking us to check ${scannedBiz || site} (${site}).

Our scanner couldn't open your site this time. That doesn't mean AI can't read it. It means our scanner couldn't get in, so we didn't give you a score.

We'll open your site by hand and email you what we find.

Talk soon,
Alejandro
Be the Answer — aoaudit.com`
  :
`Hi ${gname || "there"},

Here is your AO snapshot (Answer Optimization) for ${scannedBiz || scannedUrl.replace(/^https?:\/\//,"")} (${scannedUrl.replace(/^https?:\/\//,"")}):

SCORE: ${score}/100 — ${g}
PILLARS: ${pillarsTxt}

Your 3 biggest gaps:
${wins.length ? wins.map((f,n) => `${n+1}. ${f.fix}`).join("\n") : "Your verified on-page checks all pass \u2014 the full report focuses on the profile, review, and AI-mention items we confirm with you directly."}

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
      industry: scannedIndustry || "(not given)",
      score: ns ? "not scored" : String(score),
      grade: g,
      scan_status: ns ? (relayOutage ? "relay_outage" : "site_unreachable") : "scanned",
      pillars: pillarsTxt,
      failed_checks: failed,
      next_action: relayOutage
        ? "RELAY OUTAGE during their scan — automated checks are missing. Run the full scan manually, then send their PDF report within 48 hours"
        : ns
        ? "SCANNER COULDN'T OPEN THEIR SITE (down, or it turns away automated readers). No score was shown. Run the scan manually, then email them what you find"
        : "Send their full PDF report within 48 hours",
      report_json: JSON.stringify({
        business: scannedBiz, site: scannedUrl.replace(/^https?:\/\//,"").replace(/\/$/,""),
        name: gname, email, score: ns ? null : score, grade: ns ? null : g, relay_outage: relayOutage,
        scan_status: ns ? (relayOutage ? "relay_outage" : "site_unreachable") : "scanned",
        pillars: ns ? null : Object.fromEntries(PILLARS.map(pl =>
          [pl.name, per[pl.id].max ? Math.round(per[pl.id].got/per[pl.id].max*100) : 0])),
        blocked: lastBlocked,
        findings: [
          ...auto.map(a => [a.label, a.skip ? "verify" : a.pass ? "pass" : "fail", a.detail])
        ],
        self_reported: MQS.map((q,i) => [q.t.replace("Live test: ",""),
          manswers[i]==="yes" ? "yes" : manswers[i]==="no" ? "no" : "unsure", q.h, q.fix]),
        fixes: [...auto.filter(a => !a.pass && !a.skip).map(a => ({t:a.label, f:a.fix, w:a.w}))]
               .sort((a,b) => b.w - a.w).slice(0,5)
      }),
      _subject: ns
        ? `AO Audit lead — ${scannedBiz || site} — couldn't scan, run it manually`
        : `AO Audit lead — ${scannedBiz || site} scored ${score}`,
      _template: "table",
      _autoresponse: autoreply
    })
  }).catch(()=>{}).finally(() => {
    btn.disabled = false; btn.textContent = ns ? "Send it" : "Send it & unlock my report";
    showResults(false);
  });
});

document.getElementById("reset").addEventListener("click", e => { e.preventDefault(); location.href = "#"; location.reload(); });
