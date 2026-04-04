import crypto from "crypto";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb, closeDb } from "./db/database.js";
import { generateId, correlationId } from "./lib/ids.js";
import { audit, getAuditLog } from "./lib/audit.js";
import { evaluateReport } from "./evaluator.js";
import { generateFingerprints, storeFingerprints, findDuplicates } from "./lib/fingerprint.js";
import { loadPolicy, evaluatePolicy, determineReviewLevel, recordDailySpend, getDailySpent } from "./lib/policy.js";
import { validate, CreateProgramSchema, SubmitReportSchema, ReviewReportSchema, ReportQuerySchema, AuditQuerySchema } from "./lib/schemas.js";
import {
  ALLOWED_SIGNING_CHAINS,
  normalizeChain,
  setupTreasuryWallet,
  setupPolicy as setupOWSPolicy,
  setupAgentKey,
  authorizePayout,
  getWalletInfo,
} from "./ows-wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT || 4000);
const EVALUATION_DELAY_MS = Number(process.env.BOUNTYBOT_EVALUATION_DELAY_MS || 1500);
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "https://owsbountybot.shelmail.xyz";
const MAX_SSE_CLIENTS = 200;

const WALLET_PATTERNS = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

// Rate limiting
const rateLimiter = new Map();
const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = rateLimiter.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    rateLimiter.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT.maxRequests) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimiter) {
    if (now - entry.start > RATE_LIMIT.windowMs) rateLimiter.delete(ip);
  }
}, 300_000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAdminToken() {
  return process.env.BOUNTYBOT_ADMIN_TOKEN?.trim() || "";
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function requireAdmin(req, res, next) {
  const adminToken = getAdminToken();
  if (!adminToken) {
    return res.status(403).json({ error: "System not configured for administrative actions (BOUNTYBOT_ADMIN_TOKEN missing)." });
  }
  if (!constantTimeEqual(req.get("x-admin-token"), adminToken)) {
    return res.status(403).json({ error: "Invalid or missing admin token." });
  }
  next();
}

// Sanitize DB rows for client responses
function sanitizeReport(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    severity: r.severity,
    status: r.status,
    chain: r.chain,
    quality_score: r.quality_score,
    confidence: r.confidence,
    payout: r.payout,
    reasoning: r.reasoning,
    signals: r.signals ? JSON.parse(r.signals) : [],
    vuln_class: r.vuln_class,
    affected_asset: r.affected_asset,
    review_level: r.review_level,
    duplicate_of: r.duplicate_of,
    duplicate_score: r.duplicate_score,
    authorization_id: r.authorization_id,
    tx_hash: r.tx_hash,
    created_at: r.created_at,
    evaluated_at: r.evaluated_at,
    signed_at: r.signed_at,
    description_preview: r.description?.slice(0, 120),
  };
}

function sanitizeTransaction(tx) {
  if (!tx) return null;
  return {
    id: tx.id,
    report_id: tx.report_id,
    amount: tx.amount,
    chain: tx.chain,
    token: tx.token,
    status: tx.status,
    authorization_id: tx.authorization_id,
    tx_hash: tx.tx_hash,
    created_at: tx.created_at,
    confirmed_at: tx.confirmed_at,
  };
}

// Get or create the active program
function getActiveProgram() {
  const db = getDb();
  return db.prepare("SELECT * FROM programs ORDER BY created_at DESC LIMIT 1").get();
}

function getProgramStats(programId) {
  const db = getDb();
  const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(programId);
  if (!program) return null;

  const counts = db.prepare(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN status IN ('signed','broadcasted','confirmed') THEN 1 ELSE 0 END) as signed_count,
    SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as paid_count,
    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
    SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) as pending_review_count
  FROM reports WHERE program_id = ?`).get(programId);

  const dailySpent = getDailySpent(programId);
  const policyConfig = program.policy_config ? JSON.parse(program.policy_config) : {};
  const evmAccount = program.wallet_accounts ? JSON.parse(program.wallet_accounts).find(a => a.chainId?.startsWith("eip155")) : null;

  return {
    id: program.id,
    name: program.name,
    description: program.description,
    wallet: {
      name: program.wallet_name,
      accounts: evmAccount ? [{ chainId: evmAccount.chainId, address: evmAccount.address }] : [],
    },
    policy: policyConfig,
    total_authorized: program.total_authorized,
    total_paid: program.total_paid,
    daily_spent: dailySpent,
    daily_remaining: Math.max(0, (policyConfig.dailyLimit || 500) - dailySpent),
    reports_count: counts?.total || 0,
    signed_count: counts?.signed_count || 0,
    paid_count: counts?.paid_count || 0,
    rejected_count: counts?.rejected_count || 0,
    pending_review_count: counts?.pending_review_count || 0,
    created_at: program.created_at,
  };
}

export function createApp() {
  getDb(); // initialize database

  const app = express();
  const sseClients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  }

  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
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

  // SSE
  app.get("/api/events", (req, res) => {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return res.status(503).json({ error: "Too many connections." });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  // === PROGRAM MANAGEMENT ===

  app.post("/api/bounty/create", (req, res) => {
    const cid = correlationId();
    const v = validate(CreateProgramSchema, req.body || {});
    if (!v.success) return res.status(400).json({ error: v.error });

    const { name, description, maxPerBug, dailyLimit } = v.data;
    const db = getDb();
    const existing = getActiveProgram();

    if (existing) {
      const adminToken = getAdminToken();
      if (!adminToken) {
        return res.status(409).json({ error: "Program exists. Set BOUNTYBOT_ADMIN_TOKEN to allow resets." });
      }
      if (!constantTimeEqual(req.get("x-admin-token"), adminToken)) {
        return res.status(403).json({ error: "Invalid admin token." });
      }
    }

    const wallet = setupTreasuryWallet("bountybot-treasury");
    const owsPolicy = setupOWSPolicy(maxPerBug, dailyLimit);
    let agentKey;
    try {
      agentKey = setupAgentKey(wallet.id, owsPolicy.id);
    } catch (err) {
      agentKey = { id: "demo", name: "demo" };
    }

    const programId = generateId("PRG");
    const policyConfig = { maxPerBug, dailyLimit, allowedChains: Object.keys(ALLOWED_SIGNING_CHAINS), allowedTokens: ["USDC"], reviewThresholds: v.data.reviewThresholds || { auto: 50, manual: 150, admin: Infinity } };

    db.prepare(`INSERT INTO programs (id, name, description, wallet_name, wallet_id, wallet_accounts, policy_id, policy_config, agent_key_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      programId,
      name || "BountyBot Program",
      description || "Automated bug bounty with OWS-powered payout approvals",
      wallet.name, wallet.id, JSON.stringify(wallet.accounts),
      owsPolicy.id, JSON.stringify(policyConfig), agentKey.id,
      new Date().toISOString(),
    );

    audit({ correlationId: cid, action: "program_created", entityType: "program", entityId: programId, ip: clientIp(req), details: { name, maxPerBug, dailyLimit } });

    const stats = getProgramStats(programId);
    broadcast("program_created", stats);
    res.json(stats);
  });

  app.get("/api/bounty", (req, res) => {
    const program = getActiveProgram();
    if (!program) return res.status(404).json({ error: "No program" });
    res.json(getProgramStats(program.id));
  });

  // === REPORT SUBMISSION ===

  app.post("/api/report/submit", rateLimit, async (req, res) => {
    const cid = correlationId();
    const v = validate(SubmitReportSchema, req.body || {});
    if (!v.success) return res.status(400).json({ error: v.error });

    const { title, severity, description, reporterWallet, chain } = v.data;
    const program = getActiveProgram();
    if (!program) return res.status(400).json({ error: "No bounty program initialized." });

    const normalizedChain = normalizeChain(chain);
    if (!normalizedChain) return res.status(400).json({ error: `Unsupported chain. Allowed: ${Object.keys(ALLOWED_SIGNING_CHAINS).join(", ")}` });

    const walletPattern = WALLET_PATTERNS[normalizedChain];
    if (walletPattern && !walletPattern.test(reporterWallet)) {
      return res.status(400).json({ error: `Invalid wallet address format for "${normalizedChain}".` });
    }

    const db = getDb();
    const reportId = generateId("RPT");
    const now = new Date().toISOString();

    // Insert report as pending
    db.prepare(`INSERT INTO reports (id, program_id, title, severity, description, reporter_wallet, chain, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'evaluating', ?)`).run(
      reportId, program.id, title, severity, description, reporterWallet, normalizedChain, now,
    );

    audit({ correlationId: cid, action: "report_submitted", entityType: "report", entityId: reportId, actor: reporterWallet, ip: clientIp(req) });

    const pendingReport = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
    broadcast("report_submitted", sanitizeReport(pendingReport));

    // Evaluation delay for demo effect
    await sleep(EVALUATION_DELAY_MS);

    // Step 1: Duplicate detection
    const fingerprints = generateFingerprints({ title, description });
    storeFingerprints(reportId, fingerprints);
    const dupResult = findDuplicates(fingerprints, reportId, title);

    if (dupResult.isDuplicate) {
      db.prepare("UPDATE reports SET status = 'rejected', reasoning = ?, duplicate_of = ?, duplicate_score = ?, evaluated_at = ? WHERE id = ?")
        .run(`DUPLICATE: Matches report ${dupResult.duplicateOf} (score: ${dupResult.score}).`, dupResult.duplicateOf, dupResult.score, now, reportId);
      audit({ correlationId: cid, action: "duplicate_rejected", entityType: "report", entityId: reportId, details: dupResult });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    if (dupResult.isProbable) {
      db.prepare("UPDATE reports SET status = 'probable_duplicate', reasoning = ?, duplicate_of = ?, duplicate_score = ?, evaluated_at = ? WHERE id = ?")
        .run(`PROBABLE DUPLICATE: Similar to ${dupResult.duplicateOf} (score: ${dupResult.score}). Flagged for review.`, dupResult.duplicateOf, dupResult.score, now, reportId);
      audit({ correlationId: cid, action: "probable_duplicate", entityType: "report", entityId: reportId, details: dupResult });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    // Step 2: Evaluate quality
    const evaluation = evaluateReport({ title, severity, description });

    db.prepare(`UPDATE reports SET quality_score = ?, confidence = ?, vuln_class = ?, affected_asset = ?,
      signals = ?, reasoning = ?, evaluated_at = ? WHERE id = ?`).run(
      evaluation.qualityScore, evaluation.confidence, evaluation.vulnClass, evaluation.affectedAsset,
      JSON.stringify(evaluation.signals), evaluation.reasoning, evaluation.evaluatedAt, reportId,
    );

    if (!evaluation.approved) {
      db.prepare("UPDATE reports SET status = 'rejected' WHERE id = ?").run(reportId);
      audit({ correlationId: cid, action: "report_rejected", entityType: "report", entityId: reportId, details: { qualityScore: evaluation.qualityScore } });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    // Step 3: Policy check
    const policy = loadPolicy(program.id);
    const policyResult = evaluatePolicy(policy, {
      severity, payout: evaluation.recommendedPayout, chain: normalizedChain,
      reporterWallet, programId: program.id,
    });

    if (!policyResult.allowed) {
      const denyReasons = policyResult.denied.map(d => d.reason).join("; ");
      db.prepare("UPDATE reports SET status = 'rejected', reasoning = ?, payout = 0 WHERE id = ?")
        .run(`POLICY DENIED: ${denyReasons}`, reportId);
      audit({ correlationId: cid, action: "policy_denied", entityType: "report", entityId: reportId, details: policyResult.denied });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    // Step 4: Determine review level
    const reviewLevel = determineReviewLevel(policy, evaluation.recommendedPayout);
    const needsReview = evaluation.needsManualReview || reviewLevel !== "auto";

    if (needsReview) {
      db.prepare("UPDATE reports SET status = 'pending_review', payout = ?, review_level = ? WHERE id = ?")
        .run(evaluation.recommendedPayout, reviewLevel, reportId);
      audit({ correlationId: cid, action: "pending_review", entityType: "report", entityId: reportId, details: { reviewLevel, payout: evaluation.recommendedPayout } });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    // Step 5: Auto-approve and sign
    db.prepare("UPDATE reports SET status = 'approved', payout = ?, review_level = 'auto' WHERE id = ?")
      .run(evaluation.recommendedPayout, reportId);

    try {
      const payoutResult = authorizePayout("bountybot-treasury", normalizedChain, evaluation.recommendedPayout, reporterWallet);
      const nonce = crypto.randomUUID();

      db.prepare(`UPDATE reports SET status = 'signed', signature = ?, authorization_id = ?,
        nonce = ?, expires_at = ?, signed_at = ? WHERE id = ?`).run(
        payoutResult.signature, payoutResult.authorizationId,
        nonce, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString(), reportId,
      );

      // Record transaction
      const txId = generateId("TX");
      db.prepare(`INSERT INTO transactions (id, report_id, program_id, amount, recipient, chain, token, status, authorization_id, signature, nonce, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USDC', 'signed', ?, ?, ?, ?)`).run(
        txId, reportId, program.id, evaluation.recommendedPayout, reporterWallet, normalizedChain,
        payoutResult.authorizationId, payoutResult.signature, nonce, new Date().toISOString(),
      );

      // Record spend
      recordDailySpend(program.id, evaluation.recommendedPayout);
      db.prepare("UPDATE programs SET total_authorized = total_authorized + ? WHERE id = ?").run(evaluation.recommendedPayout, program.id);

      audit({ correlationId: cid, action: "payout_signed", entityType: "report", entityId: reportId, details: { amount: evaluation.recommendedPayout, txId, authorizationId: payoutResult.authorizationId } });

      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("payout_authorized", { report: sanitizeReport(updated), transaction: sanitizeTransaction(db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId)) });
      return res.json(sanitizeReport(updated));
    } catch (err) {
      db.prepare("UPDATE reports SET status = 'approved', reasoning = reasoning || ' [Signing unavailable]' WHERE id = ?").run(reportId);
      console.error("[OWS] Signing error:", err.message);
      audit({ correlationId: cid, action: "signing_failed", entityType: "report", entityId: reportId, details: { error: err.message } });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }
  });

  // === MANUAL REVIEW ===

  app.post("/api/report/:id/review", requireAdmin, (req, res) => {
    const cid = correlationId();
    const v = validate(ReviewReportSchema, req.body || {});
    if (!v.success) return res.status(400).json({ error: v.error });

    const db = getDb();
    const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "pending_review" && report.status !== "probable_duplicate") {
      return res.status(409).json({ error: `Report is ${report.status}, not reviewable.` });
    }

    const { action, reviewedBy, reason, adjustedPayout } = v.data;
    const now = new Date().toISOString();

    if (action === "reject") {
      db.prepare("UPDATE reports SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reasoning = COALESCE(reasoning, '') || ? WHERE id = ?")
        .run(reviewedBy, now, ` Manual review: rejected. ${reason || ""}`, report.id);
      audit({ correlationId: cid, action: "manual_reject", entityType: "report", entityId: report.id, actor: reviewedBy });
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(report.id);
      broadcast("report_evaluated", sanitizeReport(updated));
      return res.json(sanitizeReport(updated));
    }

    // Approve: sign the payout
    const payout = adjustedPayout ?? report.payout;
    db.prepare("UPDATE reports SET status = 'approved', payout = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(payout, reviewedBy, now, report.id);

    try {
      const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(report.program_id);
      const payoutResult = authorizePayout("bountybot-treasury", report.chain, payout, report.reporter_wallet);
      const nonce = crypto.randomUUID();

      db.prepare(`UPDATE reports SET status = 'signed', signature = ?, authorization_id = ?, nonce = ?,
        expires_at = ?, signed_at = ? WHERE id = ?`).run(
        payoutResult.signature, payoutResult.authorizationId, nonce,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString(), report.id,
      );

      const txId = generateId("TX");
      db.prepare(`INSERT INTO transactions (id, report_id, program_id, amount, recipient, chain, token, status, authorization_id, signature, nonce, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USDC', 'signed', ?, ?, ?, ?)`).run(
        txId, report.id, program.id, payout, report.reporter_wallet, report.chain,
        payoutResult.authorizationId, payoutResult.signature, nonce, new Date().toISOString(),
      );

      recordDailySpend(program.id, payout);
      db.prepare("UPDATE programs SET total_authorized = total_authorized + ? WHERE id = ?").run(payout, program.id);
      audit({ correlationId: cid, action: "manual_approve_signed", entityType: "report", entityId: report.id, actor: reviewedBy, details: { payout, txId } });

      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(report.id);
      broadcast("payout_authorized", { report: sanitizeReport(updated) });
      return res.json(sanitizeReport(updated));
    } catch (err) {
      console.error("[OWS] Signing error:", err.message);
      const updated = db.prepare("SELECT * FROM reports WHERE id = ?").get(report.id);
      return res.json(sanitizeReport(updated));
    }
  });

  // === READ ENDPOINTS ===

  app.get("/api/reports", (req, res) => {
    const program = getActiveProgram();
    if (!program) return res.json([]);
    const v = validate(ReportQuerySchema, req.query);
    if (!v.success) return res.status(400).json({ error: v.error });
    const { status, duplicates, limit } = v.data;
    let rows;
    if (duplicates) {
      rows = getDb().prepare("SELECT * FROM reports WHERE program_id = ? AND duplicate_of IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(program.id, limit);
    } else if (status) {
      rows = getDb().prepare("SELECT * FROM reports WHERE program_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(program.id, status, limit);
    } else {
      rows = getDb().prepare("SELECT * FROM reports WHERE program_id = ? ORDER BY created_at DESC LIMIT ?").all(program.id, limit);
    }
    res.json(rows.map(sanitizeReport));
  });

  app.get("/api/report/:id", (req, res) => {
    const report = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(req.params.id);
    if (!report) return res.status(404).json({ error: "Not found" });
    const auditEntries = getDb().prepare("SELECT action, details, created_at FROM audit_log WHERE entity_type = 'report' AND entity_id = ? ORDER BY id").all(req.params.id);
    res.json({ ...sanitizeReport(report), audit: auditEntries.map(a => ({ action: a.action, details: a.details ? JSON.parse(a.details) : null, at: a.created_at })) });
  });

  app.get("/api/wallet", (req, res) => {
    const wallet = getWalletInfo("bountybot-treasury");
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });
    const evmAccount = wallet.accounts.find(a => a.chainId?.startsWith("eip155"));
    res.json({ name: wallet.name, accounts: evmAccount ? [{ chainId: evmAccount.chainId, address: evmAccount.address }] : [] });
  });

  app.get("/api/transactions", (req, res) => {
    const program = getActiveProgram();
    if (!program) return res.json([]);
    const rows = getDb().prepare("SELECT * FROM transactions WHERE program_id = ? ORDER BY created_at DESC LIMIT 50").all(program.id);
    res.json(rows.map(sanitizeTransaction));
  });

  app.get("/api/policy", (req, res) => {
    const program = getActiveProgram();
    if (!program) return res.status(404).json({ error: "No program" });
    const config = program.policy_config ? JSON.parse(program.policy_config) : {};
    const spent = getDailySpent(program.id);
    res.json({ ...config, dailySpent: spent, dailyRemaining: Math.max(0, (config.dailyLimit || 500) - spent) });
  });

  app.get("/api/audit", (req, res) => {
    const v = validate(AuditQuerySchema, req.query);
    if (!v.success) return res.status(400).json({ error: v.error });
    const { entity_type, entity_id, correlation_id, limit } = v.data;
    const rows = getAuditLog({ entityType: entity_type, entityId: entity_id, correlationId: correlation_id, limit });
    res.json(rows);
  });

  // Reset: wipe all reports/transactions for the active program (demo convenience)
  app.post("/api/reset", requireAdmin, (req, res) => {
    const cid = correlationId();
    const program = getActiveProgram();
    if (!program) return res.status(404).json({ error: "No program to reset." });

    const db = getDb();
    db.prepare("DELETE FROM fingerprints WHERE report_id IN (SELECT id FROM reports WHERE program_id = ?)").run(program.id);
    db.prepare("DELETE FROM transactions WHERE program_id = ?").run(program.id);
    db.prepare("DELETE FROM reports WHERE program_id = ?").run(program.id);
    db.prepare("DELETE FROM daily_budgets WHERE program_id = ?").run(program.id);
    db.prepare("UPDATE programs SET total_authorized = 0, total_paid = 0 WHERE id = ?").run(program.id);

    audit({ correlationId: cid, action: "program_reset", entityType: "program", entityId: program.id, ip: clientIp(req) });
    broadcast("program_reset", {});
    res.json({ ok: true, message: "All reports, transactions, and budgets cleared." });
  });

  return app;
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`\n🤖 BountyBot server running at http://localhost:${port}`);
    console.log(`📋 Dashboard: http://localhost:${port}\n`);
  });
  process.on("SIGTERM", () => { closeDb(); server.close(); });
  process.on("SIGINT", () => { closeDb(); server.close(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
