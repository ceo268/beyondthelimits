"use strict";

// Gate check-in. Uses globals from admin.js: api, $, el, mode, accessToken, loadDashboard, showLogin,
// formattedDate, ticketNumber.
(() => {
  const video = $("#scanner-video");
  const idle = $("#scanner-idle");
  const startButton = $("#scanner-start");
  const stopButton = $("#scanner-stop");
  const manual = $("#manual-checkin");
  const panel = $("#checkin-result");
  const verdict = $("#checkin-verdict");
  const message = $("#checkin-message");
  const details = $("#checkin-details");
  const undo = $("#checkin-undo");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  // jsQR loads from jsDelivr only when the browser has no built-in QR reader. The hash pins the exact file.
  const jsQRSource = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
  const jsQRIntegrity = "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx";
  let stream = null;
  let detector = null;
  let timer = 0;
  let pending = false;
  let lastText = "";
  let lastSeen = 0;
  let lastCode = null;
  let jsQRPromise = null;
  let audio = null;

  const outcomes = {
    admitted: ["ok", "Admitted", () => "Welcome them in."],
    valid: ["ok", "Valid ticket", () => "This ticket hasn’t been used yet."],
    already: ["warn", "Already checked in", (ticket) =>
      `This ticket was used at ${formattedDate(ticket.checked_in_at, true)}${ticket.checked_in_by ? " by " + ticket.checked_in_by : ""}. Don’t admit again unless you’re sure it’s the same person.`],
    undone: ["idle", "Check-in undone", () => "This ticket can be scanned again."],
    refunded: ["bad", "Refunded ticket", () => "This ticket was refunded. It is not valid for entry."],
    not_paid: ["bad", "Payment not completed", () => "This order was never paid. Do not admit."],
    not_found: ["bad", "Ticket not found", () => "No ticket matches this code. Ask for the ticket email, or search their name under Purchases."],
    wrong_mode: ["bad", "Wrong mode", () => mode.value === "live"
      ? "This is a TEST ticket. It is not valid for entry."
      : "This is a live ticket. Switch the dashboard to Live mode to check it in."],
    ambiguous: ["warn", "More than one match", () => "Type more characters of the code, or scan the QR code."],
    invalid: ["bad", "Not a summit ticket", () => "This QR code isn’t a Beyond the Limits ticket."],
    offline: ["bad", "Couldn’t reach the server", () => "Check the internet connection, then scan again."],
  };

  function beep(good) {
    try {
      audio ||= new AudioContext();
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = good ? 880 : 220;
      gain.gain.value = 0.15;
      tone.connect(gain).connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + (good ? 0.12 : 0.4));
    } catch { /* Sound is optional. */ }
    navigator.vibrate?.(good ? 80 : [200, 100, 200]);
  }

  function render(reply) {
    const [state, title, text] = outcomes[reply.result] || outcomes.invalid;
    const ticket = reply.ticket;
    panel.dataset.state = state;
    verdict.textContent = title;
    message.textContent = text(ticket || {});
    details.replaceChildren(...(ticket ? [
      ["Name", ticket.name],
      ["Pass", ticket.pass_label],
      ["Ticket no.", ticketNumber(ticket.ticket_code)],
      ["Phone", ticket.phone],
      ["Email", ticket.email],
      ["Checked in", ticket.checked_in_at ? formattedDate(ticket.checked_in_at, true) : "Not yet"],
    ] : []).map(([label, value]) => {
      const row = el("div");
      row.append(el("dt", label), el("dd", value || "—"));
      return row;
    }));
    lastCode = ticket?.ticket_code || null;
    undo.hidden = !(ticket && ["admitted", "already"].includes(reply.result));
    if (reply.result !== "undone") beep(state === "ok");
  }

  function reset() {
    stopCamera();
    panel.dataset.state = "idle";
    verdict.textContent = "Ready";
    message.textContent = "Start the camera and point it at the attendee’s QR code.";
    details.replaceChildren();
    undo.hidden = true;
    lastCode = null;
    lastText = "";
  }

  async function check(code, action = "admit") {
    if (pending) return;
    pending = true;
    panel.setAttribute("aria-busy", "true");
    try {
      const token = await accessToken();
      const reply = await api.admin("summit_admin_check_in", { p_code: code, p_mode: mode.value, p_action: action }, token);
      render(reply);
      if (["admitted", "undone"].includes(reply.result)) void loadDashboard();
    } catch (error) {
      if (error.status === 401 || error.status === 403 || error.code === "42501") {
        showLogin("Organizer access has ended. Sign in to continue.");
        return;
      }
      render({ result: "offline" });
    } finally {
      pending = false;
      panel.removeAttribute("aria-busy");
    }
  }

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    jsQRPromise ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = jsQRSource;
      script.integrity = jsQRIntegrity;
      script.crossOrigin = "anonymous";
      script.onload = () => (window.jsQR ? resolve() : reject(new Error("scanner")));
      script.onerror = () => {
        jsQRPromise = null;
        script.remove();
        reject(new Error("scanner"));
      };
      document.head.append(script);
    });
    return jsQRPromise;
  }

  async function prepareDecoder() {
    try {
      if ("BarcodeDetector" in window && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
        detector = new BarcodeDetector({ formats: ["qr_code"] });
        return;
      }
    } catch { /* Fall back to jsQR. */ }
    detector = null;
    await loadJsQR();
  }

  async function readFrame() {
    if (detector) return (await detector.detect(video))[0]?.rawValue ?? null;
    const width = Math.min(640, video.videoWidth);
    const height = Math.round(video.videoHeight * width / video.videoWidth);
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return window.jsQR(image.data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
  }

  async function scan() {
    if (!stream) return;
    if (video.readyState >= 2 && video.videoWidth && !pending) {
      let text = null;
      try { text = await readFrame(); } catch { /* Try the next frame. */ }
      if (text) {
        // Ignore the same QR while it stays in front of the camera, so one ticket isn't scanned twice.
        const repeat = text === lastText && Date.now() - lastSeen < 4000;
        lastText = text;
        lastSeen = Date.now();
        if (!repeat) {
          const match = /^BTL1:([0-9a-f]{32})$/i.exec(text.trim());
          if (match) await check(match[1].toLowerCase());
          else render({ result: "invalid" });
        }
      }
    }
    if (stream) timer = setTimeout(scan, 120);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      render({ result: "invalid" });
      verdict.textContent = "Camera unavailable";
      message.textContent = "This browser can’t open the camera here. Type the ticket number instead.";
      return;
    }
    startButton.disabled = true;
    try {
      await prepareDecoder();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      video.srcObject = stream;
      video.hidden = false;
      idle.hidden = true;
      await video.play();
      startButton.hidden = true;
      stopButton.hidden = false;
      panel.dataset.state = "idle";
      verdict.textContent = "Scanning…";
      message.textContent = "Hold the QR code steady inside the frame.";
      void scan();
    } catch (error) {
      stopCamera();
      panel.dataset.state = "bad";
      verdict.textContent = "Camera didn’t start";
      message.textContent = error?.name === "NotAllowedError"
        ? "Camera permission was blocked. Allow camera access for this site in the browser settings, then try again."
        : error?.name === "NotFoundError"
          ? "No camera was found on this device. Type the ticket number instead."
          : error?.message === "scanner"
            ? "The scanner couldn’t load. Check the connection, or type the ticket number."
            : "The camera couldn’t start. Close other apps using it and try again.";
    } finally {
      startButton.disabled = false;
    }
  }

  function stopCamera() {
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    idle.hidden = false;
    startButton.hidden = false;
    stopButton.hidden = true;
  }

  startButton.addEventListener("click", startCamera);
  stopButton.addEventListener("click", stopCamera);
  manual.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = manual.elements.code;
    void check(input.value.trim()).then(() => { input.value = ""; });
  });
  undo.addEventListener("click", () => { if (lastCode) void check(lastCode, "undo"); });
  document.addEventListener("summit:reset", reset);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
})();
