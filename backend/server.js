import crypto from "crypto";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import store, {
  hasSeenReportHash,
  initializeProgram,
  rememberReportHash,
  resetDailyIfNeeded,
  saveStore,
  syncStore,
} from "./store.js";
import { evaluateReport } from "./evaluator.js";
import {
  ALLOWED_SIGNING_CHAINS,
  normalizeChain,
  setupTreasuryWallet,
  setupPolicy,
  setupAgentKey,
  authorizePayout,
  getWalletInfo,
} from "./ows-wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT || 4000);
const EVALUATION_DELAY_MS = Number(process.env.BOUNTYBOT_EVALUATION_DELAY_MS || 1500);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "https://owsbountybot.shelmail.xyz";
const MAX_SSE_CLIENTS = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_WALLET_LENGTH = 100;

// Rate limiting per IP
const submitLimiter = new Map();
const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

// Budget mutex — prevents concurrent requests from bypassing daily limit
let budgetLock = Promise.resolve();

// EVM: 0x + 40 hex chars. Solana: base58, 32-44 chars.
const WALLET_PATTERNS = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

function buildId(prefix) {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAdminToken() {
  return process.env.BOUNTYBOT_ADMIN_TOKEN?.trim() || "";
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parsePositiveLimit(value, fieldName, fallback) {
  const rawValue = value ?? fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0.01) {
    throw new Error(`${fieldName} must be a positive number (minimum 0.01)`);
  }
  return Math.round(parsed * 100) / 100;
}

function getJsonObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return null;
  }
  return req.body;
}

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = submitLimiter.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    submitLimiter.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT.maxRequests) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  next();
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of submitLimiter) {
    if (now - entry.start > RATE_LIMIT.windowMs) submitLimiter.delete(ip);
  }
}, 300_000).unref();

// Strip sensitive fields from objects before sending to clients
function sanitizeReport(report) {
  const { signature, description, reporterWallet, ...safe } = report;
  return { ...safe, descriptionPreview: description?.slice(0, 100) };
}

function sanitizeTransaction(tx) {
  const { signature, to, ...safe } = tx;
  return safe;
}

function sanitizeProgram(program) {
  if (!program) return null;
  const { agentKeyId, wallet, ...safe } = program;
  const evmAccount = wallet?.accounts?.find(a => a.chainId?.startsWith("eip155"));
  return {
    ...safe,
    wallet: {
      name: wallet?.name,
      accounts: evmAccount ? [{ chainId: evmAccount.chainId, address: evmAccount.address }] : [],
    },
  };
}

function getProgramStats() {
  resetDailyIfNeeded();
  return sanitizeProgram({
    ...store.program,
    totalAuthorized: store.program?.totalAuthorized || 0,
    totalPaid: store.program?.totalPaid || 0,
    dailySpent: store.dailySpent,
    reportsCount: store.reports.length,
    signedCount: store.reports.filter(r => r.status === "signed" || r.status === "paid").length,
    paidCount: store.reports.filter(r => r.status === "paid").length,
    rejectedCount: store.reports.filter(r => r.status === "rejected").length,
  });
}

export function createApp() {
  syncStore();

  const app = express();
  const sseClients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(msg);
    }
  }

  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;");
    next();
  });

  app.use(cors({ origin: ALLOWED_ORIGIN }));
  app.use(express.json({ limit: "16kb" }));
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Malformed JSON body." });
    }
    return next(err);
  });
  app.use(express.static(join(__dirname, "../frontend")));

  // SSE endpoint with connection cap
  app.get("/api/events", (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return res.status(503).json({ error: "Too many connections. Try again later." });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  app.post("/api/bounty/create", (req, res) => {
    const body = getJsonObjectBody(req);
    if (!body) {
      return res.status(400).json({ error: "Request body must be a JSON object." });
    }

    const { name, description, maxPerBug, dailyLimit } = body;

    let parsedMaxPerBug;
    let parsedDailyLimit;
    try {
      parsedMaxPerBug = parsePositiveLimit(maxPerBug, "maxPerBug", 150);
      parsedDailyLimit = parsePositiveLimit(dailyLimit, "dailyLimit", 500);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (parsedDailyLimit < parsedMaxPerBug) {
      return res.status(400).json({ error: "dailyLimit must be greater than or equal to maxPerBug" });
    }

    if (store.program) {
      const adminToken = getAdminToken();
      if (!adminToken) {
        return res.status(409).json({
          error: "A bounty program already exists. Configure BOUNTYBOT_ADMIN_TOKEN to allow authenticated resets.",
        });
      }
      if (!constantTimeEqual(req.get("x-admin-token"), adminToken)) {
        return res.status(403).json({ error: "Program reset requires a valid x-admin-token header." });
      }
    }

    const wallet = setupTreasuryWallet("bountybot-treasury");
    const policy = setupPolicy(parsedMaxPerBug, parsedDailyLimit);

    let agentKey;
    try {
      agentKey = setupAgentKey(wallet.id, policy.id);
    } catch (err) {
      console.log(`[OWS] Agent key setup note: ${err.message}`);
      agentKey = { token: "demo-mode", id: "demo", name: "bountybot-agent" };
    }

    initializeProgram({
      name: name || "BountyBot Program",
      description: description || "Automated bug bounty with OWS-powered payout approvals",
      wallet: {
        name: wallet.name,
        id: wallet.id,
        accounts: wallet.accounts,
      },
      policy: {
        id: policy.id,
        maxPerBug: parsedMaxPerBug,
        dailyLimit: parsedDailyLimit,
        allowedChains: Object.keys(ALLOWED_SIGNING_CHAINS),
        allowedChainIds: Object.values(ALLOWED_SIGNING_CHAINS),
      },
      agentKeyId: agentKey.id,
      totalAuthorized: 0,
      totalPaid: 0,
      createdAt: new Date().toISOString(),
    });

    broadcast("program_created", sanitizeProgram(store.program));
    res.json(sanitizeProgram(store.program));
  });

  app.post("/api/report/submit", rateLimit, async (req, res) => {
    const body = getJsonObjectBody(req);
    if (!body) {
      return res.status(400).json({ error: "Request body must be a JSON object." });
    }

    const { title, severity, description, reporterWallet, chain = "evm" } = body;

    if (!title || !severity || !description || !reporterWallet) {
      return res.status(400).json({ error: "Missing required fields: title, severity, description, reporterWallet" });
    }

    // Input length validation
    if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ error: `Title must be a string of at most ${MAX_TITLE_LENGTH} characters.` });
    }
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({ error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` });
    }
    if (typeof reporterWallet !== "string" || reporterWallet.length > MAX_WALLET_LENGTH) {
      return res.status(400).json({ error: `Wallet address must be at most ${MAX_WALLET_LENGTH} characters.` });
    }

    if (!VALID_SEVERITIES.has(severity)) {
      return res.status(400).json({ error: "Severity must be one of: critical, high, medium, low" });
    }

    if (!store.program) {
      return res.status(400).json({ error: "No bounty program initialized. POST /api/bounty/create first." });
    }

    const normalizedChain = normalizeChain(chain);
    if (!normalizedChain) {
      return res.status(400).json({
        error: `Unsupported payout chain. Allowed chains: ${Object.keys(ALLOWED_SIGNING_CHAINS).join(", ")}`,
      });
    }

    // Validate wallet address format for the target chain
    const walletPattern = WALLET_PATTERNS[normalizedChain];
    if (walletPattern && !walletPattern.test(reporterWallet)) {
      return res.status(400).json({
        error: `Invalid wallet address format for chain "${normalizedChain}".`,
      });
    }

    resetDailyIfNeeded();

    const report = {
      id: buildId("RPT"),
      title,
      severity,
      description,
      reporterWallet,
      chain: normalizedChain,
      status: "evaluating",
      payout: 0,
      reasoning: "",
      txHash: null,
      signature: null,
      authorizationId: null,
      createdAt: new Date().toISOString(),
    };

    store.reports.push(report);
    saveStore();
    broadcast("report_submitted", sanitizeReport(report));

    await sleep(EVALUATION_DELAY_MS);

    const evaluation = evaluateReport(
      { title, severity, description },
      { hasSeenHash: hasSeenReportHash, rememberHash: rememberReportHash },
    );

    report.qualityScore = evaluation.qualityScore;
    report.signals = evaluation.signals;
    report.reasoning = evaluation.reasoning;

    if (!evaluation.approved) {
      report.status = "rejected";
      saveStore();
      broadcast("report_evaluated", sanitizeReport(report));
      return res.json(sanitizeReport(report));
    }

    if (evaluation.payout > store.program.policy.maxPerBug) {
      evaluation.payout = store.program.policy.maxPerBug;
      report.reasoning += ` (Capped at policy max: $${store.program.policy.maxPerBug})`;
    }

    // Budget check + increment inside a serialized lock to prevent race condition (C-2)
    const budgetResult = await (budgetLock = budgetLock.then(() => {
      resetDailyIfNeeded();
      if (store.dailySpent + evaluation.payout > store.program.policy.dailyLimit) {
        return { denied: true };
      }
      store.dailySpent += evaluation.payout;
      store.program.totalAuthorized += evaluation.payout;
      return { denied: false };
    }));

    if (budgetResult.denied) {
      report.status = "rejected";
      report.reasoning = `POLICY DENIED: Daily spending limit of $${store.program.policy.dailyLimit} would be exceeded. Spent today: $${store.dailySpent}.`;
      saveStore();
      broadcast("report_evaluated", sanitizeReport(report));
      return res.json(sanitizeReport(report));
    }

    try {
      const payoutResult = authorizePayout(
        "bountybot-treasury",
        normalizedChain,
        evaluation.payout,
        reporterWallet,
      );

      report.status = payoutResult.status;
      report.payout = evaluation.payout;
      report.txHash = payoutResult.txHash;
      report.signature = payoutResult.signature;
      report.authorizationId = payoutResult.authorizationId;

      if (payoutResult.status === "paid") {
        store.program.totalPaid += evaluation.payout;
      }

      const transaction = {
        id: buildId("TX"),
        reportId: report.id,
        amount: evaluation.payout,
        to: reporterWallet,
        status: payoutResult.status,
        txHash: payoutResult.txHash,
        signature: payoutResult.signature,
        authorizationId: payoutResult.authorizationId,
        chain: normalizedChain,
        timestamp: new Date().toISOString(),
      };

      store.transactions.push(transaction);
      saveStore();

      broadcast("payout_authorized", { report: sanitizeReport(report), transaction: sanitizeTransaction(transaction) });
      return res.json(sanitizeReport(report));
    } catch (err) {
      report.status = "approved_unsigned";
      report.payout = evaluation.payout;
      report.reasoning += " [Signing unavailable]";
      console.error("[OWS] Signing error:", err.message);
      saveStore();
      broadcast("report_evaluated", sanitizeReport(report));
      return res.json(sanitizeReport(report));
    }
  });

  app.get("/api/reports", (req, res) => {
    res.json(store.reports.slice().reverse().map(sanitizeReport));
  });

  app.get("/api/bounty", (req, res) => {
    if (!store.program) {
      return res.status(404).json({ error: "No program" });
    }
    res.json(getProgramStats());
  });

  // Only expose EVM address, no derivation paths
  app.get("/api/wallet", (req, res) => {
    const wallet = getWalletInfo("bountybot-treasury");
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const evmAccount = wallet.accounts.find(a => a.chainId?.startsWith("eip155"));
    res.json({
      name: wallet.name,
      accounts: evmAccount ? [{ chainId: evmAccount.chainId, address: evmAccount.address }] : [],
    });
  });

  app.get("/api/transactions", (req, res) => {
    res.json(store.transactions.slice().reverse().map(sanitizeTransaction));
  });

  app.get("/api/policy", (req, res) => {
    if (!store.program) {
      return res.status(404).json({ error: "No program" });
    }
    resetDailyIfNeeded();
    res.json({
      ...store.program.policy,
      dailySpent: store.dailySpent,
      dailyRemaining: Math.max(0, store.program.policy.dailyLimit - store.dailySpent),
    });
  });

  return app;
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp();

  return app.listen(port, () => {
    console.log(`\n🤖 BountyBot server running at http://localhost:${port}`);
    console.log(`📋 Dashboard: http://localhost:${port}`);
    console.log(`\nQuick start:`);
    console.log(`  1. POST /api/bounty/create to initialize`);
    console.log(`  2. POST /api/report/submit to submit a bug\n`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
