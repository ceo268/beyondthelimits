"use strict";

const { event: summit, seo, ui, nav, hero, stats, about, expect, values, lineup, speakers, passes, contact, footer } = CONTENT;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const safe = (value) => String(value).replace(/[&<>"']/g, (symbol) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[symbol]);
const start = new Date(summit.startsAt);
const formatDate = (month) => new Intl.DateTimeFormat(summit.locale, {
  day: "numeric", month, year: "numeric", timeZone: summit.timeZone,
}).format(start);
const dateText = (month) => `<time datetime="${safe(summit.startsAt)}">${safe(formatDate(month))}</time>`;
const price = new Intl.NumberFormat(summit.locale, {
  style: "currency", currency: summit.currency, maximumFractionDigits: 0,
});
const motion = matchMedia("(prefers-reduced-motion: reduce)");

const icons = {
  sparkle: '<path d="M12 0 14 7.2 20.5 3.5 16.8 10 24 12 16.8 14 20.5 20.5 14 16.8 12 24 10 16.8 3.5 20.5 7.2 14 0 12 7.2 10 3.5 3.5 10 7.2Z"/>',
  arrow: '<path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  diagonal: '<path d="M6 18 18 6M9 6h9v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  menu: '<path d="M4 8h16M4 16h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  close: '<path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  pause: '<path d="M9 6v12m6-12v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17.5" cy="6.7" r="1"/>',
  linkedin: '<path d="M6 8a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 6 8ZM4.7 10h2.6v9H4.7zm4.9 0h2.5v1.2c.5-.9 1.5-1.4 2.7-1.4 2.7 0 3.4 1.8 3.4 4.1V19h-2.6v-4.6c0-1.1-.2-2.1-1.5-2.1-1.4 0-1.9.9-1.9 2V19H9.6z"/>',
  youtube: '<path d="M21 9a3 3 0 0 0-2.5-2.6 48 48 0 0 0-13 0A3 3 0 0 0 3 9a26 26 0 0 0 0 6 3 3 0 0 0 2.5 2.6 48 48 0 0 0 13 0A3 3 0 0 0 21 15a26 26 0 0 0 0-6ZM10 15.3V8.7l5.5 3.3Z"/>',
};
const icon = (name, style = "") => `<svg class="icon ${style}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${icons[name] || ""}</svg>`;
const heading = (id, text, highlight) => `<h2 id="${id}" tabindex="-1">${safe(text)}${highlight ? ` <mark>${safe(highlight)}</mark>` : ""}</h2>`;
const button = (label, href, style = "secondary", arrow = "") => `<a class="button button-${style}" href="${safe(href)}">${safe(label)}${arrow ? icon(arrow) : ""}</a>`;
const logo = () => `<a class="brand-logo" href="#home" aria-label="${safe(ui.homeLink)}"><img src="${safe(summit.logo)}" alt="${safe(summit.logoAlt)}" width="1280" height="427"></a>`;
const navLink = ({ label, target }) => `<a href="${safe(target)}">${safe(label)}</a>`;

function webUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function optionalImage(photo, alt = "") {
  return photo ? `<img class="slot-image" data-photo="${safe(photo)}" alt="${safe(alt)}" loading="lazy" decoding="async" hidden>` : "";
}

function loadImage(img) {
  if (!img?.dataset.photo) return;
  img.addEventListener("load", () => { img.hidden = false; }, { once: true });
  img.loading = "eager"; // The observer handles the lazy-load trigger for these hidden slots.
  img.src = img.dataset.photo;
  delete img.dataset.photo;
}

function renderNavigation() {
  $("#desktop-nav").setAttribute("aria-label", ui.navigation);
  $("#desktop-nav").innerHTML = `
    <div class="nav-group nav-left">${nav.slice(0, 3).map(navLink).join("")}</div>
    ${logo()}
    <div class="nav-group nav-right">${nav.slice(3).map(navLink).join("")}</div>
    <button class="icon-button menu-toggle" aria-controls="mobile-menu" aria-expanded="false" aria-haspopup="dialog" aria-label="${safe(ui.openMenu)}" type="button">${icon("menu")}</button>`;
  $("#mobile-menu").setAttribute("aria-label", ui.navigation);
  $(".mobile-menu-inner").innerHTML = `
    <div class="mobile-menu-bar">${logo()}<button class="icon-button menu-close" type="button" aria-label="${safe(ui.closeMenu)}" autofocus>${icon("close")}</button></div>
    <nav aria-label="${safe(ui.navigation)}">${nav.map(navLink).join("")}</nav>`;
}

function renderHero() {
  $("#home").innerHTML = `
    ${icon("sparkle", "hero-sparkle")}
    <div class="hero-heading">
      <p class="eyebrow">${safe(summit.label)}</p>
      <h1 id="hero-title" tabindex="-1">${safe(hero.heading)} <span class="hero-highlight">${safe(hero.highlight)}</span></h1>
      <p class="hero-subline">${safe(hero.subline)}</p>
    </div>
    <div class="hero-stage">
      <div class="hero-center">
        <div class="arch">
          <div class="arch-fallback" aria-hidden="true"></div>
          ${hero.photo ? `<img class="hero-art" src="${safe(hero.photo)}" fetchpriority="high" decoding="async" width="780" height="975" alt="${safe(hero.photoAlt)}">` : ""}
        </div>
        <div class="hero-actions">
          ${button(hero.passButton, "#passes", "primary", "diagonal")}
          ${button(hero.speakersButton, "#speakers", "secondary")}
        </div>
      </div>
      <div class="hero-date">
        <div class="date-badge">${icon("sparkle")}${dateText("short")}</div>
        <p class="venue">${safe(summit.venue)}</p>
        <div class="countdown" role="timer" aria-label="${safe(hero.countdownLabel)}">
          ${hero.countdownUnits.map((unit) => `<div><strong>00</strong><span>${safe(unit)}</span></div>`).join("")}
        </div>
        <p class="countdown-complete" hidden>${safe(hero.countdownComplete)}</p>
      </div>
      <div class="hero-intro">
        <span class="intro-rule" aria-hidden="true"></span>
        <p>${safe(hero.intro)}</p>
        ${button(hero.aboutButton, "#about", "secondary", "diagonal")}
      </div>
    </div>`;
  const art = $(".hero-art");
  if (art) {
    art.addEventListener("error", () => { art.hidden = true; }, { once: true });
    if (art.complete && !art.naturalWidth) art.hidden = true;
  }
}

function renderAboutAndExpect() {
  $("#stats").setAttribute("aria-label", ui.statsLabel);
  $("#stats").innerHTML = `
    <dl class="stat-bar">
      ${stats.items.map(({ value, suffix = "", label }) => `<div><dt>${safe(label)}</dt><dd><span>${safe(value)}</span>${safe(suffix)}</dd></div>`).join("")}
    </dl><p class="stat-line">${safe(stats.line)}</p>`;
  $("#about").innerHTML = `
    ${heading("about-title", about.heading)}
    <div class="about-copy">${about.paragraphs.map((paragraph) => `<p>${safe(paragraph)}</p>`).join("")}</div>
    <div class="about-visual about-visual-left">
      <div class="art-frame art-strata"></div>
      ${icon("sparkle", "about-sparkle")}
    </div>
    <div class="about-visual about-visual-right art-frame art-rings"></div>`;
  $("#expect").innerHTML = `
    ${heading("expect-title", expect.heading, expect.highlight)}
    <div class="expect-grid">
      <div class="expect-tabs" role="tablist" aria-labelledby="expect-title" aria-orientation="vertical">
        ${expect.items.map(({ title }, i) => `<button class="expect-tab" id="expect-tab-${i}" type="button" role="tab" aria-selected="${i === 0}" aria-controls="expect-panel-${i}" tabindex="${i === 0 ? 0 : -1}"><span>${String(i + 1).padStart(2, "0")}</span>${safe(title)}${icon("arrow")}</button>`).join("")}
      </div>
      <div class="expect-features">
        ${expect.items.map(({ description }, i) => `
          <div class="expect-feature" id="expect-panel-${i}" role="tabpanel" aria-labelledby="expect-tab-${i}" tabindex="0"${i ? " hidden" : ""}>
            <figure>
              <div class="art-frame expect-art expect-art-${i % 4}" aria-hidden="true"></div>
              <figcaption>${safe(description)}</figcaption>
            </figure>
          </div>`).join("")}
      </div>
      <div class="expect-actions">
        ${icon("sparkle", "expect-sparkle")}
        <a class="action-card action-dark" href="#speakers">${safe(hero.speakersButton)}<span>${icon("diagonal")}</span></a>
        <a class="action-card action-gold" href="#passes">${safe(hero.passButton)}<span>${icon("diagonal")}</span></a>
      </div>
    </div>`;
}

function renderValuesAndSpeakers() {
  const wordGroup = values.map((value) => `<span>${safe(value)}</span>${icon("sparkle")}`).join("");
  $("#values").setAttribute("aria-label", ui.valuesLabel);
  $("#values").innerHTML = `
    <span class="sr-only">${safe(values.join(", "))}</span>
    <div class="marquee-window" aria-hidden="true">
      <div class="marquee-track">
        <div class="marquee-group">${wordGroup}${wordGroup}</div>
        <div class="marquee-group">${wordGroup}${wordGroup}</div>
      </div>
      <div class="values-static">${wordGroup}</div>
    </div>
    <button type="button" class="icon-button pause-values" aria-label="${safe(ui.pauseValues)}">${icon("pause")}</button>`;
  $("#speakers").innerHTML = `
    ${heading("speakers-title", lineup.heading, lineup.highlight)}
    <ul class="speaker-grid">
      ${speakers.map(({ name, role, slug, photo }) => {
        const initials = name.split(/[.\s]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("");
        return `<li class="speaker-card" id="speaker-${safe(slug)}">
          <div class="speaker-portrait" aria-hidden="true"><span>${safe(initials)}</span>${optionalImage(photo)}</div>
          <div class="speaker-copy"><h3>${safe(name)}</h3>${role ? `<p>${safe(role)}</p>` : ""}</div>
        </li>`;
      }).join("")}
    </ul>`;
}

function renderPasses() {
  $("#passes").innerHTML = `
    ${heading("passes-title", passes.heading, passes.highlight)}
    <div class="ticket-grid">
      ${passes.tiers.map(({ variant, title, number, price: amount, inclusions }) => `
        <div class="ticket-slot">
          <article class="ticket ticket-${safe(variant)}">
            <div class="ticket-main">
              <div class="ticket-labels"><span>${safe(summit.brand)}</span><span>${safe(number)}</span><span>${safe(passes.admit)}</span></div>
              <h3>${safe(title)}</h3>
              <div class="ticket-price"><strong>${safe(price.format(amount))}</strong><span>${safe(passes.tax)}</span></div>
              ${inclusions.length ? `<div class="ticket-inclusions"><ul>${inclusions.map((item) => `<li>${safe(item)}</li>`).join("")}</ul></div>` : ""}
            </div>
            <div class="ticket-stub">
              <div class="ticket-date">${dateText("long")}<span>${safe(summit.venue)}</span></div>
              ${passes.salesOpen && window.SummitApi?.configured
                ? `<button class="ticket-button" type="button" data-pass="${safe(variant)}" aria-label="${safe(`${passes.ticketButton}: ${title}`)}">${safe(passes.ticketButton)}</button>`
                : `<span class="ticket-status">${safe(passes.comingSoon)}</span>`}
            </div>
          </article>
        </div>`).join("")}
    </div>`;
}

function renderContact() {
  const emailLink = `mailto:${contact.email}`;
  $("#contact").innerHTML = `
    <div class="cta-copy">
      ${heading("contact-title", contact.heading)}
      <p>${safe(contact.description)}</p>
      ${button(contact.button, emailLink, "primary", "diagonal")}
    </div>
    <div class="cta-art" aria-hidden="true">${icon("sparkle", "cta-sparkle")}<div class="art-frame cta-frame"></div></div>`;
  const socials = footer.socials.flatMap(({ icon: glyph, label, url }) => {
    const href = webUrl(url);
    return href ? [`<a href="${safe(href)}" aria-label="${safe(label)}">${icon(glyph)}</a>`] : [];
  });
  $("#footer").innerHTML = `
    <div class="footer-main">
      <div class="footer-brand">
        <a class="footer-wordmark" href="#home" aria-label="${safe(ui.homeLink)}">${footer.wordmark.map((line) => `<span>${safe(line)}</span>`).join("")}</a>
        <p>${safe(footer.description)}</p>
      </div>
      <div><h2>${safe(footer.eventHeading)}</h2>${nav.slice(1, 4).map(navLink).join("")}</div>
      <div><h2>${safe(footer.connectHeading)}</h2>
        <a href="#contact">${safe(footer.updates)}</a>
        <a href="${safe(emailLink)}">${safe(contact.email)}</a>
        ${footer.phone ? `<a href="tel:${safe(footer.phone.replace(/[^+\d]/g, ""))}">${safe(footer.phone)}</a>` : ""}
        ${socials.length ? `<div class="socials">${socials.join("")}</div>` : ""}
      </div>
      <div><h2>${safe(footer.locationHeading)}</h2><p>${safe(summit.venue)}</p>${dateText("long")}</div>
    </div>
    <div class="footer-bottom">${safe(footer.copyright)}</div>`;
}

function bindStaticContent() {
  $$("[data-text]").forEach((node) => {
    node.textContent = node.dataset.text.split(".").reduce((value, key) => value[key], CONTENT);
  });
  document.title = seo.title;
  $('meta[name="description"]').content = seo.description;
  $('meta[property="og:site_name"]').content = summit.name;
  $('meta[property="og:title"]').content = seo.title;
  $('meta[property="og:description"]').content = seo.description;
  $('meta[property="og:image:alt"]').content = summit.logoAlt;
  const siteUrl = webUrl(seo.siteUrl);
  if (siteUrl) {
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = siteUrl;
    document.head.append(canonical);
  }
  $('meta[property="og:image"]').content = new URL(seo.image, siteUrl || location.href).href;
}

function bindNavigation() {
  const dialog = $("#mobile-menu");
  const toggle = $(".menu-toggle");
  const closeMenu = () => {
    if (!dialog.open) return;
    dialog.close();
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    dialog.showModal();
    toggle.setAttribute("aria-expanded", "true");
  });
  $(".menu-close").addEventListener("click", closeMenu);
  dialog.addEventListener("close", () => toggle.setAttribute("aria-expanded", "false"));
  matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
    if (event.matches) closeMenu();
  });
  dialog.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const section = $(link.hash);
    if (!section) return;
    event.preventDefault();
    closeMenu();
    if (location.hash !== link.hash) history.pushState(null, "", link.hash);
    section.querySelector("h1, h2")?.focus({ preventScroll: true });
    section.scrollIntoView();
  });
  const updateHeader = () => $(".site-header").classList.toggle("is-compact", scrollY > 48);
  addEventListener("scroll", updateHeader, { passive: true });
  updateHeader();
}

function bindCountdown() {
  const timer = $(".countdown");
  const numbers = $$("strong", timer);
  let interval;
  function tick() {
    const remaining = Math.max(0, Math.floor((start.getTime() - Date.now()) / 1000));
    if (remaining === 0) {
      timer.hidden = true;
      $(".countdown-complete").hidden = false;
      clearInterval(interval);
      return;
    }
    const units = [Math.floor(remaining / 86400), Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60];
    units.forEach((value, i) => {
      const text = String(value).padStart(2, "0");
      if (numbers[i].textContent !== text) numbers[i].textContent = text;
    });
  }
  interval = setInterval(tick, 250);
  tick();
}

function bindTabs() {
  const tabs = $$(".expect-tab");
  const panels = $$(".expect-feature");
  function select(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(index === i));
      tab.tabIndex = index === i ? 0 : -1;
      panels[i].hidden = index !== i;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i));
    tab.addEventListener("keydown", (event) => {
      const keys = {
        ArrowDown: (i + 1) % tabs.length,
        ArrowUp: (i + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault();
      select(keys[event.key], true);
    });
  });
}

function bindMotionAndImages() {
  const pause = $(".pause-values");
  let paused = false;
  pause.addEventListener("click", () => {
    paused = !paused;
    $("#values").classList.toggle("paused", paused);
    pause.setAttribute("aria-label", paused ? ui.playValues : ui.pauseValues);
    pause.innerHTML = icon(paused ? "play" : "pause");
  });

  const photos = $$("img[data-photo]").filter((img) => !img.closest("[hidden]:not(img)"));
  if (!("IntersectionObserver" in window)) {
    photos.forEach(loadImage);
    return;
  }
  const imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ isIntersecting, target }) => {
      if (!isIntersecting) return;
      imageObserver.unobserve(target);
      loadImage($("img[data-photo]", target));
    });
  }, { rootMargin: "100px" });
  photos.forEach((img) => imageObserver.observe(img.parentElement));

  if (motion.matches) return;
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ isIntersecting, target }) => {
      if (!isIntersecting) return;
      revealObserver.unobserve(target);
      target.classList.remove("will-reveal");
    });
  }, { threshold: 0.06 });
  const belowFold = $$(".about, .expect, .speaker-grid > li, .ticket-grid > div, .cta")
    .filter((section) => section.getBoundingClientRect().top >= innerHeight + 36);
  belowFold.forEach((section) => {
    section.classList.add("will-reveal");
    revealObserver.observe(section);
  });

  const statObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    statObserver.disconnect();
    const numbers = $$(".stat-bar dd span");
    const started = performance.now();
    function animate(now) {
      const progress = Math.min((now - started) / 720, 1);
      stats.items.forEach(({ value }, i) => {
        if (typeof value === "number") {
          numbers[i].textContent = Math.round(value * (1 - (1 - progress) ** 3));
        }
      });
      if (progress < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }, { threshold: 0.3 });
  statObserver.observe($(".stat-bar"));
}

renderNavigation();
renderHero();
renderAboutAndExpect();
renderValuesAndSpeakers();
renderPasses();
renderContact();
bindStaticContent();
bindNavigation();
bindCountdown();
bindTabs();
bindMotionAndImages();
