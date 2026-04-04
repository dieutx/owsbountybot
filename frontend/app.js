const API = window.location.origin;
let programInitialized = false;
let currentFilter = "all";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "textContent") node.textContent = v;
    else if (k === "className") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "title") node.title = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function text(str) { return document.createTextNode(str); }

async function init() {
  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) {
      programInitialized = true;
      updateStats(await res.json());
      loadReports();
    }
  } catch {}

  if (!programInitialized) {
    try {
      const res = await fetch(`${API}/api/bounty/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BountyBot Demo Program", maxPerBug: 150, dailyLimit: 500 }),
      });
      if (res.ok) {
        programInitialized = true;
        updateStats(await res.json());
      }
    } catch {}
  }
  connectSSE();
}

function connectSSE() {
  const evtSource = new EventSource(`${API}/api/events`);
  evtSource.addEventListener("report_submitted", (e) => addFeedItem(JSON.parse(e.data)));
  evtSource.addEventListener("report_evaluated", (e) => { updateFeedItem(JSON.parse(e.data)); refreshStats(); });
  evtSource.addEventListener("payout_authorized", (e) => { const d = JSON.parse(e.data); updateFeedItem(d.report); refreshStats(); });
  evtSource.addEventListener("program_created", (e) => { updateStats(JSON.parse(e.data)); });
}

function updateStats(data) {
  setText("totalAuthorized", `$${data.total_authorized ?? 0}`);
  setText("reportsCount", data.reports_count ?? 0);
  const dailyLimit = data.policy?.dailyLimit || 500;
  const spent = data.daily_spent ?? 0;
  setText("dailyRemaining", `$${Math.max(0, dailyLimit - spent)}`);
  setText("pendingCount", data.pending_review_count ?? 0);

  const evmAccount = data.wallet?.accounts?.find(a => (a.chainId || "").includes("eip155"));
  if (evmAccount) {
    const addr = evmAccount.address;
    const walletEl = document.getElementById("walletAddr");
    if (walletEl) {
      walletEl.textContent = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      walletEl.title = addr;
    }
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

async function refreshStats() {
  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) updateStats(await res.json());
  } catch {}
}

async function loadReports() {
  try {
    const url = currentFilter === "all" ? `${API}/api/reports` : `${API}/api/reports?status=${currentFilter}`;
    const res = await fetch(url);
    if (res.ok) {
      const reports = await res.json();
      const feed = document.getElementById("feed");
      feed.textContent = "";
      if (reports.length === 0) {
        feed.appendChild(el("div", { className: "feed-empty" }, [el("p", { textContent: "No reports match this filter." })]));
      } else {
        reports.forEach(r => addFeedItem(r, false));
      }
    }
  } catch {}
}

function addFeedItem(report, prepend = true) {
  const feed = document.getElementById("feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();
  if (currentFilter !== "all" && report.status !== currentFilter) return;
  const item = buildFeedItem(report);
  if (prepend) feed.prepend(item); else feed.appendChild(item);
}

function updateFeedItem(report) {
  const existing = document.getElementById(`report-${report.id}`);
  if (existing) existing.replaceWith(buildFeedItem(report));
  else addFeedItem(report);
}

function buildFeedItem(report) {
  const sevColors = { critical: "#ff5252", high: "#ffab40", medium: "#ffd740", low: "#8888a0" };
  const qs = report.quality_score ?? 0;
  const conf = report.confidence ?? 0;
  const qColor = qs >= 7 ? "#00e676" : qs >= 4 ? "#ffab40" : "#ff5252";
  const qPct = (qs / 10) * 100;
  const statusClass = (report.status || "").replace(/_/g, "-");

  const item = el("div", { className: `feed-item ${statusClass}`, id: `report-${report.id}` });

  item.appendChild(el("div", { className: "header" }, [
    el("span", { className: "title", textContent: report.title }),
    el("span", { className: `status ${statusClass}`, textContent: (report.status || "").replace(/_/g, " ") }),
  ]));

  const meta = el("div", { className: "meta" });
  meta.appendChild(el("span", { style: { color: sevColors[report.severity] || "#888" }, textContent: (report.severity || "").toUpperCase() }));
  meta.appendChild(text(` · ${report.id} · ${new Date(report.created_at).toLocaleTimeString()}`));
  if (report.vuln_class) meta.appendChild(el("span", { className: "tag", textContent: report.vuln_class }));
  if (report.affected_asset) meta.appendChild(el("span", { className: "tag asset", textContent: report.affected_asset }));
  item.appendChild(meta);

  if (qs > 0) {
    const barFill = el("div", { className: "bar-fill", style: { width: `${qPct}%`, background: qColor } });
    const barChildren = [
      el("span", { style: { fontSize: "11px", color: "var(--text-dim)" }, textContent: "Quality:" }),
      el("div", { className: "bar" }, [barFill]),
      el("span", { className: "score", style: { color: qColor }, textContent: `${qs}/10` }),
    ];
    if (conf > 0) barChildren.push(el("span", { style: { fontSize: "11px", color: "var(--text-dim)", marginLeft: "8px" }, textContent: `conf: ${Math.round(conf * 100)}%` }));
    item.appendChild(el("div", { className: "quality-bar" }, barChildren));
  }

  if (report.duplicate_of) {
    item.appendChild(el("div", { className: "duplicate-flag", textContent: `Possible duplicate of ${report.duplicate_of} (score: ${report.duplicate_score})` }));
  }

  if (report.reasoning) {
    item.appendChild(el("div", { className: "reasoning", textContent: report.reasoning }));
  }

  if (report.status === "signed" || report.status === "confirmed" || report.status === "broadcasted") {
    const ref = report.tx_hash || report.authorization_id || "pending";
    const refLabel = report.tx_hash ? "Tx" : "Auth";
    const refText = ref.length > 24 ? ref.slice(0, 24) + "..." : ref;
    item.appendChild(el("div", { className: "payout-info" }, [
      el("span", { className: "payout-amount", textContent: `$${report.payout} USDC` }),
      el("span", { className: "tx-hash", textContent: `${refLabel}: ${refText}` }),
    ]));
  }

  if (report.status === "pending_review" || report.status === "probable_duplicate") {
    item.appendChild(el("div", { className: "review-actions" }, [
      el("span", { style: { fontSize: "11px", color: "var(--orange)" }, textContent: `Awaiting ${report.review_level || "manual"} review` }),
    ]));
  }

  return item;
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  loadReports();
}

document.getElementById("reportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submitBtn");
  const msgEl = document.getElementById("formMessage");
  btn.disabled = true;
  btn.querySelector(".btn-text").style.display = "none";
  btn.querySelector(".btn-loading").style.display = "inline";
  msgEl.hidden = true;

  const data = {
    title: document.getElementById("bugTitle").value,
    severity: document.querySelector('input[name="severity"]:checked').value,
    description: document.getElementById("bugDescription").value,
    reporterWallet: document.getElementById("reporterWallet").value,
  };

  try {
    const res = await fetch(`${API}/api/report/submit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      msgEl.textContent = json.error || "Submission failed.";
      msgEl.className = "form-message error";
      msgEl.hidden = false;
    } else {
      document.getElementById("reportForm").reset();
      document.querySelector('input[name="severity"][value="high"]').checked = true;
    }
  } catch (err) {
    msgEl.textContent = "Network error. Try again.";
    msgEl.className = "form-message error";
    msgEl.hidden = false;
  }

  btn.disabled = false;
  btn.querySelector(".btn-text").style.display = "inline";
  btn.querySelector(".btn-loading").style.display = "none";
});

function fillGoodReport() {
  document.getElementById("bugTitle").value = "SQL Injection in /api/users search endpoint";
  document.querySelector('input[name="severity"][value="critical"]').checked = true;
  document.getElementById("bugDescription").value = `Steps to reproduce:
1. Navigate to /api/users?search=test
2. Inject payload: /api/users?search=test' OR '1'='1' --
3. The query returns all users in the database

Impact: Full database read access. An attacker can extract all user credentials, PII, and payment information. This is a critical authentication bypass vulnerability.

Proof of Concept:
curl "https://app.example.com/api/users?search=test%27%20OR%20%271%27%3D%271%27%20--"

The vulnerable code is at line 142 in src/controllers/users.js:
const query = \`SELECT * FROM users WHERE name LIKE '%\${search}%'\`;

Recommended fix: Use parameterized queries with prepared statements.`;
  document.getElementById("reporterWallet").value = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38";
};

function fillBadReport() {
  document.getElementById("bugTitle").value = "something might be broken";
  document.querySelector('input[name="severity"][value="low"]').checked = true;
  document.getElementById("bugDescription").value = "I'm not sure but maybe the site is slow sometimes. Could be a bug?";
  document.getElementById("reporterWallet").value = "0xDEADBEEF000000000000000000000000DeAdBeEf";
};

// Bind buttons (no inline onclick — CSP blocks them)
document.getElementById("demoGood").addEventListener("click", fillGoodReport);
document.getElementById("demoBad").addEventListener("click", fillBadReport);
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
});

init();
