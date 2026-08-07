#!/usr/bin/env python3
"""
aoaudit.com pre-publish validator.

Run from the repo root:   python3 _scripts/validate.py
Exit code 0 = safe to push. Exit code 1 = something is wrong.

Checks, in order of how much damage they cause if wrong:

  ERRORS (block the push)
    1. JSON-LD parses as valid JSON
    2. FAQPage schema text matches the visible text on the page exactly
       (Google requires FAQ content to be visible. This is also a check
        our own scanner runs on customers, so we have to pass it.)
    3. Internal links resolve to files that exist
    4. Referenced images exist (og:image, logo, thumbnails)
    5. Every page is in sitemap.xml, and every sitemap URL is a real file
    6. hreflang pairs point at each other in both directions
    7. Every page has a canonical URL

  WARNINGS (reported, do not block)
    8. Em dash count per page (house style: rare, not banned)
    9. Buzzwords from the house style list

Lives in _scripts/ because Jekyll excludes underscore folders from the
built site, so this file is never served publicly.
"""

import json
import os
import re
import sys
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://aoaudit.com/"

# Files that are not real content pages.
SKIP = {"google876316be06045643.html"}

BUZZWORDS = [
    "streamline", "leverage", "unlock", "empower", "seamless",
    "robust", "elevate", "supercharge", "game-changer", "cutting-edge",
]

# Em dashes allowed per page before we mention it.
EM_DASH_BUDGET = 1

errors = []
warnings = []


def err(page, msg):
    errors.append((page, msg))


def warn(page, msg):
    warnings.append((page, msg))


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s).strip()


def page_files():
    out = []
    for f in sorted(os.listdir(REPO)):
        if f.endswith(".html") and f not in SKIP:
            out.append(f)
    return out


def ld_blocks(html):
    return re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.S
    )


def check_jsonld(page, html):
    """1. JSON-LD must parse."""
    parsed = []
    for i, block in enumerate(ld_blocks(html), 1):
        try:
            parsed.append(json.loads(block))
        except json.JSONDecodeError as e:
            err(page, "JSON-LD block %d is invalid: %s" % (i, e))
    return parsed


def visible_faq_pairs(html):
    """
    Pull visible question/answer pairs. Two layouts are used on this site:
      <p class="q">Q</p><p class="a">A</p>      (pricing pages)
      <h3>Q</h3><p>A</p>                        (article pages)
    For the h3 layout, only look after the FAQ heading so body subheads
    are not mistaken for questions.
    """
    # layout A: pricing pages
    if '<p class="q">' in html:
        return re.findall(r'<p class="q">(.*?)</p>\s*<p class="a">(.*?)</p>', html, re.S)

    # layout B: homepage objection cards -> <div class="q"><h3 class="qt">Q</h3><ul class="objs">...
    if '<div class="q">' in html:
        out = []
        for blk in re.findall(r'<div class="q">(.*?)</div>', html, re.S):
            q = re.search(r'<h3[^>]*>(.*?)</h3>', blk, re.S)
            items = re.findall(r'<li>(.*?)</li>', blk, re.S)
            if q:
                out.append((q.group(1), " ".join(items)))
        return out

    parts = re.split(
        r"<h2>(?:FAQ|Common questions|Questions about pricing|"
        r"Preguntas frecuentes|Preguntas sobre precios)</h2>",
        html,
    )
    if len(parts) < 2:
        return []
    return re.findall(r"<h3>(.*?)</h3>\s*<p>(.*?)</p>", parts[-1], re.S)


def check_faq(page, html, parsed):
    """2. FAQ schema must match visible text exactly."""
    faqs = []
    for doc in parsed:
        nodes = doc.get("@graph", [doc]) if isinstance(doc, dict) else []
        for n in nodes:
            if isinstance(n, dict) and n.get("@type") == "FAQPage":
                faqs.append(n)
    if not faqs:
        return

    pairs = visible_faq_pairs(html)
    for faq in faqs:
        qs = faq.get("mainEntity", [])
        if not pairs:
            err(page, "has FAQPage schema but no visible Q&A block "
                      "(schema claims FAQ content the reader cannot see)")
            return
        if len(pairs) != len(qs):
            err(page, "FAQ count mismatch: schema has %d, page shows %d"
                % (len(qs), len(pairs)))
            return
        for i, q in enumerate(qs):
            want_q = q.get("name", "").strip()
            want_a = q.get("acceptedAnswer", {}).get("text", "").strip()
            got_q = strip_tags(pairs[i][0])
            got_a = strip_tags(pairs[i][1])
            if want_q != got_q:
                err(page, "FAQ Q%d question differs from the page" % (i + 1))
            if want_a != got_a:
                err(page, "FAQ Q%d answer differs from the page" % (i + 1))


def check_links(page, html):
    """3. Internal links must resolve."""
    hrefs = set(re.findall(r'href="(?!https?://|mailto:|tel:|#|data:)([^"#?]+)"', html))
    hrefs |= set(re.findall(r'href="https://aoaudit\.com/([^"#?]+)"', html))
    for h in hrefs:
        if not h:
            continue
        if not os.path.exists(os.path.join(REPO, h)):
            err(page, "broken internal link: %s" % h)


def check_images(page, html):
    """4. Referenced images must exist. Code samples in <pre> are illustrative, skip them."""
    html = re.sub(r"<pre.*?</pre>", "", html, flags=re.S)
    refs = set(re.findall(r'content="https://aoaudit\.com/([^"]+\.(?:png|jpg|jpeg|webp|svg))"', html))
    refs |= set(re.findall(r'src="(?!https?://|data:)([^"?]+\.(?:png|jpg|jpeg|webp|svg))"', html))
    refs |= set(re.findall(r'"(?:logo|image|thumbnailUrl)":\s*"https://aoaudit\.com/([^"]+)"', html))
    for r in refs:
        if not os.path.exists(os.path.join(REPO, r)):
            err(page, "missing image referenced: %s" % r)


def check_canonical(page, html):
    """7. Every page needs a canonical."""
    if not re.search(r'rel="canonical"', html):
        err(page, "no canonical URL")


def check_style(page, html):
    """8 and 9. House style, warnings only."""
    body = re.sub(r"<script.*?</script>|<style.*?</style>", "", html, flags=re.S)
    em = body.count("—") + body.count("&mdash;")
    if em > EM_DASH_BUDGET:
        warn(page, "%d em dashes in visible copy (budget %d)" % (em, EM_DASH_BUDGET))
    text = strip_tags(body).lower()
    hits = [w for w in BUZZWORDS if re.search(r"\b%s" % re.escape(w), text)]
    if hits:
        warn(page, "buzzwords: %s" % ", ".join(hits))


def check_sitemap(pages):
    """5. Sitemap must cover every page and only real pages."""
    path = os.path.join(REPO, "sitemap.xml")
    if not os.path.exists(path):
        err("sitemap.xml", "file is missing")
        return
    xml = open(path, encoding="utf-8").read()
    try:
        import xml.dom.minidom as X
        X.parseString(xml)
    except Exception as e:
        err("sitemap.xml", "invalid XML: %s" % e)
        return

    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    listed = set()
    for u in locs:
        name = u[len(SITE):] if u.startswith(SITE) else u
        listed.add(name if name else "index.html")

    for p in pages:
        target = "index.html" if p == "index.html" else p
        if target not in listed:
            err("sitemap.xml", "page not listed: %s" % p)

    for name in listed:
        if name.endswith(".html") and not os.path.exists(os.path.join(REPO, name)):
            err("sitemap.xml", "lists a file that does not exist: %s" % name)

    if "<lastmod>" not in xml:
        warn("sitemap.xml", "no lastmod dates (this is the field Google actually uses)")


def check_hreflang(pages):
    """6. hreflang pairs must be reciprocal."""
    declared = {}
    for p in pages:
        html = open(os.path.join(REPO, p), encoding="utf-8").read()
        es = re.search(r'hreflang="es" href="https://aoaudit\.com/([^"]+)"', html)
        en = re.search(r'hreflang="en" href="https://aoaudit\.com/([^"]+)"', html)
        if es and en:
            declared[p] = (en.group(1), es.group(1))

    for p, (en_f, es_f) in declared.items():
        other = es_f if p == en_f else en_f
        if other == p:
            continue
        if not os.path.exists(os.path.join(REPO, other)):
            err(p, "hreflang points at a file that does not exist: %s" % other)
            continue
        other_html = open(os.path.join(REPO, other), encoding="utf-8").read()
        if p not in other_html:
            err(p, "hreflang is not reciprocal: %s does not point back" % other)


def main():
    pages = page_files()
    for p in pages:
        html = open(os.path.join(REPO, p), encoding="utf-8").read()
        parsed = check_jsonld(p, html)
        check_faq(p, html, parsed)
        check_links(p, html)
        check_images(p, html)
        check_canonical(p, html)
        check_style(p, html)
    check_sitemap(pages)
    check_hreflang(pages)

    print("Checked %d pages.\n" % len(pages))

    if warnings:
        grouped = defaultdict(list)
        for page, msg in warnings:
            grouped[page].append(msg)
        print("WARNINGS (%d) - style only, not blocking:" % len(warnings))
        for page in sorted(grouped):
            for m in grouped[page]:
                print("  %-38s %s" % (page, m))
        print()

    if errors:
        grouped = defaultdict(list)
        for page, msg in errors:
            grouped[page].append(msg)
        print("ERRORS (%d) - fix before pushing:" % len(errors))
        for page in sorted(grouped):
            for m in grouped[page]:
                print("  %-38s %s" % (page, m))
        print("\nFAILED")
        return 1

    print("No errors. Safe to push.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
