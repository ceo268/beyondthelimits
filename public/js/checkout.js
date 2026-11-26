"use strict";

(() => {
  const api = window.SummitApi;
  if (!api.configured) return;

  const copy = CONTENT.checkout;
  const dialog = $("#checkout-dialog");
  let selection;
  let attempt;
  let busy = false;
  let sdkPromise;
  // GA4 funnel: begin_checkout -> add_payment_info -> purchase (plus payment_failed / checkout_cancel / checkout_error).
  const analytics = window.SummitAnalytics || { track() {}, item: () => ({}) };
  // Uses the amount actually payable (after any coupon) and GA4's standard "coupon" field.
  const passEvent = (extra = {}) => {
    const applied = coupon && coupon.tier === selection.tier;
    return { ...analytics.item(selection.tier, selection.label, payable()), ...(applied ? { coupon: coupon.code } : {}), ...extra };
  };
  function trackPurchase(order) {
    if (order?.status !== "paid" || !order.reference || selection?.mode !== "live") return;
    const key = "summit-ga-purchase-" + order.reference;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      // Without storage the purchase may be sent again on a later status check; GA4 also dedupes transaction_id.
    }
    // The server's charged amount is the source of truth for revenue.
    const value = Number.isInteger(order.amount) ? { value: order.amount / 100 } : {};
    analytics.track("purchase", passEvent({ transaction_id: order.reference, ...value }));
  }

  dialog.innerHTML = `
    <div class="checkout-top">
      <div><p class="checkout-kicker">${safe(copy.label)}</p><h2 id="checkout-title" tabindex="-1">${safe(copy.title)}</h2></div>
      <button type="button" class="icon-button checkout-close" aria-label="${safe(copy.close)}">${icon("close")}</button>
    </div>
    <div class="checkout-summary">
      <div class="checkout-price-row"><strong id="checkout-pass"></strong><strong id="checkout-total"></strong></div>
      <dl class="checkout-breakdown" hidden>
        <div><dt>${safe(copy.ticketPrice)}</dt><dd id="checkout-price"></dd></div>
        <div><dt>${safe(copy.couponLabel)}</dt><dd id="checkout-coupon-code"></dd></div>
        <div class="checkout-discount"><dt>${safe(copy.discount)}</dt><dd id="checkout-discount"></dd></div>
      </dl>
      <div class="checkout-price-row"><span id="checkout-total-label">${safe(copy.total)}</span><span id="checkout-tax"></span></div>
    </div>
    <p class="checkout-mode" hidden>${safe(copy.test)}</p>
    <form class="checkout-form">
      <div class="checkout-coupon">
        <button type="button" class="checkout-coupon-toggle" aria-expanded="false" aria-controls="checkout-coupon-entry">${safe(copy.couponToggle)}</button>
        <div class="checkout-coupon-entry" id="checkout-coupon-entry" hidden>
          <label for="checkout-coupon-input" class="sr-only">${safe(copy.couponLabel)}</label>
          <input id="checkout-coupon-input" autocomplete="off" autocapitalize="characters" spellcheck="false"
            maxlength="30" placeholder="${safe(copy.couponPlaceholder)}" aria-describedby="checkout-coupon-message">
          <button type="button" class="button button-secondary checkout-coupon-apply">${safe(copy.couponApply)}</button>
        </div>
        <div class="checkout-coupon-applied" hidden>
          <span class="checkout-coupon-chip">${icon("check")}<strong id="checkout-coupon-chip-code"></strong> ${safe(copy.couponApplied)}</span>
          <span class="checkout-coupon-saving" id="checkout-coupon-saving"></span>
          <button type="button" class="checkout-coupon-remove">${safe(copy.couponRemove)}</button>
        </div>
        <p class="checkout-coupon-message" id="checkout-coupon-message" role="status" aria-live="polite"></p>
      </div>
      <label>${safe(copy.name)}<input name="name" autocomplete="name" minlength="2" maxlength="100" required></label>
      <label>${safe(copy.email)}<input name="email" autocomplete="email" type="email" maxlength="254" aria-describedby="checkout-contact-note" required></label>
      <label>${safe(copy.phone)}<input name="phone" type="tel" autocomplete="tel" placeholder="${safe(copy.phoneExample)}" maxlength="32" required></label>
      <small id="checkout-contact-note">${safe(copy.contactNote)}</small>
      <button class="button button-primary" type="submit">${safe(copy.review)}</button>
      <small>${safe(copy.secure)}</small>
    </form>
    <p class="checkout-status" role="status"></p>
    <p class="checkout-reference" hidden></p>
    <div class="checkout-result-actions" hidden>
      <button type="button" class="button button-secondary checkout-refresh">${safe(copy.refresh)}</button>
      <button type="button" class="button button-secondary checkout-another" hidden>${safe(copy.another)}</button>
      <button type="button" class="button button-primary checkout-done">${safe(copy.done)}</button>
    </div>`;

  const form = $(".checkout-form", dialog);
  const submit = $('button[type="submit"]', form);
  const status = $(".checkout-status", dialog);
  const reference = $(".checkout-reference", dialog);
  const resultActions = $(".checkout-result-actions", dialog);
  const refresh = $(".checkout-refresh", dialog);
  const close = $(".checkout-close", dialog);
  const done = $(".checkout-done", dialog);
  const another = $(".checkout-another", dialog);
  const couponToggle = $(".checkout-coupon-toggle", dialog);
  const couponEntry = $(".checkout-coupon-entry", dialog);
  const couponInput = $("#checkout-coupon-input", dialog);
  const couponApply = $(".checkout-coupon-apply", dialog);
  const couponApplied = $(".checkout-coupon-applied", dialog);
  const couponRemove = $(".checkout-coupon-remove", dialog);
  const couponMessage = $("#checkout-coupon-message", dialog);
  // The applied coupon as priced by the server for the selected pass: { code, tier, price, discount, amount }.
  // Discounts are never computed here; the server reprices the order again when it is created.
  let coupon = null;
  let couponChecking = false;
  const remembered = new Map();
  const terminal = (order) => ["paid", "refunded", "partially_refunded"].includes(order?.status);
  const storageKey = (tier) => "summit-payment-" + tier;

  function newAttempt() {
    return { token: crypto.randomUUID(), identity: null, outcome: null, verifying: false };
  }

  function readAttempt(tier, mode) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(tier)));
      if (saved?.mode === mode && saved.until > Date.now()) {
        return { token: saved.token, outcome: saved.outcome, verifying: !terminal(saved.outcome), identity: null };
      }
    } catch {
      // Checkout can continue when browsers block session storage.
    }
    return newAttempt();
  }

  function saveAttempt() {
    try {
      sessionStorage.setItem(storageKey(selection.tier), JSON.stringify({
        token: attempt.token, mode: selection.mode, outcome: attempt.outcome,
        until: Date.now() + 86400000,
      }));
    } catch {
      // The signed webhook still records captures if session storage is unavailable.
    }
  }

  function resetAttempt() {
    try { sessionStorage.removeItem(storageKey(selection.tier)); } catch { /* Optional storage. */ }
    attempt = newAttempt();
    remembered.set(selection.tier, attempt);
  }

  close.addEventListener("click", () => { if (!busy) dialog.close(); });
  done.addEventListener("click", () => dialog.close());
  another.addEventListener("click", () => {
    resetAttempt();
    form.reset();
    clearCoupon();
    showForm();
  });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });

  function setBusy(value) {
    busy = value;
    submit.disabled = value || couponChecking;
    refresh.disabled = value;
    close.disabled = value;
    done.disabled = value;
    another.disabled = value;
    setCouponControls();
  }

  function displayMessage(message) { status.textContent = message; }

  // The amount the buyer pays for the selected pass: the server-quoted coupon total, or the list price.
  function payable() {
    return coupon && coupon.tier === selection.tier ? coupon.amount : selection.amount_paise;
  }

  function renderSummary() {
    const applied = coupon && coupon.tier === selection.tier;
    $("#checkout-total").textContent = api.money(payable());
    $(".checkout-breakdown", dialog).hidden = !applied;
    $("#checkout-total-label").textContent = applied ? `${copy.totalPayable} (${copy.taxShort})` : copy.total;
    $("#checkout-tax").textContent = applied ? api.money(coupon.amount) : copy.tax;
    $("#checkout-tax").classList.toggle("checkout-payable", Boolean(applied));
    if (applied) {
      $("#checkout-price").textContent = api.money(coupon.price);
      $("#checkout-coupon-code").textContent = coupon.code;
      $("#checkout-discount").textContent = "−" + api.money(coupon.discount);
    }
    couponApplied.hidden = !applied;
    couponToggle.hidden = applied;
    if (applied) {
      couponEntry.hidden = true;
      $("#checkout-coupon-chip-code").textContent = coupon.code;
      $("#checkout-coupon-saving").textContent = `${copy.couponSaved} ${api.money(coupon.discount)}`;
    }
  }

  function showDetails(tier, mode) {
    $(".checkout-summary", dialog).hidden = false;
    $("#checkout-pass").textContent = tier.label;
    $(".checkout-mode", dialog).hidden = mode !== "test"; // All pass prices are inclusive of GST.
    $("#checkout-contact-note").textContent = mode === "live" ? copy.ticketEmailNote : copy.contactNote;
    renderSummary();
  }

  function setCouponControls() {
    const locked = busy || couponChecking;
    couponInput.disabled = locked;
    couponApply.disabled = locked;
    couponRemove.disabled = locked;
    couponApply.textContent = couponChecking ? copy.couponChecking : copy.couponApply;
    couponApply.toggleAttribute("aria-busy", couponChecking);
  }

  function couponNote(message, tone = "") {
    couponMessage.textContent = message;
    couponMessage.dataset.tone = tone;
  }

  function clearCoupon() {
    coupon = null;
    couponInput.value = "";
    couponNote("");
    couponToggle.setAttribute("aria-expanded", "false");
    couponEntry.hidden = true;
    if (selection) renderSummary();
  }

  // Ask the server to price `code` for the selected pass. Returns true when a coupon is applied.
  async function applyCoupon(code) {
    const typed = code.trim().toUpperCase();
    if (!typed) {
      couponNote(copy.couponPlaceholder, "error");
      couponInput.focus();
      return false;
    }
    const tier = selection.tier;
    couponChecking = true;
    setBusy(busy);
    couponNote("");
    try {
      const quote = await api.checkout("quote", { tier, coupon: typed });
      if (selection.tier !== tier) return false; // The buyer switched passes meanwhile.
      coupon = { code: quote.code, tier, price: quote.price, discount: quote.discount, amount: quote.amount };
      couponInput.value = quote.code;
      couponNote("");
      renderSummary();
      return true;
    } catch (error) {
      coupon = null;
      renderSummary();
      couponToggle.hidden = true;
      couponEntry.hidden = false;
      couponNote(error.status && error.status < 500 ? error.message : copy.couponUnavailable, "error");
      return false;
    } finally {
      couponChecking = false;
      setBusy(busy);
    }
  }

  couponToggle.addEventListener("click", () => {
    couponToggle.hidden = true;
    couponToggle.setAttribute("aria-expanded", "true");
    couponEntry.hidden = false;
    couponInput.focus();
  });
  couponApply.addEventListener("click", () => { if (!busy && !couponChecking) void applyCoupon(couponInput.value); });
  couponInput.addEventListener("keydown", (event) => {
    // Enter applies the coupon instead of submitting the payment form.
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!busy && !couponChecking) void applyCoupon(couponInput.value);
  });
  couponInput.addEventListener("input", () => { if (couponMessage.dataset.tone === "error") couponNote(""); });
  couponRemove.addEventListener("click", () => {
    if (busy || couponChecking) return;
    clearCoupon();
    couponToggle.focus();
  });

  function showForm(message = "") {
    form.hidden = false;
    resultActions.hidden = true;
    reference.hidden = true;
    if (!dialog.open) dialog.showModal();
    displayMessage(message);
  }

  function showResult(order, message) {
    form.hidden = true;
    resultActions.hidden = false;
    reference.hidden = !order?.reference;
    reference.textContent = order?.reference ? `${copy.reference} · ${order.reference}` : "";
    refresh.hidden = terminal(order);
    another.hidden = !terminal(order);
    if (!dialog.open) dialog.showModal();
    $("#checkout-title").focus();
    displayMessage(message);
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve(window.Razorpay);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      const timeout = setTimeout(fail, 10000);
      function fail() {
        clearTimeout(timeout);
        script.remove();
        sdkPromise = null;
        reject(new Error(copy.unavailable));
      }
      script.onload = () => {
        clearTimeout(timeout);
        if (window.Razorpay) resolve(window.Razorpay);
        else fail();
      };
      script.onerror = fail;
      document.head.append(script);
    });
    return sdkPromise;
  }

  function formatResult(order = {}) {
    if (order.status === "paid") return selection.mode === "live" ? copy.confirmedEmail : copy.confirmed;
    if (order.status === "refunded") return copy.refunded;
    if (order.status === "partially_refunded") return copy.partialRefund;
    if (order.status === "failed") return copy.failed;
    return copy.pending;
  }

  async function checkPayment(payload) {
    setBusy(true);
    attempt.verifying = true;
    displayMessage(copy.verifying);
    try {
      const result = payload
        ? await api.checkout("verify", { ...payload, token: attempt.token })
        : await api.checkout("status", { token: attempt.token });
      attempt.outcome = result;
      attempt.verifying = !terminal(result);
      if (result.status === "failed") {
        if (attempt.identity) attempt.verifying = false;
        else resetAttempt();
        showForm(copy.failed);
      } else {
        saveAttempt();
        trackPurchase(result);
        showResult(result, formatResult(result));
      }
    } catch {
      showResult(attempt.outcome, copy.pending);
    } finally {
      setBusy(false);
    }
  }

  refresh.addEventListener("click", () => checkPayment());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || couponChecking || !attempt || attempt.verifying) return;
    const customer = Object.fromEntries(new FormData(form));
    const couponCode = coupon && coupon.tier === selection.tier ? coupon.code : null;
    const amount = payable();
    // A different coupon or total is a different order, so it gets a fresh reservation.
    const identity = JSON.stringify({ ...customer, couponCode, amount });
    // Reuse the same reservation after errors or closing Razorpay. An edited registration starts a new reservation.
    if (attempt.identity && attempt.identity !== identity) resetAttempt();
    attempt.identity = identity;
    setBusy(true);
    displayMessage(copy.opening);
    try {
      const RazorpayCheckout = await loadRazorpay();
      const order = await api.checkout("create", {
        ...customer, tier: selection.tier, amount, coupon: couponCode, token: attempt.token,
      });
      attempt.outcome = order;
      if (terminal(order)) {
        saveAttempt();
        trackPurchase(order);
        showResult(order, formatResult(order));
        return;
      }
      let paymentFailed = false;
      const payment = new RazorpayCheckout({
        key: order.keyId, amount: order.amount, currency: order.currency,
        name: CONTENT.event.name, order_id: order.razorpayOrderId,
        description: couponCode ? `${selection.label} · ${couponCode}` : selection.label,
        prefill: { name: customer.name.trim(), email: customer.email.trim(), contact: customer.phone.trim() },
        theme: { color: getComputedStyle(document.documentElement).getPropertyValue("--gold").trim() },
        handler: (payload) => {
          attempt.verifying = true;
          saveAttempt();
          showResult(order, copy.verifying);
          void checkPayment(payload);
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            if (!attempt.verifying) {
              analytics.track("checkout_cancel", passEvent({ after_failed_payment: paymentFailed }));
              showForm(paymentFailed ? copy.failed : copy.closed);
            }
          },
        },
      });
      payment.on("payment.failed", () => {
        paymentFailed = true;
        analytics.track("payment_failed", passEvent());
      });
      dialog.close();
      setBusy(true);
      analytics.track("add_payment_info", passEvent({ payment_type: "razorpay" }));
      payment.open();
    } catch (error) {
      analytics.track("checkout_error", { reason: String(error.code || "unavailable").slice(0, 40), item_id: selection.tier });
      setBusy(false);
      if (couponCode && error.code === "price_changed") {
        // The organizer edited the coupon after it was applied: show the server's new price.
        resetAttempt();
        showForm(await applyCoupon(couponCode) ? copy.couponChanged : "");
        return;
      }
      if (couponCode && String(error.code).startsWith("coupon_")) {
        // Expired, disabled or used up since it was applied: drop it and say why.
        resetAttempt();
        coupon = null;
        renderSummary();
        couponToggle.hidden = true;
        couponEntry.hidden = false;
        couponNote(error.message, "error");
        showForm("");
        return;
      }
      showForm(error.status && error.status < 500 ? error.message : copy.unavailable);
    } finally {
      if (dialog.open && !attempt.verifying) setBusy(false);
    }
  });

  // Load/cost control: the catalog is fetched only when a visitor clicks a pass button,
  // never on page load, so ordinary page views make zero backend calls.
  let catalogPromise;
  let catalogAt = 0;
  function loadCatalog() {
    if (!catalogPromise || Date.now() - catalogAt > 120000) {
      catalogAt = Date.now();
      catalogPromise = api.checkout("catalog").catch((error) => {
        catalogPromise = null;
        throw error;
      });
    }
    return catalogPromise;
  }

  function showNotice(message) {
    $(".checkout-summary", dialog).hidden = true;
    $(".checkout-mode", dialog).hidden = true;
    form.hidden = true;
    resultActions.hidden = false;
    reference.hidden = true;
    refresh.hidden = true;
    another.hidden = true;
    if (!dialog.open) dialog.showModal();
    $("#checkout-title").focus();
    displayMessage(message);
  }

  async function openPass(button) {
    if (busy || button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    void loadRazorpay().catch(() => {}); // Warm the SDK while the catalog loads.
    try {
      const catalog = await loadCatalog();
      const tier = catalog.tiers.find((item) => item.tier === button.dataset.pass);
      if (!tier) {
        analytics.track("checkout_error", { reason: "pass_unavailable", item_id: button.dataset.pass });
        showNotice(copy.soldOut);
        return;
      }
      selection = { ...tier, mode: catalog.mode };
      if (!remembered.has(tier.tier)) remembered.set(tier.tier, readAttempt(tier.tier, catalog.mode));
      attempt = remembered.get(tier.tier);
      const carried = coupon && coupon.tier !== tier.tier ? coupon.code : null;
      showDetails(tier, catalog.mode);
      if (attempt.verifying || terminal(attempt.outcome)) {
        showResult(attempt.outcome, formatResult(attempt.outcome || {}));
      } else {
        analytics.track("begin_checkout", passEvent());
        showForm();
        // A coupon applied on another pass is repriced for this one by the server.
        if (carried) {
          couponNote(copy.couponUpdating);
          void applyCoupon(carried);
        }
      }
    } catch {
      analytics.track("checkout_error", { reason: "catalog_unavailable", item_id: button.dataset.pass });
      showNotice(copy.unavailable);
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  $$("[data-pass]").forEach((button) => button.addEventListener("click", () => openPass(button)));
})();
