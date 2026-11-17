/* PageLens side panel */
const $ = (s) => document.querySelector(s);

const MAX_CHARS = 30000;
const HAS_KEY = typeof GEMINI_API_KEY === "string" && GEMINI_API_KEY.startsWith("AIza");

const state = {
  tabId: null,
  page: null,        // scraped data
  busy: false,
  history: [],
};

/* ---------- Scraper (runs inside the web page) ---------- */
function scrapePage() {
  const clean = (t) => (t || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const meta = (sel) => (document.querySelector(sel) || {}).content || "";

  const candidates = ["article", "main", "[role=main]"];
  let text = "";
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.length > text.length) text = el.innerText;
  }
  const body = document.body ? document.body.innerText : "";
  if (text.length < 600 || text.length < body.length * 0.3) text = body;

  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map((h) => clean(h.innerText))
    .filter((h) => h && h.length < 140)
    .slice(0, 40);

  text = clean(text);
  return {
    url: location.href,
    title: document.title || "",
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]') || location.hostname,
    headings,
    linkCount: document.links.length,
    wordCount: text ? text.split(/\s+/).length : 0,
    text: text.slice(0, 60000),
  };
}

async function scanActiveTab() {
  setChip("loading", "Reading page…", "Collecting content");
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { /* ignore */ }
  if (!tab || !tab.id) return setChip("error", "No active tab", "");

  const urlChanged = !state.page || state.page.url !== tab.url;
  state.tabId = tab.id;

  if (!/^https?:|^file:/.test(tab.url || "")) {
    state.page = null;
    state.history = [];
    setChip("error", tab.title || "This page can't be read", "Chrome blocks extensions on this kind of page. Open a normal website.");
    renderWelcome(true);
    return;
  }

  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
    const data = res && res[0] && res[0].result;
    if (!data) throw new Error("No data returned");
    if (urlChanged) state.history = [];
    state.page = data;
    setChip("ok", data.title || data.siteName, `${data.wordCount.toLocaleString()} words · ${data.headings.length} headings`, tab.favIconUrl);
    if (urlChanged) renderWelcome(false);
  } catch (e) {
    state.page = null;
    setChip("error", tab.title || "Can't read this page", "Access denied. For local files, enable “Allow access to file URLs” for this extension.");
    renderWelcome(true);
  }
}

/* ---------- UI helpers ---------- */
function setChip(kind, title, meta, favicon) {
  const chip = $("#chip");
  chip.classList.toggle("loading", kind === "loading");
  $("#chipTitle").textContent = title;
  $("#chipMeta").textContent = meta;
  const img = $("#favicon");
  if (favicon) { img.src = favicon; img.style.display = ""; } else { img.style.display = "none"; }
  updateButtons();
}

function updateButtons() {
  const ready = !!(state.page && state.page.text) && !state.busy;
  document.querySelectorAll(".act").forEach((b) => (b.disabled = b.dataset.kind !== "ask" && !ready));
  $("#sendBtn").disabled = !ready;
}

function renderWelcome(unreadable) {
  const chat = $("#chat");
  chat.innerHTML = "";
  const d = document.createElement("div");
  d.className = "hello";
  d.innerHTML = unreadable
    ? "<h1>Hi,</h1><p>Open a regular website and I'll read it for you.</p>"
    : "<h1>Hi,</h1><p>I've read this page. Summarize it, explain its key concepts, or ask me anything about it.</p>";
  chat.appendChild(d);
}

function addMsg(role, html, loading) {
  const chat = $("#chat");
  const hello = chat.querySelector(".hello");
  if (hello) hello.remove();
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "user") el.textContent = html;
  else el.innerHTML = loading ? '<div class="dots"><span></span><span></span><span></span></div>' : html;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function md(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  let html = "", inList = false;
  for (const line of esc(text).split("\n")) {
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inline(li[1]) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (/^#{1,4}\s/.test(line)) html += "<h4>" + inline(line.replace(/^#+\s/, "")) + "</h4>";
    else if (line.trim()) html += "<p>" + inline(line) + "</p>";
  }
  if (inList) html += "</ul>";
  return html;
}

/* ---------- AI (Google Gemini API, key lives in config.js) ---------- */
function systemPrompt() {
  const p = state.page;
  return [
    "You are PageLens, an assistant that answers questions about the web page the user is currently viewing.",
    "Base every answer on the page content below. If the answer is not on the page, say so plainly instead of guessing.",
    "Write in clear, plain language. Use short paragraphs and '-' bullets. Use **bold** for key terms. Do not use tables.",
    "",
    `<page_meta>\nURL: ${p.url}\nTitle: ${p.title}\nDescription: ${p.description}\nHeadings: ${p.headings.join(" | ")}\n</page_meta>`,
    `<page_content>\n${p.text.slice(0, MAX_CHARS)}\n</page_content>`,
  ].join("\n");
}

const INSTRUCTIONS = {
  summarize: "Summarize this page briefly: one sentence saying what it is, then 4-6 bullets with the most important points. Stay under 150 words.",
  explain: "Explain the key concepts on this page in plain language. Pick the 4-6 most important concepts. For each: a bold name, then 1-2 sentences explaining it as if to a smart newcomer. End with a one-sentence takeaway.",
};

async function askGemini(kind, question) {
  const content = kind === "ask" ? question : INSTRUCTIONS[kind];
  const contents = [...state.history, { role: "user", parts: [{ text: content }] }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e.error && e.error.message) || `Request failed (HTTP ${r.status})`);
  }
  const d = await r.json();
  const cand = d.candidates && d.candidates[0];
  const out = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("\n").trim();
  if (!out) {
    const why = (d.promptFeedback && d.promptFeedback.blockReason) || (cand && cand.finishReason) || "empty response";
    throw new Error("Gemini returned no answer (" + why + ").");
  }
  state.history = [...contents, { role: "model", parts: [{ text: out }] }].slice(-12);
  return out;
}

/* ---------- Local analysis (runs entirely in the browser) ---------- */
const STOP = new Set("the and for that with this from are was were have has had you your our not but can will all any more about into than then them they their its which who what when where how also been being out over such use using one two may per his her she him there these those would could should just very most some other only like make made get got our us we it is as at be by do if in of on or to an a".split(" "));
const words = (s) => (s.toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((w) => !STOP.has(w));
function sentencesOf(text) {
  return (text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) || []).map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 380);
}
function freq(text) {
  const f = {};
  for (const w of words(text)) f[w] = (f[w] || 0) + 1;
  return f;
}
function localSummary(p) {
  const ss = sentencesOf(p.text);
  if (!ss.length) return p.description || "There isn't enough readable text on this page to summarize.";
  const f = freq(p.text);
  const scored = ss.map((s, i) => {
    const w = words(s);
    return { s, i, score: w.reduce((a, x) => a + (f[x] || 0), 0) / Math.sqrt(w.length + 1) };
  });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.i - b.i);
  const lead = p.description ? `**${p.title || p.siteName}** — ${p.description}\n\n` : `**${p.title || p.siteName}**\n\n`;
  return lead + top.map((t) => "- " + t.s).join("\n");
}
function localExplain(p) {
  const ss = sentencesOf(p.text);
  const f = freq(p.text);
  const keys = Object.entries(f).filter(([w]) => w.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  if (!keys.length || !ss.length) return "There isn't enough readable text on this page to explain.";
  const used = new Set();
  const lines = [];
  for (const k of keys) {
    const hit = ss.find((s) => !used.has(s) && words(s).includes(k));
    if (hit) { used.add(hit); lines.push(`- **${k}** — ${hit}`); }
  }
  const heads = p.headings.slice(0, 6).map((h) => "- " + h).join("\n");
  return "**Key concepts**\n" + lines.join("\n") + (heads ? "\n\n**Page sections**\n" + heads : "");
}
function localAsk(p, q) {
  const qw = new Set(words(q));
  if (!qw.size) return "Try asking a more specific question about this page.";
  const ss = sentencesOf(p.text);
  const f = freq(p.text);
  const scored = ss.map((s, i) => {
    const w = new Set(words(s));
    let score = 0;
    qw.forEach((x) => { if (w.has(x)) score += 1 + 1 / Math.log(2 + (f[x] || 1)); });
    return { s, i, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.i - b.i);
  if (!scored.length) return "I couldn't find anything about that on this page.";
  return "Here's what the page says:\n" + scored.map((x) => "- " + x.s).join("\n");
}
function localAnswer(kind, q) {
  const p = state.page;
  return kind === "summarize" ? localSummary(p) : kind === "explain" ? localExplain(p) : localAsk(p, q);
}

/* ---------- Actions ---------- */
async function runTask(kind, question) {
  if (state.busy) return;
  if (!state.page || !state.page.text) {
    addMsg("bot", "<p>I couldn't read any text on this page. Try the re-scan button, or open a different page.</p>");
    return;
  }
  const label = kind === "summarize" ? "Summarize this page" : kind === "explain" ? "Explain the key concepts" : question;
  addMsg("user", label);
  const bubble = addMsg("bot", "", true);
  state.busy = true; updateButtons();
  try {
    const out = HAS_KEY ? await askGemini(kind, question) : localAnswer(kind, question);
    bubble.innerHTML = md(out);
  } catch (e) {
    bubble.classList.add("err");
    bubble.textContent = "Something went wrong: " + e.message;
  } finally {
    state.busy = false; updateButtons();
    $("#chat").scrollTop = $("#chat").scrollHeight;
  }
}

function sendQuestion() {
  const input = $("#input");
  const q = input.value.trim();
  if (!q) { input.focus(); return; }
  input.value = ""; autosize();
  runTask("ask", q);
}
function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}

/* ---------- Wire up ---------- */
document.querySelectorAll(".act").forEach((b) =>
  b.addEventListener("click", () => {
    const k = b.dataset.kind;
    if (k === "ask") {
      const input = $("#input");
      input.value.trim() ? sendQuestion() : input.focus();
    } else runTask(k);
  })
);
$("#sendBtn").addEventListener("click", sendQuestion);
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
});
$("#input").addEventListener("input", autosize);
$("#refreshBtn").addEventListener("click", scanActiveTab);

// Re-scan automatically when the user switches tabs or a page finishes loading.
let timer;
const rescanSoon = () => { clearTimeout(timer); timer = setTimeout(scanActiveTab, 400); };
chrome.tabs.onActivated.addListener(rescanSoon);
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (tab.active && (info.status === "complete" || info.url)) rescanSoon();
});
chrome.windows.onFocusChanged.addListener(rescanSoon);

(async function init() {
  renderWelcome(false);
  updateButtons();
  scanActiveTab();
})();