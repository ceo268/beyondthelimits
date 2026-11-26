"use strict";

const api = window.SummitApi;
const $ = (selector) => document.querySelector(selector);
const nodeList = (selector) => Array.from(document.querySelectorAll(selector));
const login = $(".login");
const layout = $(".admin-layout");
const form = $("#signin-form");
const loginButton = form.querySelector("button");
const loginStatus = $("#signin-status");
const filters = $("#filters");
const workspace = $("#purchases");
const orderDialog = $("#order-dialog");
const ordersStatus = $("#orders-status");
// The panel shows live sales only. Test-mode data stays in the database but is not listed.
const mode = { value: "live" };
const statusNames = {
  paid: "Paid", pending: "Pending", failed: "Failed",
  refunded: "Refunded", partially_refunded: "Partially refunded",
};
const count = new Intl.NumberFormat("en-IN");
const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const pageSize = 20;
$("#admin-event-date").textContent = new Intl.DateTimeFormat(CONTENT.event.locale, {
  dateStyle: "long", timeZone: CONTENT.event.timeZone,
}).format(new Date(CONTENT.event.startsAt));
let session;
let refreshSession;
let sessionEpoch = 0;
let requestId = 0;
let page = 0;
let searchTimer;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function parseSession(data) {
  return {
    email: data.user.email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Number(data.expires_at || (Date.now() / 1000 + data.expires_in)) * 1000,
  };
}

async function accessToken() {
  if (!session) throw Object.assign(new Error("Session expired."), { status: 401 });
  if (Date.now() < session.expires - 30000) return session.accessToken;
  if (!refreshSession) {
    const epoch = sessionEpoch;
    refreshSession = api.request("/auth/v1/token?grant_type=refresh_token", {
      body: { refresh_token: session.refreshToken },
    }).then((data) => {
      if (!session || epoch !== sessionEpoch) throw Object.assign(new Error("Session expired."), { status: 401 });
      session = parseSession(data);
      return session.accessToken;
    }).catch((error) => {
      if ([400, 401, 403].includes(error.status)) {
        throw Object.assign(new Error("Session expired."), { status: 401 });
      }
      throw error;
    }).finally(() => {
      if (epoch === sessionEpoch) refreshSession = null;
    });
  }
  return refreshSession;
}

function updateActiveSection() {
  const active = ["#analytics", "#purchases", "#checkin", "#coupons"].includes(location.hash) ? location.hash.slice(1) : "overview";
  nodeList("[data-section]").forEach((link) => {
    if (link.dataset.section === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

function toggleResults(show) {
  $(".order-scroll").hidden = !show;
  $(".purchase-footer").hidden = !show;
}

function clearDashboardData() {
  ["confirmed", "net", "checkedin", "refunds"].forEach((key) => { $("#metric-" + key).textContent = "—"; });
  $("#checkin-count").textContent = "—";
  $("#checkin-of").textContent = "";
  $("#tier-grid").replaceChildren();
  $("#orders").replaceChildren();
  $("#order-details").replaceChildren();
  toggleResults(false);
}

function showLogin(message) {
  session = null;
  refreshSession = null;
  sessionEpoch += 1;
  requestId += 1;
  page = 0;
  clearTimeout(searchTimer);
  if (orderDialog.open) orderDialog.close();
  document.dispatchEvent(new Event("summit:reset"));
  clearDashboardData();
  filters.reset();
  workspace.removeAttribute("aria-busy");
  layout.hidden = true;
  login.hidden = false;
  form.reset();
  loginStatus.textContent = message;
  $("#admin-email").textContent = "";
  $("#login-heading").focus();
  scrollTo(0, 0);
}

async function revoke(token) {
  if (!token) return;
  try {
    await api.request("/auth/v1/logout?scope=local", { token });
  } catch {
    // Local access was already cleared. Expired sessions may be rejected by Auth.
  }
}

async function signIn(event) {
  event.preventDefault();
  loginButton.disabled = true;
  loginStatus.textContent = "Signing in…";
  let jwt;
  try {
    const data = new FormData(form);
    const credentials = { email: data.get("email").trim(), password: data.get("password") };
    const result = await api.request("/auth/v1/token?grant_type=password", { body: credentials });
    jwt = result.access_token;
    const allowed = await api.admin("summit_admin_access", {}, jwt);
    if (allowed !== true) {
      loginStatus.textContent = "This account does not have organizer access.";
      void revoke(jwt);
      return;
    }
    session = parseSession(result);
    sessionEpoch += 1;
    $("#admin-email").textContent = session.email;
    form.reset();
    loginStatus.textContent = "";
    login.hidden = true;
    layout.hidden = false;
    updateActiveSection();
    $("#overview-heading").focus({ preventScroll: true });
    void loadDashboard();
    document.dispatchEvent(new Event("summit:signedin"));
  } catch (error) {
    if (jwt) void revoke(jwt);
    loginStatus.textContent = error.status === 400 || error.status === 401
      ? "Sign-in failed. Check your email address and password."
      : error.status === 429
        ? "Too many sign-in attempts. Try again in a few minutes."
        : "Sign-in is temporarily unavailable. Please try again.";
  } finally {
    loginButton.disabled = false;
  }
}

function showOverview(data) {
  const totals = data.totals;
  $("#metric-confirmed").textContent = count.format(totals.confirmed);
  $("#metric-net").textContent = api.money(totals.gross_paise - totals.refunded_paise);
  $("#metric-checkedin").textContent = count.format(totals.checked_in ?? 0);
  $("#metric-refunds").textContent = api.money(totals.refunded_paise);
  $("#checkin-count").textContent = count.format(totals.checked_in ?? 0);
  $("#checkin-of").textContent = ` of ${count.format(totals.confirmed)} checked in`;

  $("#tier-grid").replaceChildren(...data.tiers.map((tier) => {
    const block = el("div", undefined, "tier-metric");
    const head = el("div", undefined, "tier-header");
    const bar = el("div", undefined, "tier-bar");
    const fill = el("span");
    fill.style.width = (totals.confirmed ? Math.min(100, 100 * tier.confirmed / totals.confirmed) : 0) + "%";
    bar.setAttribute("aria-hidden", "true");
    head.append(el("span", tier.label), el("strong", `${count.format(tier.confirmed)} sold · ${count.format(tier.checked_in ?? 0)} in`));
    bar.append(fill);
    block.append(head, bar);
    return block;
  }));
}

function ticketNumber(code) {
  return code.slice(0, 4).toUpperCase() + "-" + code.slice(4, 8).toUpperCase();
}

function formattedDate(value, precise = false) {
  return value ? (precise ? dateTime : date).format(new Date(value)) : "—";
}

const emailStatusNames = {
  queued: "Queued",
  sending: "Sending",
  retry: "Retry scheduled",
  sent: "Accepted by Resend",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

function showOrder(order) {
  const fields = [
    ["Customer", order.customer_name],
    ["Pass", order.pass_label],
    ["Email", order.customer_email],
    ["Phone", order.customer_phone],
    ["Payment status", statusNames[order.status] || order.status],
    ["Order total (incl. GST)", api.money(order.amount_paise)],
    ...(order.coupon_code || order.discount_paise ? [
      ["List price", api.money(order.amount_paise + (order.discount_paise || 0))],
      ["Coupon", order.coupon_code || "—"],
      ["Discount", "−" + api.money(order.discount_paise || 0)],
    ] : []),
    ["Refunded", api.money(order.refunded_paise)],
    ["Capture recorded", formattedDate(order.paid_at, true)],
    ["Order created", formattedDate(order.created_at, true)],
    ["Last failed attempt", formattedDate(order.last_failed_at, true)],
    ["Ticket no.", order.ticket_label || (order.ticket_code ? ticketNumber(order.ticket_code) : "—")],
    ["Checked in", order.checked_in_at ? formattedDate(order.checked_in_at, true) : order.ticket_code ? "Not yet" : "—"],
    ["Summit order ID", order.id],
    ["Razorpay order ID", order.razorpay_order_id || "—"],
    ["Razorpay payment ID", order.razorpay_payment_id || "—"],
  ];
  if (order.paid_at || order.ticket_email_status) {
    fields.push(["Ticket email", emailStatusNames[order.ticket_email_status] || "—"]);
    if (order.ticket_email_sent_at) fields.push(["Email accepted at", formattedDate(order.ticket_email_sent_at, true)]);
    if (order.ticket_email_error) fields.push(["Last email error", order.ticket_email_error]);
  }
  const details = el("dl", undefined, "order-details-grid");
  fields.forEach(([label, value]) => {
    const group = el("div");
    group.append(el("dt", label), el("dd", value));
    details.append(group);
  });
  $("#order-details").replaceChildren(details);
  orderDialog.showModal();
}

function renderOrders(data, filtered) {
  const hasRows = data.rows.length > 0;
  $("#orders").replaceChildren(...data.rows.map((order) => {
    const line = el("tr");
    const customer = el("td");
    customer.append(
      el("strong", order.customer_name, "customer-primary"),
      el("span", order.customer_email, "customer-secondary"),
      el("span", order.pass_label, "customer-tier"),
    );
    const currentStatus = el("td");
    const statusKey = Object.hasOwn(statusNames, order.status) ? order.status : "pending";
    currentStatus.append(el("span", statusNames[statusKey], "status-tag " + statusKey));
    const actions = el("td");
    const button = el("button", "View", "button button-secondary order-view");
    button.type = "button";
    button.setAttribute("aria-label", "View order for " + order.customer_name);
    button.addEventListener("click", () => showOrder(order));
    actions.append(button);
    if (order.checked_in_at) currentStatus.append(el("span", "Checked in", "status-tag checked-in"));
    line.append(el("td", order.ticket_label || "—", "ticket-cell"), customer, el("td", order.pass_label), currentStatus,
      el("td", api.money(order.amount_paise), "money-cell"), el("td", formattedDate(order.created_at)), actions);
    return line;
  }));
  const seen = page * pageSize;
  $("#page-summary").textContent = data.count === 1
    ? "1 purchase"
    : `${count.format(seen + 1)}–${count.format(seen + data.rows.length)} of ${count.format(data.count)} purchases`;
  $("#prev-page").disabled = page === 0;
  $("#next-page").disabled = seen + data.rows.length >= data.count;
  ordersStatus.textContent = hasRows ? "" : filtered ? "No purchases match these filters." : "No tickets sold yet.";
  toggleResults(hasRows);
}

async function loadDashboard() {
  if (!session) return;
  const call = ++requestId;
  const data = new FormData(filters);
  const params = {
    p_mode: mode.value,
    p_search: data.get("search").trim(),
    p_status: data.get("status"),
    p_tier: data.get("tier"),
    p_page: page,
  };
  workspace.setAttribute("aria-busy", "true");
  ordersStatus.textContent = "Loading purchases…";

  try {
    const token = await accessToken();
    const result = await api.admin("summit_admin_orders", params, token);
    if (call !== requestId || !session) return;
    const lastPage = Math.max(0, Math.ceil(result.count / pageSize) - 1);
    if (page > lastPage) {
      page = lastPage;
      void loadDashboard();
      return;
    }
    showOverview(result);
    renderOrders(result, params.p_search || params.p_status || params.p_tier);
  } catch (error) {
    if (call !== requestId) return;
    if (error.status === 401 || error.status === 403 || error.code === "42501") {
      showLogin("Organizer access has ended. Sign in to continue.");
      return;
    }
    toggleResults(false);
    ordersStatus.textContent = "Purchases could not be loaded. Select Refresh to try again.";
  } finally {
    if (call === requestId) workspace.removeAttribute("aria-busy");
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Prefix formula-like values so spreadsheet apps treat them as text.
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

async function exportOrders() {
  const button = $("#export-orders");
  button.disabled = true;
  ordersStatus.textContent = "Preparing the attendee list…";
  try {
    const rows = await api.admin("summit_admin_export", { p_mode: mode.value }, await accessToken());
    const header = ["Ticket", "Name", "Email", "Phone", "Pass", "Amount (INR)", "Coupon", "Discount (INR)", "Refunded (INR)", "Status",
      "Paid at", "Checked in at", "Ticket email", "Razorpay payment ID"];
    const lines = rows.map((row) => [row.ticket, row.name, row.email, row.phone, row.pass,
      (row.amount_paise / 100).toFixed(2), row.coupon_code || "", ((row.discount_paise || 0) / 100).toFixed(2), (row.refunded_paise / 100).toFixed(2), statusNames[row.status] || row.status,
      formattedDate(row.paid_at, true), row.checked_in_at ? formattedDate(row.checked_in_at, true) : "",
      emailStatusNames[row.email_status] || "", row.razorpay_payment_id].map(csvCell).join(","));
    const blob = new Blob(["\ufeff" + [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = `beyond-the-limits-attendees-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    ordersStatus.textContent = rows.length ? "" : "No paid tickets to export yet.";
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.code === "42501") {
      showLogin("Organizer access has ended. Sign in to continue.");
      return;
    }
    ordersStatus.textContent = "The attendee list could not be exported. Please try again.";
  } finally {
    button.disabled = false;
  }
}

function reloadFirstPage() {
  clearTimeout(searchTimer);
  page = 0;
  void loadDashboard();
}

if (api.configured) {
  loginButton.disabled = false;
  form.addEventListener("submit", signIn);
} else {
  form.querySelectorAll("input").forEach((input) => { input.disabled = true; });
  loginStatus.textContent = "Connect Supabase in public/js/config.js to enable organizer access.";
}

$("#signout").addEventListener("click", () => {
  const token = session?.accessToken;
  showLogin("Signed out.");
  void revoke(token);
});
$("#refresh-orders").addEventListener("click", loadDashboard);
$("#export-orders").addEventListener("click", exportOrders);
filters.addEventListener("submit", (event) => {
  event.preventDefault();
  reloadFirstPage();
});
filters.addEventListener("change", (event) => {
  if (event.target.tagName === "SELECT") reloadFirstPage();
});
filters.elements.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFirstPage, 275);
});
$("#prev-page").addEventListener("click", () => { if (page > 0) { page -= 1; void loadDashboard(); } });
$("#next-page").addEventListener("click", () => { page += 1; void loadDashboard(); });
orderDialog.addEventListener("close", () => $("#order-details").replaceChildren());
addEventListener("hashchange", updateActiveSection);
