"use strict";

// The early-access address as reversed char codes, so bots scanning the page
// or the public repo never see it as text. It is built only on click.
const EMAIL_CODES = [109, 111, 99, 46, 108, 105, 97, 109, 103, 64, 110, 101, 116, 115, 114, 97, 98, 115, 97, 110, 111, 106];
const EMAIL_SUBJECT = "Tilgang til Fiken MCP";

function emailAddress() {
  return String.fromCharCode(...EMAIL_CODES.slice().reverse());
}

function showEmail(button) {
  const address = emailAddress();
  const link = document.createElement("a");
  link.href = ["mail", "to:"].join("") + address + "?subject=" + encodeURIComponent(EMAIL_SUBJECT);
  link.textContent = address;
  link.className = "email-link";
  button.replaceWith(link);
  link.focus();
}

function setupCopy(button, text) {
  if (!navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    const label = button.textContent;
    button.textContent = "Kopiert";
    setTimeout(() => {
      button.textContent = label;
    }, 2000);
  });
}

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// /stats keys months in UTC, so the page names the month in UTC as well.
async function loadStats() {
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const monthName = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "UTC" }).format(now);
  for (const el of document.querySelectorAll(".month")) el.textContent = monthName;

  let stats;
  try {
    const res = await fetch("/stats");
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }
  if (!stats || !isCount(stats.totalUsers) || !Array.isArray(stats.months)) return;

  const month = stats.months.find((m) => m && m.month === monthKey);
  const format = new Intl.NumberFormat("nb-NO");
  const show = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = format.format(isCount(value) ? value : 0);
  };
  show("stat-total", stats.totalUsers);
  show("stat-active", month ? month.activeUsers : 0);
  show("stat-calls", month ? month.calls : 0);
}

const emailButton = document.getElementById("show-email");
if (emailButton) emailButton.addEventListener("click", () => showEmail(emailButton), { once: true });

const copyButton = document.getElementById("copy-url");
const connectorUrl = document.getElementById("connector-url");
if (copyButton && connectorUrl) setupCopy(copyButton, connectorUrl.textContent.trim());

loadStats();
