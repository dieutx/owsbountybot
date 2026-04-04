const API = window.location.origin;
const CHAIN_PLACEHOLDERS = {
  evm: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38",
  solana: "Gbh2SE8M2SoP4Ct3xLnZoUC8MWSvjmQ3WUK5pU5TNyJ2",
};

let programInitialized = false;
let currentFilter = "all";
let sseConnected = false;

const knownStates = new Map();

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "textContent") node.textContent = value;
    else if (key === "className") node.className = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key === "title") node.title = value;
    else if (key === "value") node.value = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function text(value) {
  return document.createTextNode(value);
}

function getAdminToken() {
  return document.getElementById("adminToken").value.trim();
}

function getReviewerName() {
  return document.getElementById("reviewerName").value.trim() || "admin";
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getAdminToken();
  if (token) headers["x-admin-token"] = token;
  return headers;
}

function setWalletPlaceholder() {
  const chain = document.getElementById("reportChain").value;
  document.getElementById("reporterWallet").placeholder = CHAIN_PLACEHOLDERS[chain] || CHAIN_PLACEHOLDERS.evm;
}

function shortAddress(address) {
  if (!address) return "—";
  return address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString();
}

function formatThreshold(value) {
  return value == null || !Number.isFinite(value) ? "∞" : `$${value}`;
}

function showMessage(id, textContent, kind = "error") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = textContent;
  node.className = `form-message ${kind}`;
  node.hidden = false;
}

function hideMessage(id) {
  const node = document.getElementById(id);
  if (node) node.hidden = true;
}

async function init() {
  setWalletPlaceholder();

  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) {
      programInitialized = true;
      updateStats(await res.json());
      await loadReports(true);
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
        await loadReports(true);
      }
    } catch {}
  }

  refreshInsights();
  connectSSE();
}

function connectSSE() {
  const evtSource = new EventSource(`${API}/api/events`);
  evtSource.addEventListener("connected", () => {
    sseConnected = true;
  });
  evtSource.addEventListener("report_submitted", (event) => addFeedItem(JSON.parse(event.data)));
  evtSource.addEventListener("report_evaluated", (event) => {
    updateFeedItem(JSON.parse(event.data));
    refreshStats();
    refreshInsights();
  });
  evtSource.addEventListener("payout_authorized", (event) => {
    const payload = JSON.parse(event.data);
    updateFeedItem(payload.report);
    refreshStats();
    refreshInsights();
  });
  evtSource.addEventListener("program_created", (event) => {
    updateStats(JSON.parse(event.data));
    refreshInsights();
  });
  evtSource.addEventListener("program_reset", () => {
    knownStates.clear();
    loadReports(true);
    refreshStats();
    refreshInsights();
  });
  evtSource.onerror = () => {
    sseConnected = false;
  };
}

setInterval(() => {
  const dot = document.getElementById("statusDot");
  if (dot) dot.className = `status-dot ${sseConnected ? "live" : "offline"}`;
  refreshStats();
  refreshInsights();
  if (!sseConnected) loadReports();
}, 15000);

async function resetAll() {
  if (!getAdminToken()) {
    showMessage("adminMessage", "Admin token is required to reset the program.");
    return;
  }
  if (!confirm("Clear all reports and transactions? This cannot be undone.")) return;

  try {
    const res = await fetch(`${API}/api/reset`, { method: "POST", headers: authHeaders() });
    const json = await res.json();
    if (!res.ok) {
      showMessage("adminMessage", json.error || "Reset failed.");
      return;
    }

    hideMessage("adminMessage");
    knownStates.clear();
    await loadReports(true);
    refreshStats();
    refreshInsights();
  } catch {
    showMessage("adminMessage", "Network error while resetting the program.");
  }
}

function updateStats(data) {
  setText("totalAuthorized", `$${data.total_authorized ?? 0}`);
  setText("reportsCount", data.reports_count ?? 0);
  const dailyLimit = data.policy?.dailyLimit || 500;
  const spent = data.daily_spent ?? 0;
  setText("dailyRemaining", `$${Math.max(0, dailyLimit - spent)}`);
  setText("pendingCount", data.pending_review_count ?? 0);

  const accounts = data.wallet?.accounts || [];
  if (accounts.length > 0) {
    const first = accounts[0];
    const suffix = accounts.length > 1 ? ` +${accounts.length - 1}` : "";
    const walletEl = document.getElementById("walletAddr");
    if (walletEl) {
      walletEl.textContent = `${shortAddress(first.address)}${suffix}`;
      walletEl.title = accounts.map(account => `${account.chainId}: ${account.address}`).join("\n");
    }
  }
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

async function refreshStats() {
  try {
    const res = await fetch(`${API}/api/bounty`);
    if (res.ok) updateStats(await res.json());
  } catch {}
}

async function refreshInsights() {
  await Promise.all([loadPolicySummary(), loadAuditLog()]);
}

async function loadPolicySummary() {
  try {
    const [policyRes, walletRes] = await Promise.all([
      fetch(`${API}/api/policy`),
      fetch(`${API}/api/wallet`),
    ]);

    if (!policyRes.ok) return;
    const policy = await policyRes.json();
    const wallet = walletRes.ok ? await walletRes.json() : { accounts: [] };

    const summary = document.getElementById("policySummary");
    const accounts = document.getElementById("treasuryAccounts");
    summary.textContent = "";
    accounts.textContent = "";

    const rows = [
      ["Allowed Chains", (policy.allowedChains || []).join(", ") || "—"],
      ["Daily Budget", `$${policy.dailyLimit ?? 0}`],
      ["Daily Remaining", `$${policy.dailyRemaining ?? 0}`],
      ["Review Thresholds", `auto ≤ ${formatThreshold(policy.reviewThresholds?.auto)} · manual ≤ ${formatThreshold(policy.reviewThresholds?.manual)} · admin ≤ ${formatThreshold(policy.reviewThresholds?.admin)}`],
      ["Reporter Limit", `${policy.maxPerReporterPerDay ?? 0} per day`],
      ["Cooldown", `${policy.cooldownSeconds ?? 0}s`],
    ];

    rows.forEach(([key, value]) => {
      summary.appendChild(el("div", { className: "detail-item" }, [
        el("span", { className: "detail-key", textContent: key }),
        el("span", { className: "detail-value", textContent: value }),
      ]));
    });

    const allowedChainIds = new Set((policy.allowedChains || []).map((chain) => {
      if (chain === "evm") return "eip155:1";
      if (chain === "solana") return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
      return chain;
    }));
    const visibleAccounts = (wallet.accounts || []).filter(account => allowedChainIds.size === 0 || allowedChainIds.has(account.chainId));

    if (visibleAccounts.length === 0) {
      accounts.appendChild(el("div", { className: "feed-empty" }, [
        el("p", { textContent: "No treasury accounts available." }),
      ]));
      return;
    }

    visibleAccounts.forEach((account) => {
      accounts.appendChild(el("div", { className: "account-item" }, [
        el("span", { className: "account-chain", textContent: account.chainId }),
        el("span", { className: "account-address", textContent: account.address }),
      ]));
    });
  } catch {}
}

function formatAuditDetails(details) {
  if (!details) return "No details";
  if (Array.isArray(details)) {
    return details.map((item) => item.reason || JSON.stringify(item)).join(" | ");
  }
  if (typeof details === "object") {
    return Object.entries(details).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" | ");
  }
  return String(details);
}

async function loadAuditLog() {
  try {
    const res = await fetch(`${API}/api/audit?limit=12`);
    if (!res.ok) return;
    const entries = await res.json();
    const feed = document.getElementById("auditFeed");
    feed.textContent = "";

    if (entries.length === 0) {
      feed.appendChild(el("div", { className: "feed-empty" }, [el("p", { textContent: "No audit entries yet." })]));
      return;
    }

    entries.forEach((entry) => {
      feed.appendChild(el("div", { className: "audit-item" }, [
        el("div", { className: "audit-action" }, [
          el("strong", { textContent: entry.action }),
          el("span", { className: "audit-time", textContent: formatTime(entry.created_at) }),
        ]),
        el("div", { className: "audit-meta", textContent: `${entry.entity_type || "system"} · ${entry.entity_id || "—"} · ${entry.actor || "system"}` }),
        el("div", { className: "audit-details", textContent: formatAuditDetails(entry.details) }),
      ]));
    });
  } catch {}
}

async function loadReports(forceRebuild = false) {
  try {
    const url = currentFilter === "all"
      ? `${API}/api/reports`
      : currentFilter === "duplicates"
        ? `${API}/api/reports?duplicates=1`
        : `${API}/api/reports?status=${currentFilter}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const reports = await res.json();
    const feed = document.getElementById("feed");

    if (forceRebuild) {
      feed.textContent = "";
      knownStates.clear();
      if (reports.length === 0) {
        feed.appendChild(el("div", { className: "feed-empty" }, [el("p", { textContent: "No reports match this filter." })]));
      } else {
        reports.forEach((report) => {
          knownStates.set(report.id, report.status);
          addFeedItem(report, false);
        });
      }
      return;
    }

    const serverIds = new Set(reports.map(report => report.id));

    for (const report of reports) {
      const existing = document.getElementById(`report-${report.id}`);
      if (!existing) {
        knownStates.set(report.id, report.status);
        addFeedItem(report, true);
      } else if (knownStates.get(report.id) !== report.status) {
        knownStates.set(report.id, report.status);
        existing.replaceWith(buildFeedItem(report));
      }
    }

    for (const node of [...feed.querySelectorAll(".feed-item")]) {
      const id = node.id.replace("report-", "");
      if (!serverIds.has(id)) node.remove();
    }

    const empty = feed.querySelector(".feed-empty");
    if (feed.querySelectorAll(".feed-item").length === 0 && !empty) {
      feed.appendChild(el("div", { className: "feed-empty" }, [el("p", { textContent: "No reports match this filter." })]));
    } else if (feed.querySelectorAll(".feed-item").length > 0 && empty) {
      empty.remove();
    }
  } catch {}
}

function addFeedItem(report, prepend = true) {
  if (!report || !report.id) return;
  if (document.getElementById(`report-${report.id}`)) {
    updateFeedItem(report);
    return;
  }

  if (currentFilter === "duplicates" && !report.duplicate_of) return;
  if (currentFilter !== "all" && currentFilter !== "duplicates" && report.status !== currentFilter) return;

  const feed = document.getElementById("feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();

  knownStates.set(report.id, report.status);
  const item = buildFeedItem(report);
  if (prepend) feed.prepend(item);
  else feed.appendChild(item);
}

function updateFeedItem(report) {
  const existing = document.getElementById(`report-${report.id}`);
  if (existing) {
    const next = buildFeedItem(report);
    next.classList.add("updated");
    existing.replaceWith(next);
  } else {
    addFeedItem(report);
  }
}

function buildReviewActions(report) {
  const wrapper = el("div", { className: "review-actions" }, [
    el("span", { style: { fontSize: "11px", color: "var(--orange)" }, textContent: `Awaiting ${report.review_level || "manual"} review` }),
  ]);

  if (!getAdminToken()) return wrapper;

  const payoutInput = el("input", {
    className: "review-input",
    type: "number",
    min: "1",
    step: "1",
    placeholder: report.payout > 0 ? String(report.payout) : "Adjusted payout",
    value: report.payout > 0 ? String(report.payout) : "",
  });
  const reasonInput = el("input", {
    className: "review-input",
    type: "text",
    placeholder: "Reject reason or review note",
  });
  const feedback = el("div", { className: "audit-details", hidden: "hidden" });

  const setFeedback = (message, ok = false) => {
    feedback.hidden = false;
    feedback.textContent = message;
    feedback.style.color = ok ? "var(--green)" : "var(--red)";
  };

  const submitReview = async (action) => {
    const body = {
      action,
      reviewedBy: getReviewerName(),
    };

    if (action === "approve" && payoutInput.value) {
      body.adjustedPayout = Number(payoutInput.value);
    }
    if (action === "reject") {
      body.reason = reasonInput.value.trim() || "Rejected during manual review.";
    } else if (reasonInput.value.trim()) {
      body.reason = reasonInput.value.trim();
    }

    try {
      const res = await fetch(`${API}/api/report/${report.id}/review`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setFeedback(json.error || "Review action failed.");
        return;
      }

      setFeedback(`Review action applied: ${json.status}`, true);
      updateFeedItem(json);
      refreshStats();
      refreshInsights();
    } catch {
      setFeedback("Network error while submitting review.");
    }
  };

  wrapper.appendChild(el("div", { className: "review-form" }, [
    el("div", { className: "review-row" }, [payoutInput, reasonInput]),
    el("div", { className: "review-buttons" }, [
      el("button", { type: "button", className: "inline-action approve", onclick: () => submitReview("approve") }, ["Approve"]),
      el("button", { type: "button", className: "inline-action reject", onclick: () => submitReview("reject") }, ["Reject"]),
    ]),
    feedback,
  ]));

  return wrapper;
}

function buildFeedItem(report) {
  const sevColors = { critical: "#ff5252", high: "#ffab40", medium: "#ffd740", low: "#8888a0" };
  const qualityScore = report.quality_score ?? 0;
  const confidence = report.confidence ?? 0;
  const qualityColor = qualityScore >= 7 ? "#00e676" : qualityScore >= 4 ? "#ffab40" : "#ff5252";
  const qualityPct = (qualityScore / 10) * 100;
  const statusClass = (report.status || "").replace(/_/g, "-");

  const item = el("div", { className: `feed-item ${statusClass}`, id: `report-${report.id}` });

  item.appendChild(el("div", { className: "header" }, [
    el("span", { className: "title", textContent: report.title }),
    el("span", { className: `status ${statusClass}`, textContent: (report.status || "").replace(/_/g, " ") }),
  ]));

  const meta = el("div", { className: "meta" });
  meta.appendChild(el("span", { style: { color: sevColors[report.severity] || "#888" }, textContent: (report.severity || "").toUpperCase() }));
  meta.appendChild(text(` · ${report.id} · ${formatTime(report.created_at)}`));
  if (report.chain) meta.appendChild(el("span", { className: "tag", textContent: report.chain }));
  if (report.vuln_class) meta.appendChild(el("span", { className: "tag", textContent: report.vuln_class }));
  if (report.affected_asset) meta.appendChild(el("span", { className: "tag asset", textContent: report.affected_asset }));
  item.appendChild(meta);

  if (qualityScore > 0) {
    const fill = el("div", { className: "bar-fill", style: { width: `${qualityPct}%`, background: qualityColor } });
    const children = [
      el("span", { style: { fontSize: "11px", color: "var(--text-dim)" }, textContent: "Quality:" }),
      el("div", { className: "bar" }, [fill]),
      el("span", { className: "score", style: { color: qualityColor }, textContent: `${qualityScore}/10` }),
    ];
    if (confidence > 0) {
      children.push(el("span", {
        style: { fontSize: "11px", color: "var(--text-dim)", marginLeft: "8px" },
        textContent: `conf: ${Math.round(confidence * 100)}%`,
      }));
    }
    item.appendChild(el("div", { className: "quality-bar" }, children));
  }

  if (report.duplicate_of) {
    item.appendChild(el("div", {
      className: "duplicate-flag",
      textContent: `Possible duplicate of ${report.duplicate_of} (score: ${report.duplicate_score})`,
    }));
  }

  if (report.reasoning) {
    item.appendChild(el("div", { className: "reasoning", textContent: report.reasoning }));
  }

  if (["signed", "confirmed", "broadcasted"].includes(report.status)) {
    const ref = report.tx_hash || report.authorization_id || "pending";
    const refLabel = report.tx_hash ? "Tx" : "Auth";
    const refText = ref.length > 24 ? `${ref.slice(0, 24)}...` : ref;
    item.appendChild(el("div", { className: "payout-info" }, [
      el("span", { className: "payout-amount", textContent: `$${report.payout} USDC` }),
      el("span", { className: "tx-hash", textContent: `${refLabel}: ${refText}` }),
    ]));
  }

  if (report.status === "pending_review" || report.status === "probable_duplicate") {
    item.appendChild(buildReviewActions(report));
  }

  return item;
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll(".filter-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  loadReports(true);
}

document.getElementById("reportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage("formMessage");

  const button = document.getElementById("submitBtn");
  button.disabled = true;
  button.querySelector(".btn-text").style.display = "none";
  button.querySelector(".btn-loading").style.display = "inline";

  const data = {
    chain: document.getElementById("reportChain").value,
    title: document.getElementById("bugTitle").value,
    severity: document.querySelector('input[name="severity"]:checked').value,
    description: document.getElementById("bugDescription").value,
    reporterWallet: document.getElementById("reporterWallet").value,
  };
  const affectedAsset = document.getElementById("affectedAsset").value.trim();
  const vulnClass = document.getElementById("vulnClass").value.trim();
  if (affectedAsset) data.affectedAsset = affectedAsset;
  if (vulnClass) data.vulnClass = vulnClass;

  try {
    const res = await fetch(`${API}/api/report/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      showMessage("formMessage", json.error || "Submission failed.");
    } else {
      addFeedItem(json);
      refreshStats();
      refreshInsights();
      document.getElementById("reportForm").reset();
      document.querySelector('input[name="severity"][value="high"]').checked = true;
      document.getElementById("reportChain").value = "evm";
      setWalletPlaceholder();
    }
  } catch {
    showMessage("formMessage", "Network error. Try again.");
  }

  button.disabled = false;
  button.querySelector(".btn-text").style.display = "inline";
  button.querySelector(".btn-loading").style.display = "none";
});

const GOOD_REPORTS = [
  {
    title: "SQL Injection in /api/users search endpoint",
    severity: "critical",
    description: "Steps to reproduce:\n1. Navigate to /api/users?search=test\n2. Inject payload: /api/users?search=test' OR '1'='1' --\n3. The query returns all users in the database\n\nImpact: Full database read access. An attacker can extract all user credentials, PII, and payment information.\n\nProof of Concept:\ncurl \"https://app.example.com/api/users?search=test%27%20OR%20%271%27%3D%271%27%20--\"\n\nThe vulnerable code is at line 142 in src/controllers/users.js.\nRecommended fix: Use parameterized queries with prepared statements.",
    wallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38",
    chain: "evm",
    affectedAsset: "/api/users",
    vulnClass: "sqli",
  },
  {
    title: "Stored XSS via profile bio field",
    severity: "critical",
    description: "Steps to reproduce:\n1. Go to /settings/profile\n2. In the Bio field, enter: <img src=x onerror=alert(document.cookie)>\n3. Save profile and visit /user/attacker\n4. JavaScript executes in the victim's browser\n\nImpact: Session hijacking, credential theft, phishing via injected content. Any user viewing the attacker's profile has their session token stolen.\n\nProof of Concept: The payload above triggers an alert. A real attack would exfiltrate cookies to an external server.\n\nAffected endpoint: POST /api/profile/update\nRoot cause: Bio field is rendered without HTML sanitization.\n\nRecommended fix: Use DOMPurify or escape HTML entities before rendering user content.",
    wallet: "0xA1B2C3D4E5F60718293a4b5c6d7e8f9001234567",
    chain: "evm",
    affectedAsset: "/api/profile/update",
    vulnClass: "xss",
  },
  {
    title: "Authentication bypass in Solana payout review webhook",
    severity: "critical",
    description: "Steps to reproduce:\n1. Intercept the review webhook payload for the Solana payout worker\n2. Remove the reviewer signature and replay the request with a modified approval status\n3. The backend still accepts the approval and schedules the payout\n\nImpact: Full authentication bypass for the Solana approval path.\n\nProof of concept: replay the unsigned approval payload against the worker endpoint and observe that the approval is accepted.\n\nRecommended fix: Require signed reviewer attestations and verify them before queuing the payout.",
    wallet: "Gbh2SE8M2SoP4Ct3xLnZoUC8MWSvjmQ3WUK5pU5TNyJ2",
    chain: "solana",
    vulnClass: "auth_bypass",
  },
];

const MEDIUM_REPORTS = [
  {
    title: "Open redirect in /auth/callback allows phishing",
    severity: "medium",
    description: "Steps to reproduce:\n1. Visit: https://app.example.com/auth/callback?redirect=https://evil.com/fake-login\n2. After OAuth login, user is redirected to the attacker's site\n3. Attacker's page mimics the login page and steals credentials\n\nImpact: Phishing attacks using the trusted domain.\n\nAffected endpoint: GET /auth/callback\nThe redirect parameter is not validated against a whitelist.\n\nRecommended fix: Validate redirect URL against allowed origins, or only allow relative paths.",
    wallet: "0x3344556677889900AABBCCDDEEFF001122334455",
    chain: "evm",
    affectedAsset: "/auth/callback",
  },
  {
    title: "Rate limiting bypass via X-Forwarded-For header spoofing",
    severity: "medium",
    description: "Steps to reproduce:\n1. Send POST /api/login with invalid credentials (rate limited after 5 attempts)\n2. Add header: X-Forwarded-For: 1.2.3.4\n3. Rate limit resets, attacker can continue brute-forcing\n4. Cycle through random IPs to bypass entirely\n\nImpact: Credential brute-force attacks against any user account.\n\nAffected endpoint: POST /api/login\n\nRecommended fix: Trust X-Forwarded-For only from known proxy IPs.",
    wallet: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
    chain: "evm",
    affectedAsset: "/api/login",
  },
  {
    title: "CSRF on account email change endpoint",
    severity: "high",
    description: "Steps to reproduce:\n1. Victim is logged into app.example.com\n2. Victim visits attacker's page with a hidden form that POSTs to /api/account/email\n3. Victim's email is changed to attacker@evil.com\n4. Attacker triggers password reset and takes over the account\n\nImpact: Full account takeover via CSRF + password reset chain.\n\nAffected endpoint: POST /api/account/email\nNo CSRF token or re-authentication required.\n\nRecommended fix: Add CSRF tokens or require current password for email changes.",
    wallet: "0x1234ABCD5678EFAB1234ABCD5678EFAB1234ABCD",
    chain: "evm",
    affectedAsset: "/api/account/email",
    vulnClass: "csrf",
  },
  {
    title: "Sensitive data exposure in Solana transfer simulation errors",
    severity: "medium",
    description: "Steps to reproduce:\n1. Submit an invalid Solana transfer for simulation\n2. The API returns a verbose stack trace with internal account metadata and file paths\n3. The response includes enough context to map privileged infrastructure\n\nImpact: Information disclosure useful for targeted attacks.\n\nRecommended fix: Return generic simulation errors and log internal details server-side only.",
    wallet: "Ya5m99rd33JHvaRvSMQNVVMTi9WQ9ZSZu279FpPMZHj",
    chain: "solana",
    vulnClass: "info_disclosure",
  },
];

const BAD_REPORTS = [
  {
    title: "something might be broken",
    severity: "low",
    description: "I'm not sure but maybe the site is slow sometimes. Could be a bug?",
    wallet: "0xDEADBEEF000000000000000000000000DeAdBeEf",
    chain: "evm",
  },
  {
    title: "website looks weird",
    severity: "low",
    description: "the colors are off on mobile, not sure if this is a security thing",
    wallet: "0x0000000000000000000000000000000000000001",
    chain: "evm",
  },
  {
    title: "solana thing feels wrong",
    severity: "medium",
    description: "maybe the solana screen is off but i am not sure how to reproduce",
    wallet: "Fn86NxhQmftsomF3rUmo7DziSWtQF94W1riyD8SBAF4q",
    chain: "solana",
  },
];

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function fillForm(report) {
  document.getElementById("reportChain").value = report.chain || "evm";
  document.getElementById("bugTitle").value = report.title;
  document.querySelector(`input[name="severity"][value="${report.severity}"]`).checked = true;
  document.getElementById("bugDescription").value = report.description;
  document.getElementById("reporterWallet").value = report.wallet;
  document.getElementById("affectedAsset").value = report.affectedAsset || "";
  document.getElementById("vulnClass").value = report.vulnClass || "";
  setWalletPlaceholder();
}

function fillGoodReport() {
  fillForm(pick(GOOD_REPORTS));
}

function fillMediumReport() {
  fillForm(pick(MEDIUM_REPORTS));
}

function fillBadReport() {
  fillForm(pick(BAD_REPORTS));
}

function fillRandomReport() {
  fillForm(pick([...GOOD_REPORTS, ...MEDIUM_REPORTS, ...BAD_REPORTS]));
}

document.getElementById("demoGood").addEventListener("click", fillGoodReport);
document.getElementById("demoMedium").addEventListener("click", fillMediumReport);
document.getElementById("demoBad").addEventListener("click", fillBadReport);
document.getElementById("demoRandom").addEventListener("click", fillRandomReport);
document.getElementById("resetBtn").addEventListener("click", resetAll);
document.getElementById("refreshAuditBtn").addEventListener("click", loadAuditLog);
document.getElementById("reportChain").addEventListener("change", setWalletPlaceholder);
document.getElementById("adminToken").addEventListener("input", () => {
  hideMessage("adminMessage");
  loadReports(true);
});
document.getElementById("reviewerName").addEventListener("input", () => hideMessage("adminMessage"));
document.querySelectorAll(".filter-btn").forEach((button) => {
  if (button.dataset.filter) {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  }
});

init();
