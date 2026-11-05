// background.js — X Space Alert
// Every N minutes asks x.com (with your normal browser login) which Spaces the
// people you follow are in — same data as the Spaces bar on your home timeline —
// and alerts once per Space via notification + EmailJS.

importScripts("quota.js");
try { importScripts("defaults.local.js"); } catch {} // optional personal defaults (gitignored)

const DEFAULT_SETTINGS = {
  intervalMin: 5,
  handles: [], // extra people to watch who you don't follow (everyone you follow is always watched)
  quotaResetDay: 1, // day of month EmailJS resets your 200 emails
  emailjs: { publicKey: "", serviceId: "", templateId: "", toEmail: "" },
  ...self.LOCAL_DEFAULTS,
};

// Public bearer token the x.com web app itself uses.
const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // remember Spaces 3 days so none repeat
const MAX_EMAIL_TRIES = 10;
const REMIND_BEFORE_MS = 10 * 60 * 1000; // scheduled Space reminder lead time

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
  // Fresh install: save defaults so the popup shows them filled in.
  chrome.storage.sync.get("settings").then(({ settings }) => {
    if (!settings) chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  });
  setupAlarm();
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.tabs.onRemoved.addListener((tabId) => finishImport(tabId)); // import tab closed mid-way
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) setupAlarm();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "poll") checkSpaces(); });
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("https://")) chrome.tabs.create({ url: id });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const job = msg.type === "checkNow" ? checkSpaces()
    : msg.type === "testEmail" ? getSettings().then((s) => sendEmail(s, {
        id: "test", host: "@test", title: "Test alert from X Space Alert", link: "https://x.com/i/spaces",
      }))
    : msg.type === "startImport" ? startImport(msg.tabId)
    : msg.type === "followingBatch" ? addFollowing(sender.tab?.id, msg.users)
    : msg.type === "importUsers" ? importUsers(msg.users, msg.source)
    : msg.type === "importDone" ? finishImport(sender.tab?.id)
    : msg.type === "clearImported" ? chrome.storage.local.set({ watchList: {}, importState: null })
    : null;
  if (!job) return false;
  job.then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e.message || e) }));
  return true; // async reply
});

// ---------- core ----------
// `alerts` (storage.local) is both the dedupe list and the log shown in the popup.
// Each: { id, kind: "live" | "scheduled", host, title, link, startsAt, ts,
//         email: "sent" | "retrying" | "failed", error, tries }
// A scheduled Space can produce two alerts: a reminder ("<id>:soon") and, once it starts, a live one ("<id>").

let running = null; // alarm + "Check now" must never overlap (would double-email)
function checkSpaces() {
  running ??= doCheck().finally(() => { running = null; });
  return running;
}

async function doCheck() {
  const settings = await getSettings();
  const { alerts = [] } = await chrome.storage.local.get("alerts");
  lastSample = null;
  watchWarnings = [];
  const results = await Promise.allSettled([fetchFollowedSpaces(), fetchWatchedSpaces(settings.handles)]);
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason));
  errors.push(...watchWarnings);
  const error = errors.length ? errors.join(" · ") : null;
  const spaces = [...new Map(results.flatMap((r) => r.value || []).map((s) => [s.id, s])).values()];
  const live = spaces.length;
  const found = spaces.map((s) => `${s.host} — ${s.title}${s.kind === "scheduled" ? " (scheduled)" : ""}`);

  {
    const known = new Set(alerts.map((a) => a.id));
    for (const s of spaces) {
      const scheduled = s.kind === "scheduled";
      if (scheduled && s.startsAt - Date.now() > REMIND_BEFORE_MS) continue; // too early to remind
      const id = scheduled ? `${s.id}:soon` : s.id;
      if (known.has(id)) continue;
      alerts.unshift({ ...s, id, ts: Date.now(), email: "retrying", error: null, tries: 0 });
      chrome.notifications.create(s.link + (scheduled ? "#soon" : ""), {
        type: "basic", iconUrl: "icon128.png", priority: 2,
        title: headline(s), message: s.title,
      });
    }
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
    status: { ok: !error, error, live, found, ts: Date.now(), sample: lastSample },
  });
  if (error) throw new Error(error);
}

let lastSample = null; // one raw audiospace from the last check, to verify X's format

// Spaces from people you follow (the Spaces bar on your home timeline).
async function fetchFollowedSpaces() {
  return collectSpaces(await xFetch("https://x.com/i/api/fleets/v1/fleetline?only_spaces=true"), {});
}

// Spaces from extra @handles you don't follow — the same data X uses to draw the
// purple "live" ring on avatars. One request per check for all of them.
// Watched = imported Following lists (watchList) + handles typed in Settings.
async function fetchWatchedSpaces(handles) {
  const { watchList = {} } = await chrome.storage.local.get("watchList"); // id -> screen name
  const names = { ...watchList, ...(handles.length ? await resolveUserIds(handles) : {}) };
  const ids = Object.keys(names);
  const spaces = [];
  for (let i = 0; i < ids.length; i += 100) { // keep URLs a sane length
    const batch = ids.slice(i, i + 100).join(",");
    spaces.push(...collectSpaces(await xFetch(`https://x.com/i/api/fleets/v1/avatar_content?user_ids=${batch}&only_spaces=true`), names));
  }
  return spaces;
}

// @handle -> numeric user id, looked up once and remembered. Digits are taken as an id.
// At most LOOKUPS_PER_CHECK new lookups per check, so a big list doesn't hammer X;
// handles not resolved yet are reported in `watchWarnings` and retried next check.
const LOOKUPS_PER_CHECK = 10;
let watchWarnings = [];

async function resolveUserIds(handles) {
  const { userIds = {} } = await chrome.storage.local.get("userIds");
  const missing = handles.filter((h) => !/^\d+$/.test(h) && !userIds[h.toLowerCase()]);
  for (const h of missing.slice(0, LOOKUPS_PER_CHECK)) {
    try {
      const id = await lookupUserId(h);
      if (id) userIds[h.toLowerCase()] = { id, name: h };
      else watchWarnings.push(`Couldn't find @${h} — check spelling or use their numeric ID (tweeterid.com)`);
    } catch (e) {
      watchWarnings.push(String(e.message || e));
      break; // likely rate-limited: stop, retry next check
    }
  }
  if (missing.length) await chrome.storage.local.set({ userIds });
  const pending = missing.length - LOOKUPS_PER_CHECK;
  if (pending > 0) watchWarnings.push(`Looking up ${pending} more @handles over the next checks`);

  const names = {};
  for (const h of handles) {
    if (/^\d+$/.test(h)) names[h] = h;
    else if (userIds[h.toLowerCase()]) names[userIds[h.toLowerCase()].id] = userIds[h.toLowerCase()].name;
  }
  return names;
}

// @handle -> user id via X's public embed page for that profile (no login needed).
// Returns null if X can't find it; then the user can enter the numeric id instead.
async function lookupUserId(handle) {
  const res = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`);
  if (!res.ok) throw new Error(`Couldn't look up @${handle} (X ${res.status}) — enter their numeric user ID instead (tweeterid.com)`);
  const json = (await res.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  let id = null;
  (function walk(o) {
    if (id || !o || typeof o !== "object") return;
    if (typeof o.screen_name === "string" && o.screen_name.toLowerCase() === handle.toLowerCase() && o.id_str) id = o.id_str;
    else for (const v of Object.values(o)) walk(v);
  })(json ? JSON.parse(json) : null);
  return id;
}

async function xFetch(url) {
  const ct0 = await chrome.cookies.get({ url: "https://x.com", name: "ct0" });
  if (!ct0) throw new Error("Not logged in to x.com in this browser");
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      authorization: `Bearer ${WEB_BEARER}`,
      "x-csrf-token": ct0.value,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
    },
  });
  if (!res.ok) {
    const what = new URL(url).pathname.split("/").pop();
    throw new Error(`x.com ${what} returned ${res.status}` + (res.status === 401 || res.status === 403 ? " — log in to x.com" : ""));
  }
  return res.json();
}

// First screen name anywhere inside `o` (admins/host come before listeners in X's data).
function findScreenName(o) {
  if (!o || typeof o !== "object") return null;
  for (const [k, v] of Object.entries(o)) {
    if ((k === "screen_name" || k === "twitter_screen_name") && typeof v === "string") return v;
  }
  for (const v of Object.values(o)) {
    const n = findScreenName(v);
    if (n) return n;
  }
  return null;
}

// X's response shapes are undocumented; collect every audiospace object anywhere.
// `names` maps user id -> screen name; a numeric key above the Space (avatar_content
// is keyed by user id) names the watched person when the creator id doesn't.
function collectSpaces(data, names) {
  const users = data.users || {};
  const nameOf = (id) => names[id] || users[id]?.screen_name;
  const found = new Map();
  (function walk(o, ctxId) {
    if (!o || typeof o !== "object") return;
    const a = o.audiospace;
    if (a?.broadcast_id && !["Ended", "TimedOut", "Canceled"].includes(a.state)) {
      lastSample ??= JSON.stringify(o).slice(0, 4000); // for "Copy debug info"
      const scheduled = a.state === "NotStarted" || (a.state !== "Running" && a.scheduled_start > Date.now());
      const name = (names[ctxId] && nameOf(ctxId)) || nameOf(a.creator_twitter_user_id)
        || a.participants?.admins?.[0]?.twitter_screen_name || findScreenName(a) || findScreenName(o);
      found.set(a.broadcast_id, {
        id: a.broadcast_id,
        title: a.title || "(untitled Space)",
        host: name ? "@" + name : "someone you follow",
        link: `https://x.com/i/spaces/${a.broadcast_id}`,
        kind: scheduled ? "scheduled" : "live",
        startsAt: scheduled ? a.scheduled_start || null : null,
      });
    }
    for (const [k, v] of Object.entries(o)) walk(v, /^\d+$/.test(k) ? k : ctxId);
  })(data);
  return [...found.values()];
}

// ---------- import a Following list ----------
// Reload the open x.com/<account>/following tab and scroll it to the end; hook.js
// passes each page of users X loads. Only batches from that tab are accepted.

async function startImport(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const account = tab.url?.match(/^https:\/\/x\.com\/([^/?#]+)\/following/)?.[1];
  if (!account) throw new Error("Open an account's Following page on x.com (profile → Following), then click Import");
  await chrome.storage.session.set({ importTab: tabId });
  await chrome.storage.local.set({ importState: { running: true, account, added: 0 } });
  const loaded = new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function done(id, info) {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); }
    });
  });
  await chrome.tabs.reload(tabId); // so hook.js sees the first page of the list too
  await loaded;
  await chrome.scripting.executeScript({ target: { tabId }, func: scrollToEnd });
}

// Runs in the tab: scroll until X stops sending new people. Always ends: after
// 12s with no new people, after 5 min total, if you scroll/click/type yourself,
// or if you leave the Following page.
function scrollToEnd() {
  if (window.__xsaScrolling) return;
  window.__xsaScrolling = true;
  const started = Date.now();
  let lastNew = Date.now();
  const onBatch = (e) => { if (e.source === window && e.data?.__xsa === "following") lastNew = Date.now(); };
  const stop = () => {
    clearInterval(timer);
    window.removeEventListener("message", onBatch);
    for (const ev of ["wheel", "keydown", "mousedown", "touchstart"]) window.removeEventListener(ev, stop, true);
    window.__xsaScrolling = false;
    chrome.runtime.sendMessage({ type: "importDone" });
  };
  window.addEventListener("message", onBatch);
  for (const ev of ["wheel", "keydown", "mousedown", "touchstart"]) window.addEventListener(ev, stop, true);
  const timer = setInterval(() => {
    if (!/\/following/.test(location.pathname) || Date.now() - lastNew > 12000 || Date.now() - started > 5 * 60000) return stop();
    window.scrollTo(0, document.body.scrollHeight);
  }, 1500);
}

let importChain = Promise.resolve(); // batches arrive fast; apply them one at a time
function addFollowing(tabId, users) {
  importChain = importChain.then(async () => {
    const { importTab } = await chrome.storage.session.get("importTab");
    if (tabId === importTab) await mergeWatchList(users);
  });
  return importChain;
}

// Users from a CSV that has both ids and usernames.
function importUsers(users, source) {
  importChain = importChain.then(async () => {
    await chrome.storage.local.set({ importState: { running: false, account: source, csv: true, added: 0, ts: Date.now() } });
    await mergeWatchList(users);
  });
  return importChain;
}

async function mergeWatchList(users) {
  if (!Array.isArray(users)) return;
  const { watchList = {}, importState } = await chrome.storage.local.get(["watchList", "importState"]);
  let added = 0;
  for (const u of users) {
    if (/^\d+$/.test(u.id) && !watchList[u.id]) { watchList[u.id] = String(u.name); added++; }
  }
  await chrome.storage.local.set({ watchList, importState: { ...importState, added: importState.added + added } });
}

function finishImport(tabId) {
  importChain = importChain.then(async () => {
    const { importTab } = await chrome.storage.session.get("importTab");
    if (tabId !== importTab) return;
    await chrome.storage.session.remove("importTab");
    const { importState } = await chrome.storage.local.get("importState");
    await chrome.storage.local.set({ importState: { ...importState, running: false, ts: Date.now() } });
  });
  return importChain;
}

// ---------- email ----------
async function sendEmail({ emailjs: e }, s) {
  if (!(e.publicKey && e.serviceId && e.templateId && e.toEmail)) throw new Error("EmailJS settings incomplete");
  const subject = `${headline(s)}: ${s.title}`;
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
  await countEmail();
}

function headline(s) {
  if (s.kind !== "scheduled") return `${s.host} is in a Space`;
  const at = s.startsAt ? new Date(s.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "soon";
  return `${s.host}'s Space starts at ${at}`;
}

// emailUsage = { period: quota month start, n: emails sent in it }. Chained so
// a test email and a check sending at the same time can't lose a count.
let usageChain = Promise.resolve();
function countEmail() {
  usageChain = usageChain.then(async () => {
    const { quotaResetDay } = await getSettings();
    const period = quotaPeriod(quotaResetDay);
    const { emailUsage } = await chrome.storage.local.get("emailUsage");
    const n = emailUsage?.period === period ? emailUsage.n + 1 : 1;
    await chrome.storage.local.set({ emailUsage: { period, n } });
  });
  return usageChain;
}

