const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  const e = settings?.emailjs || {};
  $("handles").value = (settings?.handles || []).join(", ");
  $("interval").value = settings?.intervalMin || 5;
  $("resetDay").value = settings?.quotaResetDay || 1;
  $("pubKey").value = e.publicKey || "";
  $("serviceId").value = e.serviceId || "";
  $("templateId").value = e.templateId || "";
  $("toEmail").value = e.toEmail || "";
  $("settingsBox").open = location.hash === "#settings" || !(e.publicKey && e.serviceId && e.templateId && e.toEmail);
  render();
});

chrome.storage.onChanged.addListener((_c, area) => { if (area === "local") render(); });

$("save").onclick = save;

async function save() {
  try { await chrome.storage.sync.set({ settings: {
    handles: $("handles").value.split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean),
    intervalMin: Math.max(2, parseInt($("interval").value) || 5),
    quotaResetDay: Math.min(28, Math.max(1, parseInt($("resetDay").value) || 1)),
    emailjs: {
      publicKey: $("pubKey").value.trim(),
      serviceId: $("serviceId").value.trim(),
      templateId: $("templateId").value.trim(),
      toEmail: $("toEmail").value.trim(),
    },
  } }); } catch (e) {
    return show("❌ Couldn't save: " + e.message + " (too many @handles? import a CSV with ids instead)", false);
  }
  show("✅ Saved", true);
  render();
}

// ---------- CSV import ----------
// A file picker closes the toolbar popup on some systems, so pick the file from a full tab.
const inTab = new URLSearchParams(location.search).has("tab");
if (inTab) document.body.style.width = "420px";
$("csvBtn").onclick = () => inTab ? $("csvFile").click() : chrome.tabs.create({ url: "popup.html?tab#settings" });

$("csvFile").onchange = async () => {
  const file = $("csvFile").files[0];
  if (!file) return;
  const { users = [], handles = [] } = parseCsv(await file.text());
  if (!users.length && !handles.length) {
    show("❌ No usernames found in that file", false);
  } else {
    if (users.length) await chrome.runtime.sendMessage({ type: "importUsers", users, source: file.name });
    const existing = new Set($("handles").value.split(/[\s,]+/).map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean));
    const fresh = [...new Set(handles)].filter((h) => !existing.has(h.toLowerCase()));
    if (fresh.length) {
      $("handles").value = [$("handles").value.trim(), ...fresh].filter(Boolean).join(", ");
      await save();
    }
    show(`✅ From ${file.name}: ${users.length} added to watch list, ${fresh.length} new @handles`, true);
  }
  $("csvFile").value = "";
};

// Everyone watched (imported lists + typed @handles) as id,username — re-importable.
$("exportCsv").onclick = async () => {
  const { watchList = {}, userIds = {} } = await chrome.storage.local.get(["watchList", "userIds"]);
  const { settings } = await chrome.storage.sync.get("settings");
  const rows = new Map(Object.entries(watchList).map(([id, name]) => [id || name, [id, name]]));
  for (const h of settings?.handles || []) {
    const known = /^\d+$/.test(h) ? [h, ""] : userIds[h.toLowerCase()] ? [userIds[h.toLowerCase()].id, h] : ["", h];
    if (!rows.has(known[0] || known[1])) rows.set(known[0] || known[1], known);
  }
  if (!rows.size) return show("Nothing to export yet", false);
  const csv = "id,username\n" + [...rows.values()].map(([id, name]) => `${id},${name}`).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `x-space-alert-watchlist-${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  show(`✅ Exported ${rows.size} people`, true);
};

function splitCsvLine(line) {
  const cells = [""];
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') { cells[cells.length - 1] += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) cells.push("");
    else cells[cells.length - 1] += c;
  }
  return cells.map((c) => c.trim());
}

// Header row with an id column + a username column -> { users }; otherwise
// every cell that looks like a handle (or x.com/handle link) -> { handles }.
function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(splitCsvLine);
  if (!rows.length) return { handles: [] };
  const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const idCol = header.findIndex((h) => ["id", "userid", "restid", "idstr", "twitterid"].includes(h));
  const nameCol = header.findIndex((h) => ["username", "screenname", "handle", "twitterhandle", "user", "twitter"].includes(h));
  const handleOf = (c) => c.replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];

  if (idCol >= 0 && nameCol >= 0) {
    const all = rows.slice(1).map((r) => ({ id: r[idCol] || "", name: handleOf(r[nameCol] || "") })).filter((u) => u.name);
    const users = all.filter((u) => /^\d+$/.test(u.id));
    const handles = all.filter((u) => !/^\d+$/.test(u.id)).map((u) => u.name).filter((h) => /^\w{1,15}$/.test(h));
    return { users, handles }; // rows without an id get looked up like typed handles
  }
  const cells = nameCol >= 0 ? rows.slice(1).map((r) => r[nameCol] || "") : rows.flat();
  return { handles: cells.map(handleOf).filter((h) => /^\w{1,15}$/.test(h) && !/^\d+$/.test(h)) };
}

$("debug").onclick = async () => {
  const { status } = await chrome.storage.local.get("status");
  await navigator.clipboard.writeText(JSON.stringify(status, null, 2));
  show("✅ Debug info copied — paste it to whoever is helping you", true);
};

$("check").onclick = () => run({ type: "checkNow" }, "Checking…", "✅ Checked");
$("test").onclick = () => run({ type: "testEmail" }, "Sending…", "✅ Test email sent — check inbox/spam");
$("import").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  run({ type: "startImport", tabId: tab.id }, "Starting import…", "⏳ Importing — the tab scrolls by itself, you can close this popup");
};
$("clearImported").onclick = () => run({ type: "clearImported" }, "Clearing…", "✅ Cleared imported people");

async function run(msg, busy, done) {
  show(busy, true);
  const r = await chrome.runtime.sendMessage(msg);
  r.ok ? show(done, true) : show("❌ " + r.error, false);
}

function show(text, ok) {
  $("msg").textContent = text;
  $("msg").className = ok ? "ok" : "err";
}

const fmt = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const BADGE = { sent: "✓ Email sent", retrying: "⟳ Email pending — retrying", failed: "✕ Email failed" };

async function render() {
  const { status, alerts = [], emailUsage, watchList = {}, importState } =
    await chrome.storage.local.get(["status", "alerts", "emailUsage", "watchList", "importState"]);

  const total = Object.keys(watchList).length;
  $("imported").textContent = importState?.running
    ? `⏳ Importing @${importState.account}'s Following… ${importState.added} added so far`
    : total
      ? `${total} people watched` + (importState ? ` · last import ${importState.csv ? "" : "@"}${importState.account} added ${importState.added}` : "")
      : "None yet";
  const { settings } = await chrome.storage.sync.get("settings");

  const period = quotaPeriod(settings?.quotaResetDay || 1);
  const used = emailUsage?.period === period ? emailUsage.n : 0;
  const next = new Date(period + "T00:00");
  next.setMonth(next.getMonth() + 1);
  $("usage").textContent = `✉️ ${used} / ${EMAIL_QUOTA} emails used · resets ${next.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  $("usage").className = used >= EMAIL_QUOTA ? "full" : used >= EMAIL_QUOTA * 0.9 ? "warn" : "";

  if (status) {
    $("pill").textContent = status.ok ? "● Watching" : "● Problem";
    $("pill").className = "pill " + (status.ok ? "ok" : "err");
    $("statusText").textContent = status.ok
      ? `Checked ${fmt(status.ts)} · ${status.live} live Space(s) right now`
      : `${fmt(status.ts)}: ${status.error}`;
    $("statusText").className = status.ok ? "" : "err";
    $("found").textContent = status.found?.length ? "Live now (from X): " + status.found.join(" · ") : "";
  }

  const box = $("alerts");
  box.replaceChildren();
  if (!alerts.length) {
    box.innerHTML = '<div class="empty">No Spaces yet — each alert will show here.</div>';
    return;
  }
  for (const a of alerts) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = a.link;
    card.target = "_blank";
    card.innerHTML = '<div class="top"><span class="host"></span><span class="time"></span></div><div class="title"></div><div class="when"></div><div class="badge"></div>';
    const when = card.querySelector(".when");
    if (a.kind === "scheduled") {
      when.textContent = "🗓 Scheduled — starts " + (a.startsAt ? fmt(a.startsAt) : "soon");
    } else when.remove();
    card.querySelector(".host").textContent = a.host;
    card.querySelector(".time").textContent = fmt(a.ts);
    card.querySelector(".title").textContent = a.title;
    card.querySelector(".title").title = a.title;
    const badge = card.querySelector(".badge");
    badge.className = "badge " + a.email;
    badge.textContent = BADGE[a.email] + (a.email !== "sent" && a.error ? ` (${a.error})` : "");
    box.append(card);
  }
}
