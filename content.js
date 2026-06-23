/* NoSite Leads Helper — content script
 * Runs on https://www.google.com/maps/* pages.
 *
 * Responsibilities:
 *   1. "scan"        -> inspect the currently VISIBLE result cards in the
 *                       results feed and return businesses that appear to
 *                       have no website.
 *   2. "saveCurrent" -> inspect the currently OPENED business detail panel
 *                       and return that single business.
 *
 * IMPORTANT: Google Maps markup changes often and uses obfuscated, unstable
 * class names. So everything here is BEST-EFFORT and uses several fallback
 * strategies (aria-labels, button text, href patterns, text regexes). If a
 * field cannot be found we leave it blank rather than throwing. Every reader
 * is wrapped in try/catch so a single failure never breaks the whole scan.
 */

(function () {
  "use strict";

  // Avoid registering the listener twice if the script is injected again.
  if (window.__noSiteHelperLoaded__) return;
  window.__noSiteHelperLoaded__ = true;

  /* ----------------------------------------------------------------------
   * Small helpers
   * -------------------------------------------------------------------- */

  // Safe text content of an element.
  function text(el) {
    try {
      return (el && el.textContent ? el.textContent : "").trim();
    } catch (e) {
      return "";
    }
  }

  // Try a list of selectors against a root, return the first match.
  function pick(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* invalid selector in some browsers — ignore and continue */
      }
    }
    return null;
  }

  // Is an element actually rendered/visible on screen?
  function isVisible(el) {
    try {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (e) {
      return false;
    }
  }

  // Phone number pattern (North American + general international, loose).
  const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

  // Rating like "4.5" optionally followed by review count "(123)".
  const RATING_RE = /(\d(?:[.,]\d)?)\s*(?:stars?|étoiles?)?/i;
  const REVIEWS_RE = /\(?\s*([\d,. \s]{1,7})\s*\)?\s*(?:reviews?|avis|review)?/i;

  /* ----------------------------------------------------------------------
   * Website detection
   * -------------------------------------------------------------------- */

  // Words (multiple languages) that indicate a "Website" affordance.
  const WEBSITE_WORDS = [
    "website",
    "site web",
    "business website",
    "visit site",
    "open website",
    "sito web",
    "sitio web",
    "webseite",
  ];

  // Does the given href look like a real external website (not a Google/Maps
  // internal link)?
  function isExternalSite(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      const host = u.hostname.toLowerCase();
      if (!host) return false;
      // Internal / non-website hosts we should ignore.
      const internal = [
        "google.com",
        "google.ca",
        "goo.gl",
        "maps.google.com",
        "support.google.com",
        "accounts.google.com",
        "gstatic.com",
      ];
      if (internal.some((d) => host === d || host.endsWith("." + d))) return false;
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // Inspect a root element (a result card or the detail panel) and decide its
  // website status. Returns one of:
  //   "Website found", "No website detected", "Unknown"
  function detectWebsiteStatus(root) {
    try {
      if (!root) return "Unknown";

      // Strategy 1: explicit data attributes used by the detail panel.
      //   The "Website" action in the panel typically renders as
      //   <a data-item-id="authority" ...> or has a tooltip.
      const authority = pick(root, [
        'a[data-item-id="authority"]',
        'a[data-tooltip="Open website"]',
        'a[aria-label*="ebsite" i]',
      ]);
      if (authority && isExternalSite(authority.getAttribute("href"))) {
        return "Website found";
      }

      // Strategy 2: result cards expose a "Website" button as
      //   <a data-value="Website"> or a link whose aria-label mentions it.
      const cardWebsite = pick(root, [
        'a[data-value="Website"]',
        'a[data-value*="ebsite"]',
        'a[jsaction*="website" i]',
      ]);
      if (cardWebsite) return "Website found";

      // Strategy 3: scan anchors/buttons for website-like text or aria-labels.
      const clickables = root.querySelectorAll("a, button, [role='button']");
      for (const el of clickables) {
        const label = (
          (el.getAttribute && el.getAttribute("aria-label")) ||
          text(el) ||
          ""
        ).toLowerCase();
        if (!label) continue;
        if (WEBSITE_WORDS.some((w) => label.includes(w))) {
          // Confirm it's an external link when we can; otherwise trust label.
          const href = el.getAttribute && el.getAttribute("href");
          if (href) {
            if (isExternalSite(href)) return "Website found";
          } else {
            return "Website found";
          }
        }
      }

      // Strategy 4: any clearly-external anchor at all inside the card.
      const anchors = root.querySelectorAll("a[href]");
      for (const a of anchors) {
        if (isExternalSite(a.getAttribute("href"))) return "Website found";
      }

      return "No website detected";
    } catch (e) {
      return "Unknown";
    }
  }

  /* ----------------------------------------------------------------------
   * Field extraction from a RESULT CARD (search results feed)
   * -------------------------------------------------------------------- */

  function parseRatingAndReviews(root) {
    const out = { rating: "", reviews: "" };
    try {
      // The rating block in result cards is often role="img" with an
      // aria-label like "4.6 stars 128 Reviews".
      const ratingEl = pick(root, [
        '[role="img"][aria-label*="star" i]',
        '[role="img"][aria-label*="étoile" i]',
        "span.MW4etd", // observed rating span
        "span[aria-hidden='true']",
      ]);
      const label =
        (ratingEl &&
          ((ratingEl.getAttribute && ratingEl.getAttribute("aria-label")) ||
            text(ratingEl))) ||
        "";

      const rm = label.match(/(\d(?:[.,]\d)?)/);
      if (rm) out.rating = rm[1].replace(",", ".");

      // Review count — look for "(123)" or "123 reviews" near the rating.
      const reviewsEl = pick(root, [
        "span.UY7F9", // observed review-count span
        '[aria-label*="review" i]',
        '[aria-label*="avis" i]',
      ]);
      const rlabel =
        (reviewsEl &&
          ((reviewsEl.getAttribute && reviewsEl.getAttribute("aria-label")) ||
            text(reviewsEl))) ||
        label;
      const revm = rlabel.match(/\(?\s*([\d., ]{1,9})\s*\)?\s*(?:reviews?|avis)/i) ||
        rlabel.match(/\(\s*([\d., ]{1,9})\s*\)/);
      if (revm) out.reviews = revm[1].replace(/[^\d]/g, "");
    } catch (e) {
      /* leave blank */
    }
    return out;
  }

  // Find phone-looking text within a card.
  function findPhone(root) {
    try {
      // Detail-panel style button first.
      const phoneBtn = pick(root, [
        'button[data-item-id^="phone:tel:"]',
        'a[href^="tel:"]',
        '[aria-label*="Phone" i]',
        '[aria-label*="téléphone" i]',
      ]);
      if (phoneBtn) {
        const lbl =
          (phoneBtn.getAttribute && phoneBtn.getAttribute("aria-label")) ||
          (phoneBtn.getAttribute && phoneBtn.getAttribute("href")) ||
          text(phoneBtn);
        const m = (lbl || "").replace(/^tel:/, "").match(PHONE_RE);
        if (m) return m[1].trim();
      }
      // Fallback: regex the whole card text.
      const m = text(root).match(PHONE_RE);
      return m ? m[1].trim() : "";
    } catch (e) {
      return "";
    }
  }

  // Extract one result card into a lead object.
  function parseCard(card) {
    const lead = blankLead();
    try {
      // Name: the result link's aria-label, or a heading inside.
      const link = pick(card, [
        "a.hfpxzc", // observed result anchor
        'a[href*="/maps/place/"]',
      ]);
      lead.name =
        (link && link.getAttribute("aria-label")) ||
        text(pick(card, ['[role="heading"]', "div.qBF1Pd", "div.fontHeadlineSmall"])) ||
        "";
      lead.name = lead.name.trim();

      // Maps URL for this place.
      if (link && link.getAttribute("href")) {
        lead.mapsUrl = new URL(link.getAttribute("href"), location.href).href;
      }

      // Category / address / phone live in small detail rows. The card text
      // usually reads "Category · Address" then "Open · Phone" etc.
      const detailSpans = card.querySelectorAll(
        ".W4Efsd span, .fontBodyMedium span"
      );
      const bits = [];
      detailSpans.forEach((s) => {
        const t = text(s).replace(/^·\s*/, "").trim();
        if (t && t !== "·") bits.push(t);
      });

      // Heuristic: first non-rating bit is category, an address often
      // contains a digit + street word, phone matches PHONE_RE.
      for (const b of bits) {
        if (!lead.category && /[a-zA-Z]/.test(b) && !PHONE_RE.test(b) &&
            !/^\d(?:[.,]\d)?$/.test(b) && b.length < 40 && !lead.category) {
          // crude: categories are usually short words without street numbers
          if (!/\d{2,}/.test(b)) { lead.category = b; }
        }
        if (!lead.phone) {
          const pm = b.match(PHONE_RE);
          if (pm) lead.phone = pm[1].trim();
        }
        if (!lead.address && /\d/.test(b) && b.length > 6 && PHONE_RE.test(b) === false) {
          // addresses tend to contain a number + words
          if (/\d.*[a-zA-Z]/.test(b)) lead.address = b;
        }
      }
      if (!lead.phone) lead.phone = findPhone(card);

      const rr = parseRatingAndReviews(card);
      lead.rating = rr.rating;
      lead.reviews = rr.reviews;

      lead.websiteStatus = detectWebsiteStatus(card);
    } catch (e) {
      /* return whatever we managed to collect */
    }
    return lead;
  }

  /* ----------------------------------------------------------------------
   * Field extraction from the OPENED DETAIL PANEL
   * -------------------------------------------------------------------- */

  function parseDetailPanel() {
    const lead = blankLead();
    try {
      // The main detail panel is role="main" with aria-label = business name.
      const panel =
        document.querySelector('div[role="main"][aria-label]') ||
        document.querySelector('div[role="main"]');
      const scope = panel || document;

      // Name.
      lead.name =
        (panel && panel.getAttribute("aria-label")) ||
        text(pick(scope, ["h1.DUwDvf", "h1", '[role="heading"][aria-level="1"]'])) ||
        "";
      lead.name = lead.name.trim();

      // Category — a button next to the rating.
      lead.category = text(
        pick(scope, ["button.DkEaL", 'button[jsaction*="category"]'])
      );

      // Rating + reviews from the header block.
      const ratingEl = pick(scope, [
        "div.F7nice span[aria-hidden='true']",
        'span[aria-label*="star" i]',
      ]);
      const rtext =
        (ratingEl && text(ratingEl)) ||
        (ratingEl && ratingEl.getAttribute && ratingEl.getAttribute("aria-label")) ||
        "";
      const rm = rtext.match(/(\d(?:[.,]\d)?)/);
      if (rm) lead.rating = rm[1].replace(",", ".");

      const reviewsEl = pick(scope, [
        'button[aria-label*="review" i]',
        'span[aria-label*="review" i]',
        "div.F7nice span:nth-child(2)",
      ]);
      const revText =
        (reviewsEl &&
          ((reviewsEl.getAttribute && reviewsEl.getAttribute("aria-label")) ||
            text(reviewsEl))) ||
        "";
      const revm = revText.match(/([\d., ]{1,9})/);
      if (revm) lead.reviews = revm[1].replace(/[^\d]/g, "");

      // Address — button with data-item-id="address".
      const addrBtn = pick(scope, [
        'button[data-item-id="address"]',
        'button[aria-label^="Address" i]',
        'button[aria-label^="Adresse" i]',
      ]);
      if (addrBtn) {
        lead.address = (addrBtn.getAttribute("aria-label") || text(addrBtn))
          .replace(/^Address:\s*/i, "")
          .replace(/^Adresse\s*:\s*/i, "")
          .trim();
      }

      // Phone — button with data-item-id starting "phone:tel:".
      lead.phone = findPhone(scope);

      // Maps URL — current page URL is the place URL when a panel is open.
      lead.mapsUrl = location.href;

      // Website status.
      lead.websiteStatus = detectWebsiteStatus(scope);
    } catch (e) {
      /* best effort */
    }
    return lead;
  }

  /* ----------------------------------------------------------------------
   * Shared lead shape
   * -------------------------------------------------------------------- */

  function blankLead() {
    return {
      name: "",
      category: "",
      rating: "",
      reviews: "",
      address: "",
      phone: "",
      mapsUrl: "",
      websiteStatus: "Unknown",
      niche: "",
      city: "",
      notes: "",
      status: "Not Called",
      dateAdded: "",
    };
  }

  /* ----------------------------------------------------------------------
   * Search context — derive niche + city from the current Maps search
   *
   * Reads the search box (or the /maps/search/<query>/ URL) and splits it
   * into a niche and city using a light heuristic:
   *   - "barber, Ottawa"  -> niche "barber", city "Ottawa"
   *   - "barbershop Nepean" -> niche "barbershop", city "Nepean" (last token)
   * It's best-effort; you can always edit the fields on a saved lead.
   * -------------------------------------------------------------------- */

  function getSearchContext() {
    const ctx = { niche: "", city: "", query: "" };
    try {
      let q = "";
      const input = document.querySelector(
        "input#searchboxinput, input[aria-label='Search Google Maps'], input[name='q']"
      );
      if (input && input.value) q = input.value.trim();

      if (!q) {
        const m = location.pathname.match(/\/maps\/search\/([^/]+)/);
        if (m) q = decodeURIComponent(m[1]).replace(/\+/g, " ").trim();
      }
      ctx.query = q;
      if (!q) return ctx;

      if (q.includes(",")) {
        const parts = q.split(",");
        ctx.city = parts.pop().trim();
        ctx.niche = parts.join(",").trim();
      } else {
        const tokens = q.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2) {
          ctx.city = tokens[tokens.length - 1];
          ctx.niche = tokens.slice(0, -1).join(" ");
        } else {
          ctx.niche = q;
        }
      }
    } catch (e) {
      /* leave blank */
    }
    return ctx;
  }

  // Apply niche/city to a lead only where it doesn't already have a value.
  function applyContext(lead, ctx) {
    if (!lead.niche && ctx.niche) lead.niche = ctx.niche;
    if (!lead.city && ctx.city) lead.city = ctx.city;
    return lead;
  }

  /* ----------------------------------------------------------------------
   * Scan the visible results feed
   * -------------------------------------------------------------------- */

  function scanResultsFeed() {
    const feed =
      document.querySelector('div[role="feed"]') ||
      document.querySelector('div[role="main"]') ||
      document.body;

    // Result cards: try a few selectors, dedupe the set.
    let cards = [];
    try {
      cards = Array.from(
        feed.querySelectorAll(
          'div[role="article"], a.hfpxzc'
        )
      );
    } catch (e) {
      cards = [];
    }

    // If we matched anchors, climb to their card container to get full text.
    const seen = new Set();
    const leads = [];
    for (const node of cards) {
      let card = node;
      if (node.matches && node.matches("a.hfpxzc")) {
        card = node.closest('div[role="article"]') || node.parentElement || node;
      }
      if (!card || seen.has(card)) continue;
      if (!isVisible(card)) continue; // only what's currently visible
      seen.add(card);

      const lead = parseCard(card);
      if (lead.name) leads.push(lead);
    }

    // Attach the search niche/city to every scanned lead.
    const ctx = getSearchContext();
    leads.forEach((l) => applyContext(l, ctx));

    const total = leads.length;
    // Return businesses with no website detected OR unknown status; the popup
    // tags them so you can tell the two apart at a glance.
    const noWebsite = leads.filter(
      (l) => l.websiteStatus === "No website detected" || l.websiteStatus === "Unknown"
    );
    const detectedNone = noWebsite.filter((l) => l.websiteStatus === "No website detected").length;

    return { total, leads: noWebsite, allCount: total, detectedNone, context: ctx };
  }

  /* ----------------------------------------------------------------------
   * Message handling
   * -------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (!msg || !msg.action) {
        sendResponse({ ok: false, error: "No action specified." });
        return;
      }

      // Friendly guard: are we actually on a Google Maps page?
      const onMaps = /\/maps\b/.test(location.pathname) || /maps/.test(location.href);
      if (!onMaps) {
        sendResponse({
          ok: false,
          error: "This isn't a Google Maps page. Open Google Maps and search a niche/city first.",
        });
        return;
      }

      if (msg.action === "ping") {
        sendResponse({ ok: true, pong: true });
        return;
      }

      if (msg.action === "scan") {
        const result = scanResultsFeed();
        if (result.allCount === 0) {
          sendResponse({
            ok: false,
            error: "No visible business results found. Make sure a search results list is showing, then try again.",
          });
          return;
        }
        sendResponse({
          ok: true,
          leads: result.leads,
          allCount: result.allCount,
          noWebsiteCount: result.leads.length,
          detectedNone: result.detectedNone,
          context: result.context,
        });
        return;
      }

      if (msg.action === "saveCurrent") {
        const lead = parseDetailPanel();
        applyContext(lead, getSearchContext());
        if (!lead.name) {
          sendResponse({
            ok: false,
            error: "No open business panel found. Click a business on the map to open its details, then try again.",
          });
          return;
        }
        sendResponse({ ok: true, lead });
        return;
      }

      sendResponse({ ok: false, error: "Unknown action: " + msg.action });
    } catch (e) {
      sendResponse({ ok: false, error: "Unexpected error: " + (e && e.message) });
    }
    // synchronous response — no need to return true
  });
})();
