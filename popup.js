const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  const e = settings?.emailjs || {};
  $("handles").value = (settings?.handles || []).join(", ");
  $("interval").value = settings?.intervalMin || 5;
  $("pubKey").value = e.publicKey || "";
  $("serviceId").value = e.serviceId || "";
  $("templateId").value = e.templateId || "";
  $("toEmail").value = e.toEmail || "";
  $("settingsBox").open = !(e.publicKey && e.serviceId && e.templateId && e.toEmail);
  render();
});

chrome.storage.onChanged.addListener((_c, area) => { if (area === "local") render(); });

$("save").onclick = async () => {
  await chrome.storage.sync.set({ settings: {
    handles: $("handles").value.split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean),
    intervalMin: Math.max(2, parseInt($("interval").value) || 5),
    emailjs: {
      publicKey: $("pubKey").value.trim(),
      serviceId: $("serviceId").value.trim(),
      templateId: $("templateId").value.trim(),
      toEmail: $("toEmail").value.trim(),
    },
  } });
  show("✅ Saved", true);
};

$("check").onclick = () => run("checkNow", "Checking…", "✅ Checked");
$("test").onclick = () => run("testEmail", "Sending…", "✅ Test email sent — check inbox/spam");

async function run(type, busy, done) {
  show(busy, true);
  const r = await chrome.runtime.sendMessage({ type });
  r.ok ? show(done, true) : show("❌ " + r.error, false);
}

function show(text, ok) {
  $("msg").textContent = text;
  $("msg").className = ok ? "ok" : "err";
}

const fmt = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const BADGE = { sent: "✓ Email sent", retrying: "⟳ Email pending — retrying", failed: "✕ Email failed" };

async function render() {
  const { status, alerts = [] } = await chrome.storage.local.get(["status", "alerts"]);

  if (status) {
    $("pill").textContent = status.ok ? "● Watching" : "● Problem";
    $("pill").className = "pill " + (status.ok ? "ok" : "err");
    $("statusText").textContent = status.ok
      ? `Checked ${fmt(status.ts)} · ${status.live} live Space(s) right now`
      : `${fmt(status.ts)}: ${status.error}`;
    $("statusText").className = status.ok ? "" : "err";
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
    card.innerHTML = '<div class="top"><span class="host"></span><span class="time"></span></div><div class="title"></div><div class="badge"></div>';
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
