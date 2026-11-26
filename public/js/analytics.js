"use strict";

// Google Analytics 4 for the public site (never loaded on /admin/).
// Page views, scrolls and outbound clicks come from GA4 enhanced measurement. This file adds the
// ticket funnel (called from checkout.js) and site interactions. No names, emails or phone numbers are sent.
// Add ?ga_debug=1 to any page URL to see its events live in GA4 > Admin > DebugView.
window.SummitAnalytics = (() => {
  const id = window.SUMMIT_CONFIG?.gaMeasurementId || "";
  const productionHost = /(^|\.)beyondthelimits\.co\.in$/.test(location.hostname);
  const enabled = /^G-[A-Z0-9]{4,}$/.test(id) && productionHost;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };

  function track(name, params = {}) {
    if (!enabled) return;
    try { window.gtag("event", name, params); } catch { /* Analytics must never break the page. */ }
  }

  if (!enabled) return { track, item: () => ({}) };

  const debug = new URLSearchParams(location.search).has("ga_debug");
  window.gtag("js", new Date());
  // GA4 treats any debug_mode value (even false) as debug traffic, so only set it when asked.
  window.gtag("config", id, debug ? { debug_mode: true } : {});
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
  document.head.append(tag);

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

  // Which sections people actually reach (sent once per section per page view).
  addEventListener("DOMContentLoaded", () => {
    if (!("IntersectionObserver" in window)) return;
    const seen = new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target }) => {
        if (!isIntersecting) return;
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

  return { track, item };
})();
