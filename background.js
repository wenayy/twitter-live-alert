// background.js — X Space Alert
// Every N minutes asks x.com (with your normal browser login) which Spaces the
// people you follow are in — same data as the Spaces bar on your home timeline —
// and alerts once per Space via notification + EmailJS.

const DEFAULT_SETTINGS = {
  intervalMin: 5,
  handles: [], // optional filter; empty = everyone you follow
  emailjs: { publicKey: "", serviceId: "", templateId: "", toEmail: "" },
};

// Public bearer token the x.com web app itself uses.
const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // remember Spaces 3 days so none repeat
const MAX_EMAIL_TRIES = 10;

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings, emailjs: { ...DEFAULT_SETTINGS.emailjs, ...settings?.emailjs } };
}

async function setupAlarm() {
  const { intervalMin } = await getSettings();
  await chrome.alarms.create("poll", { periodInMinutes: Math.max(2, intervalMin), delayInMinutes: 0.1 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["seen", "history"]); // v2 storage, replaced by `alerts`
  setupAlarm();
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) setupAlarm();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "poll") checkSpaces(); });
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("https://")) chrome.tabs.create({ url: id });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const job = msg.type === "checkNow" ? checkSpaces()
    : msg.type === "testEmail" ? getSettings().then((s) => sendEmail(s, {
        id: "test", host: "@test", title: "Test alert from X Space Alert", link: "https://x.com/i/spaces",
      }))
    : null;
  if (!job) return false;
  job.then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e.message || e) }));
  return true; // async reply
});

// ---------- core ----------
// `alerts` (storage.local) is both the dedupe list and the log shown in the popup.
// Each: { id, host, title, link, ts, email: "sent" | "retrying" | "failed", error, tries }

let running = null; // alarm + "Check now" must never overlap (would double-email)
function checkSpaces() {
  running ??= doCheck().finally(() => { running = null; });
  return running;
}

async function doCheck() {
  const settings = await getSettings();
  const { alerts = [] } = await chrome.storage.local.get("alerts");
  let error = null, live = 0;

  try {
    const spaces = await fetchFollowedSpaces();
    live = spaces.length;
    const filter = settings.handles.map((h) => "@" + h.toLowerCase());
    const known = new Set(alerts.map((a) => a.id));
    for (const s of spaces) {
      if (known.has(s.id) || (filter.length && !filter.includes(s.host.toLowerCase()))) continue;
      alerts.unshift({ ...s, ts: Date.now(), email: "retrying", error: null, tries: 0 });
      chrome.notifications.create(s.link, {
        type: "basic", iconUrl: "icon128.png", priority: 2,
        title: `${s.host} is in a Space`, message: s.title,
      });
    }
  } catch (e) {
    error = String(e.message || e);
  }
  await chrome.storage.local.set({ alerts }); // save before emailing so a crash can't re-alert

  // Send every unsent email one by one (new ones + earlier failures), so none are lost.
  for (const a of alerts) {
    if (a.email !== "retrying") continue;
    try {
      await sendEmail(settings, a);
      Object.assign(a, { email: "sent", error: null });
      await chrome.storage.local.set({ alerts });
    } catch (e) {
      a.tries += 1;
      a.error = String(e.message || e);
      if (a.tries >= MAX_EMAIL_TRIES) a.email = "failed";
    }
  }

  const cutoff = Date.now() - KEEP_MS;
  await chrome.storage.local.set({
    alerts: alerts.filter((a) => a.ts > cutoff),
    status: { ok: !error, error, live, ts: Date.now() },
  });
  if (error) throw new Error(error);
}

async function fetchFollowedSpaces() {
  const ct0 = await chrome.cookies.get({ url: "https://x.com", name: "ct0" });
  if (!ct0) throw new Error("Not logged in to x.com in this browser");

  const res = await fetch("https://x.com/i/api/fleets/v1/fleetline?only_spaces=true", {
    credentials: "include",
    headers: {
      authorization: `Bearer ${WEB_BEARER}`,
      "x-csrf-token": ct0.value,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
    },
  });
  if (!res.ok) throw new Error(`x.com returned ${res.status} — open x.com and make sure you're logged in`);
  const data = await res.json();

  // Response shape is undocumented; collect every audiospace object anywhere in it.
  const users = data.users || {};
  const found = new Map();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const a = o.audiospace;
    if (a?.broadcast_id) {
      const name = users[a.creator_twitter_user_id]?.screen_name
        || a.participants?.admins?.[0]?.twitter_screen_name;
      found.set(a.broadcast_id, {
        id: a.broadcast_id,
        title: a.title || "(untitled Space)",
        host: name ? "@" + name : "someone you follow",
        link: `https://x.com/i/spaces/${a.broadcast_id}`,
      });
    }
    for (const v of Object.values(o)) walk(v);
  })(data);
  return [...found.values()];
}

// ---------- email ----------
async function sendEmail({ emailjs: e }, s) {
  if (!(e.publicKey && e.serviceId && e.templateId && e.toEmail)) throw new Error("EmailJS settings incomplete");
  const subject = `${s.host} is in a Space: ${s.title}`;
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: e.serviceId,
      template_id: e.templateId,
      user_id: e.publicKey,
      template_params: {
        email: e.toEmail, to_email: e.toEmail, subject,
        message: `${subject}\n\nJoin: ${s.link}`,
        handle: s.host, space_title: s.title, link: s.link,
      },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
}

