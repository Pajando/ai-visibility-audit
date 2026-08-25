# ai-visibility-audit repo — house rules
This is aoaudit.com (GitHub Pages). Full operating manual: ~/Documents/BeTheAnswer/CLAUDE.md — read it.
- Push to main auto-deploys AND auto-pings Bing IndexNow with all sitemap URLs (.github/workflows/indexnow.yml).
- After adding a page: sitemap.xml entry + hreflang ES twin (Spanish-everything rule) + cross-links (hub what-is-answer-optimization.html + siblings) + GSC sitemap resubmit + Alejandro clicks Request Indexing.
- Analytics: GA4 (G-YG4SL7CCMS) is on EVERY content page. Any new page must carry the gtag block right after the viewport meta, or it is invisible to us.
- Per-prospect tracking links: `python3 _scripts/prospect_link.py --company "X" --dest page.html --campaign tag`. Writes p/<slug>.html (noindex, NOT in sitemap, never listed in robots.txt). Registry at _scripts/prospect-links.csv -- underscore dir, not served publicly, and it is a prospect list, so it stays that way.
- /p/ pages carry GA4 ONLY, never the Meta Pixel: the URL names the prospect, so a Meta Pixel there hands our prospect list to Meta.
- Article template: copy an existing article page (kicker, direct-answer .card first, tables, honest-limit card, FAQ + FAQPage schema matching visible text, footer point-back). Meta Pixel + brand CSS vars stay intact.
- Verify JSON-LD parses before pushing; verify live with curl after (never declare done unverified).
- Palette (white/blues, Alejandro's directive 2026-08-09 — supersedes the old cream/green): bg #f7f9fc, cards #fff, ink #0f2137, dim #5b6b7f, structure/deep blue #12459c, CTA neon orange #f43d00 (ACTION — single CTA per page; blue carries structure, orange carries action), links #1a5fd0, lines #e3eaf3, pale tint #e8f0fe. Scanner STATUS colors (pass green/fail red/warn amber) are semantic and stay unchanged.
- Never: fabricated stats, "SE Ranking" for the 87% stat (it's Seer Interactive Feb 2025), bingplaces.com (dead — bing.com/forbusiness), keyword stuffing, city pages without real scan data.
