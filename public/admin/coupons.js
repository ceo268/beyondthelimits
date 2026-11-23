"use strict";

// Coupon management. Uses globals from admin.js: api, $, el, accessToken, showLogin, formattedDate.
// The database validates and stores everything; this file only collects input and shows results.
(() => {
  const formEl = $("#coupon-form");
  const heading = $("#coupon-form-heading");
  const formStatus = $("#coupon-form-status");
  const listStatus = $("#coupons-status");
  const rows = $("#coupon-rows");
  const scroll = $("#coupon-scroll");
  const saveButton = $("#coupon-save");
  const valueLabel = $("#coupon-value-label");
  const preview = $("#coupon-preview");
  const fields = formEl.elements;
  // List prices for the preview only. Checkout always uses the server's price.
  const passes = CONTENT.passes.tiers.map(({ title, price }) => ({ title, paise: price * 100 }));
  let coupons = [];
  let editing = null;
  let loading = 0;

  const accessEnded = (error) => error.status === 401 || error.status === 403 || error.code === "42501";
  const friendly = (error, fallback) => (error.status && error.status < 500 && error.message) || fallback;

  async function call(name, body = {}) {
    return api.admin(name, body, await accessToken());
  }

  function describe(coupon) {
    return coupon.discount_type === "percent" ? `${coupon.discount_value}% off` : `${api.money(coupon.discount_value)} off`;
  }

  function couponState(coupon) {
    if (!coupon.enabled) return ["Disabled", "failed"];
    if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) return ["Expired", "refunded"];
    if (coupon.usage_limit && coupon.held >= coupon.usage_limit) return ["Used up", "refunded"];
    return ["Active", "paid"];
  }

  // <input type="datetime-local"> works in the browser's local time.
  function toLocalInput(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function updatePreview() {
    const percent = fields.discount_type.value === "percent";
    valueLabel.textContent = percent ? "Percentage off" : "Amount off (₹)";
    fields.discount_value.max = percent ? "100" : "";
    fields.discount_value.placeholder = percent ? "20" : "500";
    const value = Number(fields.discount_value.value);
    if (!value || value < 1) {
      preview.textContent = "";
      return;
    }
    // Mirrors the server's rule for display: percentages round down to whole rupees, ₹1 minimum payable.
    preview.textContent = "Checkout preview: " + passes.map(({ title, paise }) => {
      const off = percent ? Math.floor(paise * Math.min(value, 100) / 10000) * 100 : Math.round(value * 100);
      const pay = Math.max(paise - off, 100);
      return `${title} ${api.money(paise)} → ${api.money(pay)}`;
    }).join(" · ");
  }

  function openForm(coupon = null) {
    editing = coupon;
    formEl.reset();
    heading.textContent = coupon ? `Edit ${coupon.code}` : "New coupon";
    saveButton.textContent = coupon ? "Save changes" : "Create coupon";
    if (coupon) {
      fields.code.value = coupon.code;
      fields.discount_type.value = coupon.discount_type;
      fields.discount_value.value = coupon.discount_type === "percent" ? coupon.discount_value : coupon.discount_value / 100;
      fields.expires_at.value = toLocalInput(coupon.expires_at);
      fields.usage_limit.value = coupon.usage_limit ?? "";
      fields.enabled.checked = coupon.enabled;
    }
    formStatus.textContent = "";
    formStatus.dataset.tone = "";
    formEl.hidden = false;
    updatePreview();
    fields.code.focus();
    formEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeForm() {
    editing = null;
    formEl.reset();
    formEl.hidden = true;
  }

  function formError(message) {
    formStatus.textContent = message;
    formStatus.dataset.tone = "error";
  }

  function readForm() {
    const code = fields.code.value.trim().toUpperCase();
    const percent = fields.discount_type.value === "percent";
    const value = Number(fields.discount_value.value);
    const limit = fields.usage_limit.value.trim();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code)) return formError("Use 3–30 letters, numbers, - or _ for the code (no spaces).");
    if (!Number.isFinite(value) || value <= 0) return formError("Enter the discount value.");
    if (percent && (!Number.isInteger(value) || value > 100)) return formError("Enter a whole percentage from 1 to 100.");
    if (!percent && Math.round(value * 100) !== value * 100) return formError("Enter the amount in rupees (up to 2 decimals).");
    if (limit && (!/^\d+$/.test(limit) || Number(limit) < 1)) return formError("The usage limit must be a whole number of 1 or more.");
    const expires = fields.expires_at.value ? new Date(fields.expires_at.value) : null;
    if (expires && Number.isNaN(expires.getTime())) return formError("Enter a valid expiry date and time.");
    return {
      p_id: editing?.id ?? null,
      p_code: code,
      p_discount_type: percent ? "percent" : "fixed",
      p_discount_value: percent ? value : Math.round(value * 100),
      p_expires_at: expires ? expires.toISOString() : null,
      p_usage_limit: limit ? Number(limit) : null,
      p_enabled: fields.enabled.checked,
    };
  }

  function renderList() {
    rows.replaceChildren(...coupons.map((coupon) => {
      const line = el("tr");
      const [stateText, stateClass] = couponState(coupon);
      const code = el("td");
      code.append(el("strong", coupon.code, "coupon-code"));
      const used = el("td");
      used.append(el("span", coupon.usage_limit ? `${coupon.used} / ${coupon.usage_limit}` : String(coupon.used)));
      if (coupon.discount_given_paise > 0) used.append(el("span", `${api.money(coupon.discount_given_paise)} given`, "customer-secondary"));
      const status = el("td");
      status.append(el("span", stateText, "status-tag " + stateClass));
      const actions = el("td", undefined, "coupon-actions");
      const button = (label, handler, aria) => {
        const node = el("button", label, "button button-secondary");
        node.type = "button";
        node.setAttribute("aria-label", `${aria} ${coupon.code}`);
        node.addEventListener("click", handler);
        return node;
      };
      actions.append(
        button("Edit", () => openForm(coupon), "Edit"),
        button(coupon.enabled ? "Disable" : "Enable", () => toggle(coupon), coupon.enabled ? "Disable" : "Enable"),
        button("Delete", () => remove(coupon), "Delete"),
      );
      line.append(code, el("td", describe(coupon)), used,
        el("td", coupon.expires_at ? formattedDate(coupon.expires_at, true) : "Never"), status, actions);
      return line;
    }));
    scroll.hidden = coupons.length === 0;
    listStatus.textContent = coupons.length ? "" : "No coupons yet. Select New coupon to create one.";
  }

  async function load() {
    const call_ = ++loading;
    listStatus.textContent = "Loading coupons…";
    try {
      const result = await call("summit_admin_coupons");
      if (call_ !== loading) return;
      coupons = result;
      renderList();
    } catch (error) {
      if (call_ !== loading) return;
      if (accessEnded(error)) return showLogin("Organizer access has ended. Sign in to continue.");
      scroll.hidden = true;
      listStatus.textContent = "Coupons could not be loaded. Select Refresh to try again.";
    }
  }

  async function save(payload) {
    saveButton.disabled = true;
    formStatus.textContent = "Saving…";
    formStatus.dataset.tone = "";
    try {
      const saved = await call("summit_admin_save_coupon", payload);
      closeForm();
      listStatus.textContent = `${saved.code} saved. It applies to new checkouts now.`;
      await load();
      listStatus.textContent = `${saved.code} saved. It applies to new checkouts now.`;
    } catch (error) {
      if (accessEnded(error)) return showLogin("Organizer access has ended. Sign in to continue.");
      formError(friendly(error, "The coupon could not be saved. Please try again."));
    } finally {
      saveButton.disabled = false;
    }
  }

  async function toggle(coupon) {
    try {
      await call("summit_admin_save_coupon", {
        p_id: coupon.id, p_code: coupon.code, p_discount_type: coupon.discount_type,
        p_discount_value: coupon.discount_value, p_expires_at: coupon.expires_at,
        p_usage_limit: coupon.usage_limit, p_enabled: !coupon.enabled,
      });
      await load();
      listStatus.textContent = `${coupon.code} ${coupon.enabled ? "disabled" : "enabled"}.`;
    } catch (error) {
      if (accessEnded(error)) return showLogin("Organizer access has ended. Sign in to continue.");
      listStatus.textContent = friendly(error, "The coupon could not be updated. Please try again.");
    }
  }

  async function remove(coupon) {
    const note = coupon.used ? ` It has been used ${coupon.used} time(s); those orders keep their discount.` : "";
    if (!confirm(`Delete coupon ${coupon.code}?${note} This cannot be undone.`)) return;
    try {
      await call("summit_admin_delete_coupon", { p_id: coupon.id });
      if (editing?.id === coupon.id) closeForm();
      await load();
      listStatus.textContent = `${coupon.code} deleted.`;
    } catch (error) {
      if (accessEnded(error)) return showLogin("Organizer access has ended. Sign in to continue.");
      listStatus.textContent = friendly(error, "The coupon could not be deleted. Please try again.");
    }
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = readForm();
    if (payload) void save(payload);
  });
  formEl.addEventListener("input", updatePreview);
  fields.code.addEventListener("blur", () => { fields.code.value = fields.code.value.trim().toUpperCase(); });
  $("#coupon-new").addEventListener("click", () => openForm());
  $("#coupon-cancel").addEventListener("click", closeForm);
  $("#refresh-coupons").addEventListener("click", load);
  document.addEventListener("summit:signedin", load);
  document.addEventListener("summit:reset", () => {
    loading += 1;
    coupons = [];
    closeForm();
    rows.replaceChildren();
    scroll.hidden = true;
    listStatus.textContent = "";
  });
})();
