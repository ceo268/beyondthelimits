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

  dialog.innerHTML = `
    <div class="checkout-top">
      <div><p class="checkout-kicker">${safe(copy.label)}</p><h2 id="checkout-title" tabindex="-1">${safe(copy.title)}</h2></div>
      <button type="button" class="icon-button checkout-close" aria-label="${safe(copy.close)}">${icon("close")}</button>
    </div>
    <div class="checkout-summary">
      <div class="checkout-price-row"><strong id="checkout-pass"></strong><strong id="checkout-total"></strong></div>
      <div class="checkout-price-row"><span>${safe(copy.total)}</span><span id="checkout-tax"></span></div>
    </div>
    <p class="checkout-mode" hidden>${safe(copy.test)}</p>
    <form class="checkout-form">
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
    showForm();
  });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    refresh.disabled = value;
    close.disabled = value;
    done.disabled = value;
    another.disabled = value;
  }

  function displayMessage(message) { status.textContent = message; }

  function showDetails(tier, mode) {
    $(".checkout-summary", dialog).hidden = false;
    $("#checkout-pass").textContent = tier.label;
    $("#checkout-total").textContent = api.money(tier.amount_paise);
    $("#checkout-tax").textContent = tier.amount_paise > tier.base_paise ? copy.tax : "";
    $(".checkout-mode", dialog).hidden = mode !== "test";
    $("#checkout-contact-note").textContent = mode === "live" ? copy.ticketEmailNote : copy.contactNote;
  }

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
    if (busy || !attempt || attempt.verifying) return;
    const customer = Object.fromEntries(new FormData(form));
    const identity = JSON.stringify(customer);
    // Reuse the same reservation after errors or closing Razorpay. An edited registration starts a new reservation.
    if (attempt.identity && attempt.identity !== identity) resetAttempt();
    attempt.identity = identity;
    setBusy(true);
    displayMessage(copy.opening);
    try {
      const RazorpayCheckout = await loadRazorpay();
      const order = await api.checkout("create", {
        ...customer, tier: selection.tier, amount: selection.amount_paise, token: attempt.token,
      });
      attempt.outcome = order;
      if (terminal(order)) {
        saveAttempt();
        showResult(order, formatResult(order));
        return;
      }
      let paymentFailed = false;
      const payment = new RazorpayCheckout({
        key: order.keyId, amount: order.amount, currency: order.currency,
        name: CONTENT.event.name, description: selection.label, order_id: order.razorpayOrderId,
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
            if (!attempt.verifying) showForm(paymentFailed ? copy.failed : copy.closed);
          },
        },
      });
      payment.on("payment.failed", () => { paymentFailed = true; });
      dialog.close();
      setBusy(true);
      payment.open();
    } catch (error) {
      setBusy(false);
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
        showNotice(copy.soldOut);
        return;
      }
      selection = { ...tier, mode: catalog.mode };
      if (!remembered.has(tier.tier)) remembered.set(tier.tier, readAttempt(tier.tier, catalog.mode));
      attempt = remembered.get(tier.tier);
      showDetails(tier, catalog.mode);
      if (attempt.verifying || terminal(attempt.outcome)) {
        showResult(attempt.outcome, formatResult(attempt.outcome || {}));
      } else {
        showForm();
      }
    } catch {
      showNotice(copy.unavailable);
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  $$("[data-pass]").forEach((button) => button.addEventListener("click", () => openPass(button)));
})();
