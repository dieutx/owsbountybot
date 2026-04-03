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

function buildId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeRequiredString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidRecipient(chain, address) {
  if (chain === "evm") {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  if (chain === "solana") {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  return false;
}

function getProgramStats() {
  return {
    ...store.program,
    totalAuthorized: store.program?.totalAuthorized || 0,
    totalPaid: store.program?.totalPaid || 0,
    dailySpent: store.dailySpent,
    reportsCount: store.reports.length,
    signedCount: store.reports.filter(r => r.status === "signed" || r.status === "paid").length,
    paidCount: store.reports.filter(r => r.status === "paid").length,
    rejectedCount: store.reports.filter(r => r.status === "rejected").length,
  };
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

  app.use(cors());
  app.use(express.json());
  app.use(express.static(join(__dirname, "../frontend")));

  app.get("/api/events", (req, res) => {
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
    const { name, description, maxPerBug = 150, dailyLimit = 500 } = req.body;

    const wallet = setupTreasuryWallet("bountybot-treasury");
    const policy = setupPolicy(maxPerBug, dailyLimit);

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
        maxPerBug,
        dailyLimit,
        allowedChains: Object.keys(ALLOWED_SIGNING_CHAINS),
        allowedChainIds: Object.values(ALLOWED_SIGNING_CHAINS),
      },
      agentKeyId: agentKey.id,
      totalAuthorized: 0,
      totalPaid: 0,
      createdAt: new Date().toISOString(),
    });

    broadcast("program_created", store.program);
    res.json(store.program);
  });

  app.post("/api/report/submit", async (req, res) => {
    const { title, severity, description, reporterWallet, chain = "evm" } = req.body;
    const normalizedTitle = normalizeRequiredString(title);
    const normalizedDescription = normalizeRequiredString(description);
    const normalizedReporterWallet = normalizeRequiredString(reporterWallet);

    if (!normalizedTitle || !severity || !normalizedDescription || !normalizedReporterWallet) {
      return res.status(400).json({ error: "Missing required fields: title, severity, description, reporterWallet" });
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

    if (!isValidRecipient(normalizedChain, normalizedReporterWallet)) {
      return res.status(400).json({
        error: `reporterWallet must be a valid ${normalizedChain} address`,
      });
    }

    resetDailyIfNeeded();

    const report = {
      id: buildId("RPT"),
      title: normalizedTitle,
      severity,
      description: normalizedDescription,
      reporterWallet: normalizedReporterWallet,
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
    broadcast("report_submitted", report);

    await sleep(EVALUATION_DELAY_MS);

    const evaluation = evaluateReport(
      { title: normalizedTitle, severity, description: normalizedDescription },
      { hasSeenHash: hasSeenReportHash, rememberHash: rememberReportHash },
    );

    report.qualityScore = evaluation.qualityScore;
    report.signals = evaluation.signals;
    report.reasoning = evaluation.reasoning;

    if (!evaluation.approved) {
      report.status = "rejected";
      saveStore();
      broadcast("report_evaluated", report);
      return res.json(report);
    }

    if (evaluation.payout > store.program.policy.maxPerBug) {
      evaluation.payout = store.program.policy.maxPerBug;
      report.reasoning += ` (Capped at policy max: $${store.program.policy.maxPerBug})`;
    }

    if (store.dailySpent + evaluation.payout > store.program.policy.dailyLimit) {
      report.status = "rejected";
      report.reasoning = `POLICY DENIED: Daily spending limit of $${store.program.policy.dailyLimit} would be exceeded. Spent today: $${store.dailySpent}.`;
      saveStore();
      broadcast("report_evaluated", report);
      return res.json(report);
    }

    try {
      const payoutResult = authorizePayout(
        "bountybot-treasury",
        normalizedChain,
        evaluation.payout,
        normalizedReporterWallet,
      );

      report.status = payoutResult.status;
      report.payout = evaluation.payout;
      report.txHash = payoutResult.txHash;
      report.signature = payoutResult.signature;
      report.authorizationId = payoutResult.authorizationId;

      store.dailySpent += evaluation.payout;
      store.program.totalAuthorized += evaluation.payout;
      if (payoutResult.status === "paid") {
        store.program.totalPaid += evaluation.payout;
      }

      const transaction = {
        id: buildId("TX"),
        reportId: report.id,
        amount: evaluation.payout,
        to: normalizedReporterWallet,
        status: payoutResult.status,
        txHash: payoutResult.txHash,
        signature: payoutResult.signature,
        authorizationId: payoutResult.authorizationId,
        chain: normalizedChain,
        timestamp: new Date().toISOString(),
      };

      store.transactions.push(transaction);
      saveStore();

      broadcast("payout_authorized", { report, transaction });
      return res.json(report);
    } catch (err) {
      report.status = "approved_unsigned";
      report.payout = evaluation.payout;
      report.reasoning += ` [Signing note: ${err.message}]`;
      saveStore();
      broadcast("report_evaluated", report);
      return res.json(report);
    }
  });

  app.get("/api/reports", (req, res) => {
    res.json(store.reports.slice().reverse());
  });

  app.get("/api/bounty", (req, res) => {
    if (!store.program) {
      return res.status(404).json({ error: "No program" });
    }

    res.json(getProgramStats());
  });

  app.get("/api/wallet", (req, res) => {
    const wallet = getWalletInfo("bountybot-treasury");
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    res.json(wallet);
  });

  app.get("/api/transactions", (req, res) => {
    res.json(store.transactions.slice().reverse());
  });

  app.get("/api/policy", (req, res) => {
    if (!store.program) {
      return res.status(404).json({ error: "No program" });
    }

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
