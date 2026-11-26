"use strict";

// Admin "Analytics" panel: website visits, clicks and the ticket funnel from Google Analytics 4,
// served by the admin-analytics function (organizers only). Uses globals from admin.js: api, $, el,
// accessToken, showLogin.
(() => {
  const panel = $("#analytics");
  const status = $("#analytics-status");
  const body = $("#analytics-body");
  const refresh = $("#refresh-analytics");
  const rangeButtons = [...panel.querySelectorAll("[data-range]")];
  const number = new Intl.NumberFormat("en-IN");
  const percent = new Intl.NumberFormat("en-IN", { style: "percent", maximumFractionDigits: 1 });
  const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" });
  const funnelNames = {
    page_view: "Visited the website", begin_checkout: "Opened checkout",
    add_payment_info: "Opened payment", purchase: "Bought a pass",
  };
  const dimensionHint = {
    section_id: "Sections reached",
    content_id: "What to Expect tabs",
  };
  let range = "7d";
  let request = 0;
  let loaded = false;

  function duration(seconds) {
    const total = Math.round(seconds);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }

  function source(label) {
    if (label === "(direct) / (none)") return "Direct / typed URL";
    return label.replace(" / (none)", "").replace(" / referral", " (link)").replace(" / organic", " (search)");
  }

  function barList(target, items, format = (value) => number.format(value), labelFor = (label) => label) {
    const list = $(target);
    if (!items?.length) {
      list.replaceChildren(el("li", "No data yet for this period.", "insight-empty"));
      return;
    }
    const max = Math.max(...items.map(({ value }) => value), 1);
    list.replaceChildren(...items.map(({ label, value }) => {
      const row = el("li");
      const bar = el("span", undefined, "insight-bar");
      bar.style.setProperty("--share", `${Math.max(2, (100 * value) / max)}%`);
      row.append(el("span", labelFor(label), "insight-label"), el("strong", format(value)), bar);
      return row;
    }));
  }

  function renderChart(daily) {
    const chart = $("#analytics-chart");
    if (!daily.length) {
      chart.replaceChildren(el("p", "No visits recorded in this period yet.", "insight-empty"));
      return;
    }
    const max = Math.max(...daily.map(({ users }) => users), 1);
    const bars = el("div", undefined, "insight-bars");
    bars.setAttribute("role", "img");
    bars.setAttribute("aria-label", "Visitors per day: " + daily.map(({ date, users }) =>
      `${day.format(new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T12:00:00`))} ${users}`).join(", "));
    daily.forEach(({ date, users, views }) => {
      const when = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T12:00:00`);
      const column = el("div", undefined, "insight-column");
      column.title = `${day.format(when)}: ${number.format(users)} visitors, ${number.format(views)} page views`;
      const bar = el("span");
      bar.style.height = `${Math.max(2, (100 * users) / max)}%`;
      column.append(el("em", number.format(users)), bar, el("small", day.format(when)));
      bars.append(column);
    });
    chart.replaceChildren(el("h3", "Visitors per day"), bars);
  }

  function renderFunnel(funnel) {
    const visitors = funnel[0]?.users || 0;
    $("#analytics-funnel").replaceChildren(...funnel.map(({ event, users }, i) => {
      const step = el("li");
      const share = visitors ? users / visitors : 0;
      const bar = el("span", undefined, "insight-bar");
      bar.style.setProperty("--share", `${Math.max(2, share * 100)}%`);
      step.append(
        el("span", funnelNames[event] || event, "insight-label"),
        el("strong", `${number.format(users)}${i ? ` · ${percent.format(share)}` : ""}`),
        bar,
      );
      return step;
    }));
  }

  function render(data) {
    const t = data.totals;
    const metrics = [
      ["live", data.live === null ? "—" : number.format(data.live)],
      ["users", number.format(t.users)],
      ["views", number.format(t.pageViews)],
      ["sessions", number.format(t.sessions)],
      ["time", duration(t.avgSessionSeconds)],
      ["purchases", number.format(t.purchases)],
    ];
    metrics.forEach(([key, value]) => { $("#insight-" + key).textContent = value; });
    $("#insight-users-note").textContent = `${number.format(t.newUsers)} new · ${percent.format(t.engagementRate)} engaged`;
    $("#insight-purchases-note").textContent = t.revenue ? `${rupees.format(t.revenue)} revenue` : "Tracked in Google Analytics";
    renderChart(data.daily);
    renderFunnel(data.funnel);
    barList("#analytics-clicks", data.clicks);
    barList("#analytics-sections", data.sections, undefined, (label) => label.charAt(0).toUpperCase() + label.slice(1));
    barList("#analytics-tabs", data.tabs);
    barList("#analytics-sources", data.sources, undefined, source);
    barList("#analytics-devices", data.devices, undefined, (label) => label.charAt(0).toUpperCase() + label.slice(1));
    barList("#analytics-cities", data.cities);
    for (const [dimension, title] of Object.entries(dimensionHint)) {
      const list = $(dimension === "section_id" ? "#analytics-sections" : "#analytics-tabs");
      if (data.missing.includes(dimension)) {
        list.replaceChildren(el("li", `To see ${title.toLowerCase()}, register the custom dimension “${dimension}” in GA4 (Admin → Custom definitions).`, "insight-empty"));
      }
    }
    $("#analytics-updated").textContent = `Updated ${time.format(new Date(data.generatedAt))}.`;
    body.hidden = false;
  }

  const messages = {
    not_configured: "Analytics isn’t connected yet. The Google service account key still needs to be added (see the setup steps you were given).",
    ga_permission: "Google Analytics refused access. Add the service account as a Viewer in GA4 → Admin → Property access management.",
    google_auth: "Google rejected the service account key. Create a new JSON key and send it again.",
  };

  async function load(force = false) {
    const call = ++request;
    panel.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    status.textContent = "Loading website analytics…";
    try {
      const data = await api.request("/functions/v1/admin-analytics", { body: { range, refresh: force }, token: await accessToken() });
      if (call !== request) return;
      render(data);
      status.textContent = "";
      loaded = true;
    } catch (error) {
      if (call !== request) return;
      if (error.status === 401 || (error.status === 403 && error.code === "forbidden")) {
        showLogin("Organizer access has ended. Sign in to continue.");
        return;
      }
      // 404: the admin-analytics function has not been deployed yet.
      const code = error.status === 404 ? "not_configured" : error.code;
      status.textContent = messages[code] || "Analytics couldn’t be loaded right now. Select Refresh to try again.";
      if (!loaded) body.hidden = true;
    } finally {
      if (call === request) {
        panel.removeAttribute("aria-busy");
        refresh.disabled = false;
      }
    }
  }

  rangeButtons.forEach((button) => button.addEventListener("click", () => {
    range = button.dataset.range;
    rangeButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    void load();
  }));
  refresh.addEventListener("click", () => load(true));
  document.addEventListener("summit:signedin", () => load());
  document.addEventListener("summit:reset", () => {
    request += 1;
    loaded = false;
    body.hidden = true;
    status.textContent = "";
  });
})();
