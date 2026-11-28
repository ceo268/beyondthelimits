"use strict";

// Coupon popup: shows CONTENT.promo.code with a countdown (CONTENT.promo.minutes), once per visitor.
// The countdown starts when the popup first appears and is remembered across reloads. Closing it leaves
// a small "₹500 off · 4:12" chip that reopens it until time runs out. "Claim" scrolls to the passes and
// the checkout fills in the code automatically. The discount itself is set and checked on the server
// (Admin → Coupons), so this file only advertises the code.
window.SummitPromo = (() => {
  const copy = (typeof CONTENT !== "undefined" && CONTENT.promo) || {};
  if (!copy.enabled || !copy.code) return { claimedCode: () => null };

  const storageKey = "btl-promo-" + copy.code;
  const durationMs = Math.max(1, Number(copy.minutes) || 5) * 60000;
  const analytics = window.SummitAnalytics || { track() {} };

  function read() {
    try { return JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Shown again next visit. */ }
  }
  const state = read(); // { start, claimed }
  const remaining = () => (state.start ? state.start + durationMs - Date.now() : durationMs);
  const active = () => remaining() > 0;
  const claimedCode = () => (state.claimed && active() ? copy.code : null);

  const pad = (n) => String(n).padStart(2, "0");
  const clock = () => {
    const seconds = Math.max(0, Math.ceil(remaining() / 1000));
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  };

  let dialog = null;
  let chip = null;
  let timer = 0;

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "promo-dialog";
    dialog.setAttribute("aria-labelledby", "promo-title");
    dialog.innerHTML = `
      <button type="button" class="promo-close" aria-label="">×</button>
      <p class="promo-kicker"></p>
      <h2 id="promo-title"></h2>
      <p class="promo-text"></p>
      <div class="promo-code"><strong></strong><button type="button" class="button button-secondary promo-copy"></button></div>
      <p class="promo-timer"><span></span><strong aria-live="off"></strong></p>
      <button type="button" class="button button-primary promo-cta"></button>`;
    dialog.querySelector(".promo-close").setAttribute("aria-label", copy.close);
    dialog.querySelector(".promo-kicker").textContent = copy.kicker;
    dialog.querySelector("#promo-title").textContent = copy.title;
    dialog.querySelector(".promo-text").textContent = copy.text;
    dialog.querySelector(".promo-code strong").textContent = copy.code;
    dialog.querySelector(".promo-copy").textContent = copy.copy;
    dialog.querySelector(".promo-timer span").textContent = copy.timerLabel;
    dialog.querySelector(".promo-cta").textContent = copy.cta;
    document.body.append(dialog);

    dialog.querySelector(".promo-close").addEventListener("click", dismiss);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(); });
    dialog.querySelector(".promo-copy").addEventListener("click", copyCode);
    dialog.querySelector(".promo-cta").addEventListener("click", claim);
  }

  async function copyCode() {
    const button = dialog.querySelector(".promo-copy");
    try {
      await navigator.clipboard.writeText(copy.code);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(dialog.querySelector(".promo-code strong"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    button.textContent = copy.copied;
    setTimeout(() => { if (dialog) button.textContent = copy.copy; }, 1800);
    analytics.track("promo_copy", { coupon: copy.code });
  }

  function claim() {
    state.claimed = true;
    save();
    analytics.track("promo_claim", { coupon: copy.code });
    close();
    showChip();
    document.getElementById("passes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function dismiss() {
    analytics.track("promo_dismiss", { coupon: copy.code });
    close();
    showChip();
  }

  function close() {
    if (!dialog?.open) return;
    dialog.classList.remove("is-shown");
    setTimeout(() => dialog?.close(), 250);
  }

  function open() {
    if (!active() || document.querySelector("dialog[open]")) return;
    if (!dialog) build();
    if (!state.start) {
      state.start = Date.now();
      save();
      analytics.track("promo_view", { coupon: copy.code });
    }
    chip?.remove();
    chip = null;
    tick();
    dialog.showModal();
    requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add("is-shown")));
  }

  function showChip() {
    if (chip || !active()) return;
    chip = document.createElement("button");
    chip.type = "button";
    chip.className = "promo-chip";
    chip.addEventListener("click", open);
    document.body.append(chip);
    tick();
  }

  function tick() {
    if (!active()) {
      clearInterval(timer);
      timer = 0;
      close();
      chip?.remove();
      chip = null;
      return;
    }
    const time = clock();
    if (dialog) dialog.querySelector(".promo-timer strong").textContent = time;
    if (chip) {
      chip.textContent = `${copy.chip} · ${copy.code} · ${time}`;
      chip.setAttribute("aria-label", `${copy.title}: ${copy.code}. ${copy.timerLabel} ${time}`);
    }
    if (!timer) timer = setInterval(tick, 1000);
  }

  // First visit: wait a few seconds, and until the cookie banner and any other dialog are gone.
  // Returning within the countdown: just show the chip.
  function waitAndOpen() {
    if (!active()) return;
    if (document.querySelector(".cookie-banner") || document.querySelector("dialog[open]")) {
      setTimeout(waitAndOpen, 1500);
      return;
    }
    open();
  }

  addEventListener("DOMContentLoaded", () => {
    if (!active()) return;
    if (state.start) showChip();
    else setTimeout(waitAndOpen, Math.max(0, Number(copy.delaySeconds) || 0) * 1000);
  });

  return { claimedCode, open };
})();
