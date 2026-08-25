#!/usr/bin/env python3
"""
Per-prospect tracking links for aoaudit.com.

Mints a unique URL for one prospect. When that URL is opened, GA4 records a
`prospect_open` event carrying the company name, and then forwards to the real
page with UTMs attached. Because the URL is given to exactly one prospect and
appears nowhere else, a hit on it IS that prospect opening it. Not a
probabilistic match -- a fact.

Run from the repo root:
  python3 _scripts/prospect_link.py --company "Trinchero Family Estates" \
      --dest napa-report.html --campaign napa-aug

  python3 _scripts/prospect_link.py --list        # show every link minted
  python3 _scripts/prospect_link.py --company X --remove

Writes:  p/<slug>.html               (noindex, never in sitemap)
Logs to: _scripts/prospect-links.csv (underscore dir = not served publicly)

NOTE: these pages deliberately carry GA4 only, never the Meta Pixel. The URL
contains the prospect's business name, so a Meta Pixel here would hand our
prospect list to Meta.
"""
import argparse, csv, datetime, html, os, re, sys
from string import Template
from urllib.parse import quote

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GA4_ID = "G-YG4SL7CCMS"
SITE = "https://aoaudit.com/"
OUTDIR = os.path.join(REPO, "p")
REGISTRY = os.path.join(REPO, "_scripts", "prospect-links.csv")
FIELDS = ["created", "slug", "company", "contact", "campaign", "dest", "url"]

PAGE = Template("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>The AO Audit</title>
<link rel="canonical" href="${site}${dest}">
<!-- GA4 only. No Meta Pixel here on purpose: this URL names the prospect. -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${ga4}', { page_title: 'prospect: ${company_js}' });

  var DEST = "${target_js}";
  var sent = false;
  function go(){ if (sent) return; sent = true; location.replace(DEST); }

  gtag('event', 'prospect_open', {
    prospect_slug: '${slug}',
    prospect_company: '${company_js}',
    campaign_name: '${campaign}',
    destination: '${dest}',
    event_callback: go
  });
  // Fallback: never make a human wait on a beacon.
  setTimeout(go, 1000);
</script>
<noscript><meta http-equiv="refresh" content="0;url=${target_html}"></noscript>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f7f9fc;color:#0f2137;font:1rem/1.7 system-ui,-apple-system,sans-serif;text-align:center}
  .w{padding:2rem}
  a{color:#1a5fd0}
  .k{font:700 .78rem/1 system-ui;letter-spacing:.14em;text-transform:uppercase;color:#5b6b7f}
</style>
</head>
<body>
<div class="w">
  <p class="k">The AO Audit</p>
  <p>One moment&hellip;</p>
  <p><a href="${target_html}">Continue &rarr;</a></p>
</div>
</body>
</html>
""")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def load():
    if not os.path.exists(REGISTRY):
        return []
    with open(REGISTRY, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def save(rows):
    with open(REGISTRY, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description="Mint a per-prospect tracking link.")
    ap.add_argument("--company", help="Business name, exactly as you'd say it to them")
    ap.add_argument("--dest", default="index.html", help="Page they land on (default index.html)")
    ap.add_argument("--campaign", default="outreach", help="Campaign tag, e.g. napa-aug")
    ap.add_argument("--contact", default="", help="Person's name, for your own records")
    ap.add_argument("--slug", default="", help="Override the auto slug")
    ap.add_argument("--remove", action="store_true", help="Delete this prospect's link")
    ap.add_argument("--list", action="store_true", help="List every link minted")
    o = ap.parse_args()

    rows = load()

    if o.list:
        if not rows:
            print("No prospect links minted yet.")
            return 0
        w = max(len(r["company"]) for r in rows)
        for r in rows:
            print(f"{r['created']}  {r['company']:<{w}}  {r['url']}")
        print(f"\n{len(rows)} link(s).")
        return 0

    if not o.company:
        ap.error("--company is required (or use --list)")

    slug = o.slug or slugify(o.company)
    if not slug:
        ap.error("could not build a slug from that company name -- pass --slug")

    path = os.path.join(OUTDIR, f"{slug}.html")

    if o.remove:
        if os.path.exists(path):
            os.remove(path)
        save([r for r in rows if r["slug"] != slug])
        print(f"Removed p/{slug}.html")
        return 0

    dest = o.dest.lstrip("/") or "index.html"
    if not os.path.exists(os.path.join(REPO, dest)):
        print(f"ERROR: destination page '{dest}' does not exist in the repo.", file=sys.stderr)
        return 1

    target = (
        f"{SITE}{dest}?utm_source=outreach&utm_medium=email"
        f"&utm_campaign={quote(o.campaign)}&utm_content={quote(slug)}"
    )
    url = f"{SITE}p/{slug}.html"

    os.makedirs(OUTDIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(PAGE.substitute(
            site=SITE, ga4=GA4_ID, dest=dest, slug=slug, campaign=html.escape(o.campaign),
            company_js=o.company.replace("\\", "\\\\").replace("'", "\\'"),
            target_js=target.replace("\\", "\\\\").replace('"', '\\"'),
            target_html=html.escape(target, quote=True),
        ))

    rows = [r for r in rows if r["slug"] != slug]
    rows.append({
        "created": datetime.date.today().isoformat(),
        "slug": slug, "company": o.company, "contact": o.contact,
        "campaign": o.campaign, "dest": dest, "url": url,
    })
    rows.sort(key=lambda r: (r["campaign"], r["company"]))
    save(rows)

    print(f"\n  {o.company}")
    print(f"  Paste this in the email:  {url}")
    print(f"  Lands on:                 {dest}")
    print(f"  Shows in GA4 as:          prospect_open / {slug}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
