"use strict";

// Google Analytics 4 for the public site (never loaded on /admin/), behind a cookie banner.
// GA4 (and its cookies) only start after the visitor selects Accept; the choice is remembered in
// localStorage and can be changed from "Cookie settings" in the footer. Each first choice is also
// counted (just a daily total, no visitor data) in Supabase so the admin panel can show accept/decline.
// Page views, scrolls and outbound clicks come from GA4 enhanced measurement. This file adds the
// ticket funnel (called from checkout.js) and site interactions. No names, emails or phone numbers are sent.
// Add ?ga_debug=1 to any page URL to see its events live in GA4 > Admin > DebugView.
window.SummitAnalytics = (() => {
  const config = window.SUMMIT_CONFIG || {};
  const id = config.gaMeasurementId || "";
  const productionHost = /(^|\.)beyondthelimits\.co\.in$/.test(location.hostname);
  const enabled = /^G-[A-Z0-9]{4,}$/.test(id) && productionHost;
  const storageKey = "btl-cookie-consent";
  const copy = (typeof CONTENT !== "undefined" && CONTENT.consent) || {};

  function readChoice() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === "granted" || value === "denied" ? value : null;
    } catch {
      return null;
    }
  }
  function saveChoice(value) {
    try { localStorage.setItem(storageKey, value); } catch { /* The banner just shows again next visit. */ }
  }

  let choice = readChoice();
  let started = false;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };

  function track(name, params = {}) {
    if (!enabled || choice !== "granted") return;
    try { window.gtag("event", name, params); } catch { /* Analytics must never break the page. */ }
  }

  // Load GA4 only with consent. Advertising signals stay off.
  function start() {
    if (!enabled || started) return;
    started = true;
    window.gtag("consent", "default", {
      analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
    });
    const debug = new URLSearchParams(location.search).has("ga_debug");
    window.gtag("js", new Date());
    // GA4 treats any debug_mode value (even false) as debug traffic, so only set it when asked.
    window.gtag("config", id, debug ? { debug_mode: true } : {});
    const tag = document.createElement("script");
    tag.async = true;
    tag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.append(tag);
  }

  // Daily accept/decline totals for the admin panel (no visitor data). Never blocks or breaks the page.
  function count(value) {
    if (!productionHost || !config.supabaseUrl || !config.supabasePublishableKey) return;
    try {
      void fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/summit_record_consent", {
        method: "POST",
        headers: { apikey: config.supabasePublishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_choice: value === "granted" ? "accepted" : "declined" }),
        credentials: "omit",
        keepalive: true,
      }).catch(() => {});
    } catch { /* Counting is best effort. */ }
  }

  function clearGoogleCookies() {
    const host = location.hostname;
    const domains = ["", host, "." + host, "." + host.replace(/^www\./, "")];
    document.cookie.split(";").map((part) => part.split("=")[0].trim())
      .filter((name) => /^_ga/.test(name))
      .forEach((name) => domains.forEach((domain) => {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? "; domain=" + domain : ""}`;
      }));
  }

  let banner = null;
  function hideBanner() {
    if (!banner) return;
    banner.classList.remove("is-shown");
    const node = banner;
    banner = null;
    setTimeout(() => node.remove(), 320);
  }

  function decide(value) {
    const first = choice === null;
    const wasStarted = started;
    choice = value;
    saveChoice(value);
    if (first) count(value);
    hideBanner();
    if (value === "granted") {
      start();
    } else if (wasStarted) {
      // Withdrawing consent: stop GA4, remove its cookies, and reload so the tag is gone.
      window.gtag("consent", "update", { analytics_storage: "denied" });
      clearGoogleCookies();
      location.reload();
    }
  }

  function showBanner() {
    if (banner || !copy.title) return;
    banner = document.createElement("section");
    banner.className = "cookie-banner";
    banner.setAttribute("aria-label", copy.label || copy.title);
    const text = document.createElement("div");
    text.className = "cookie-banner-text";
    const title = document.createElement("p");
    title.className = "cookie-banner-title";
    title.textContent = copy.title;
    const body = document.createElement("p");
    body.textContent = copy.text;
    text.append(title, body);
    const actions = document.createElement("div");
    actions.className = "cookie-banner-actions";
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "button button-secondary";
    decline.textContent = copy.decline;
    decline.addEventListener("click", () => decide("denied"));
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "button button-primary";
    accept.textContent = copy.accept;
    accept.addEventListener("click", () => decide("granted"));
    actions.append(decline, accept);
    banner.append(text, actions);
    document.body.append(banner);
    requestAnimationFrame(() => requestAnimationFrame(() => banner?.classList.add("is-shown")));
  }

  if (choice === "granted") start();
  addEventListener("DOMContentLoaded", () => { if (choice === null) showBanner(); });

  // "Cookie settings" (footer) reopens the banner so the choice can be changed.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-cookie-settings]")) {
      event.preventDefault();
      showBanner();
    }
  });

  const text = (node) => (node.textContent || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const area = (node) => node.closest("nav, dialog, footer, section")?.id || "page";

  // Clicks on in-page links (menu, hero and section buttons, footer), email/phone links and the Expect tabs.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest("a[href]");
    if (link) {
      const href = link.getAttribute("href");
      if (href.startsWith("#")) {
        track("navigation_click", { link_text: text(link), link_target: href.slice(0, 60), link_location: area(link) });
      } else if (href.startsWith("mailto:") || href.startsWith("tel:")) {
        track("contact_click", { method: href.startsWith("mailto:") ? "email" : "phone", link_location: area(link) });
      }
      return;
    }
    const tab = target?.closest(".expect-tab");
    if (tab) track("select_content", { content_type: "what_to_expect", content_id: text(tab).replace(/^\d+\s*/, "") });
  }, { capture: true });

  // Which sections people actually reach (sent once per section per page view, after consent).
  addEventListener("DOMContentLoaded", () => {
    if (!enabled || !("IntersectionObserver" in window)) return;
    const seen = new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target }) => {
        if (!isIntersecting || choice !== "granted") return;
        seen.unobserve(target);
        track("section_view", { section_id: target.id });
      });
    }, { threshold: 0.35 });
    ["about", "expect", "speakers", "passes", "contact"].forEach((sectionId) => {
      const section = document.getElementById(sectionId);
      if (section) seen.observe(section);
    });
  });

  // GA4 ecommerce item for a pass. amountPaise is what Razorpay charges (GST inclusive).
  function item(tier, label, amountPaise) {
    const price = Math.round(amountPaise) / 100;
    return {
      currency: "INR",
      value: price,
      items: [{ item_id: tier, item_name: label, item_category: "Summit pass", price, quantity: 1 }],
    };
  }

  return { track, item, showBanner };
})();
