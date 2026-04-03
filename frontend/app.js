const API = window.location.origin;

// State
let programInitialized = false;

// Safe DOM helpers
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "textContent") node.textContent = v;
    else if (k === "className") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "title") node.title = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function text(str) { return document.createTextNode(str); }

// Initialize program on load
async function init() {
  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) {
      programInitialized = true;
      updateStats(await res.json());
      loadReports();
    }
  } catch {
    // Not initialized yet
  }

  if (!programInitialized) {
    const res = await fetch(`${API}/api/bounty/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "BountyBot Demo Program",
        description: "Automated bug bounty with OWS-powered payouts",
        maxPerBug: 150,
        dailyLimit: 500,
      }),
    });
    if (res.ok) {
      programInitialized = true;
      updateStats(await res.json());
    }
  }

  connectSSE();
}

// SSE for real-time updates
function connectSSE() {
  const evtSource = new EventSource(`${API}/api/events`);
  evtSource.addEventListener("report_submitted", (e) => {
    addFeedItem(JSON.parse(e.data));
  });
  evtSource.addEventListener("report_evaluated", (e) => {
    updateFeedItem(JSON.parse(e.data));
    refreshStats();
  });
  evtSource.addEventListener("payout_sent", (e) => {
    const { report } = JSON.parse(e.data);
    updateFeedItem(report);
    refreshStats();
  });
}

function updateStats(data) {
  document.getElementById("totalPaid").textContent = `$${data.totalPaid || 0}`;
  document.getElementById("reportsCount").textContent = data.reportsCount || 0;
  document.getElementById("dailyRemaining").textContent = `$${(data.policy?.dailyLimit || 500) - (data.dailySpent || 0)}`;

  const evmAccount = data.wallet?.accounts?.find(a => a.chainId.includes("eip155"));
  if (evmAccount) {
    const addr = evmAccount.address;
    const walletEl = document.getElementById("walletAddr");
    walletEl.textContent = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    walletEl.title = addr;
  }
}

async function refreshStats() {
  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) updateStats(await res.json());
  } catch {}
}

async function loadReports() {
  try {
    const res = await fetch(`${API}/api/reports`);
    if (res.ok) {
      const reports = await res.json();
      const feed = document.getElementById("feed");
      feed.textContent = "";
      reports.forEach(r => addFeedItem(r, false));
    }
  } catch {}
}

function addFeedItem(report, prepend = true) {
  const feed = document.getElementById("feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();

  const item = buildFeedItem(report);
  if (prepend) {
    feed.prepend(item);
  } else {
    feed.appendChild(item);
  }
}

function updateFeedItem(report) {
  const existing = document.getElementById(`report-${report.id}`);
  if (existing) {
    const newItem = buildFeedItem(report);
    existing.replaceWith(newItem);
  }
}

function buildFeedItem(report) {
  const severityColors = { critical: "#ff5252", high: "#ffab40", medium: "#ffd740", low: "#8888a0" };
  const qualityScore = report.qualityScore || 0;
  const qualityColor = qualityScore >= 7 ? "#00e676" : qualityScore >= 4 ? "#ffab40" : "#ff5252";
  const qualityPct = (qualityScore / 10) * 100;

  const item = el("div", { className: `feed-item ${report.status}`, id: `report-${report.id}` });

  // Header row
  const header = el("div", { className: "header" }, [
    el("span", { className: "title", textContent: report.title }),
    el("span", { className: `status ${report.status}`, textContent: report.status }),
  ]);
  item.appendChild(header);

  // Meta row
  const meta = el("div", { className: "meta" });
  meta.appendChild(el("span", { style: { color: severityColors[report.severity] }, textContent: report.severity.toUpperCase() }));
  meta.appendChild(text(` · ${report.id} · ${new Date(report.createdAt).toLocaleTimeString()}`));
  item.appendChild(meta);

  // Quality bar
  if (report.qualityScore !== undefined) {
    const barFill = el("div", { className: "bar-fill", style: { width: `${qualityPct}%`, background: qualityColor } });
    const qualityBar = el("div", { className: "quality-bar" }, [
      el("span", { style: { fontSize: "11px", color: "var(--text-dim)" }, textContent: "Quality:" }),
      el("div", { className: "bar" }, [barFill]),
      el("span", { className: "score", style: { color: qualityColor }, textContent: `${qualityScore}/10` }),
    ]);
    item.appendChild(qualityBar);
  }

  // Reasoning
  if (report.reasoning) {
    item.appendChild(el("div", { className: "reasoning", textContent: report.reasoning }));
  }

  // Payout info
  if (report.status === "paid") {
    const txText = report.txHash ? report.txHash.slice(0, 20) + "..." : "pending";
    const payoutInfo = el("div", { className: "payout-info" }, [
      el("span", { className: "payout-amount", textContent: `$${report.payout} USDC` }),
      el("span", { className: "tx-hash", textContent: `Tx: ${txText}` }),
    ]);
    item.appendChild(payoutInfo);
  }

  return item;
}

// Form submission
document.getElementById("reportForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.querySelector(".btn-text").style.display = "none";
  btn.querySelector(".btn-loading").style.display = "inline";

  const data = {
    title: document.getElementById("bugTitle").value,
    severity: document.querySelector('input[name="severity"]:checked').value,
    description: document.getElementById("bugDescription").value,
    reporterWallet: document.getElementById("reporterWallet").value,
  };

  try {
    await fetch(`${API}/api/report/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.error("Submit error:", err);
  }

  btn.disabled = false;
  btn.querySelector(".btn-text").style.display = "inline";
  btn.querySelector(".btn-loading").style.display = "none";

  document.getElementById("reportForm").reset();
  document.querySelector('input[name="severity"][value="high"]').checked = true;
});

// Demo fill functions
window.fillGoodReport = function () {
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

window.fillBadReport = function () {
  document.getElementById("bugTitle").value = "something might be broken";
  document.querySelector('input[name="severity"][value="low"]').checked = true;
  document.getElementById("bugDescription").value = "I'm not sure but maybe the site is slow sometimes. Could be a bug?";
  document.getElementById("reporterWallet").value = "0xDEADBEEF000000000000000000000000DeAdBeEf";
};

init();
