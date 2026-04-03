import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import store, { resetDailyIfNeeded } from "./store.js";
import { evaluateReport } from "./evaluator.js";
import { setupTreasuryWallet, setupPolicy, setupAgentKey, signPayout, getWalletInfo } from "./ows-wallet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "../frontend")));

// SSE clients for real-time updates
const sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// SSE endpoint
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");
  sseClients.push(res);
  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// Initialize bounty program + OWS wallet
app.post("/api/bounty/create", (req, res) => {
  const { name, description, maxPerBug = 150, dailyLimit = 500 } = req.body;

  // Setup OWS wallet and policy
  const wallet = setupTreasuryWallet("bountybot-treasury");
  const policy = setupPolicy(maxPerBug, dailyLimit);

  let agentKey;
  try {
    agentKey = setupAgentKey(wallet.id, policy.id);
  } catch (err) {
    console.log(`[OWS] Agent key setup note: ${err.message}`);
    agentKey = { token: "demo-mode", id: "demo", name: "bountybot-agent" };
  }

  store.program = {
    name: name || "BountyBot Program",
    description: description || "Automated bug bounty with OWS-powered payouts",
    wallet: {
      name: wallet.name,
      id: wallet.id,
      accounts: wallet.accounts,
    },
    policy: {
      maxPerBug,
      dailyLimit,
    },
    agentKeyId: agentKey.id,
    totalPaid: 0,
    createdAt: new Date().toISOString(),
  };

  broadcast("program_created", store.program);
  res.json(store.program);
});

// Submit a bug report
app.post("/api/report/submit", async (req, res) => {
  const { title, severity, description, reporterWallet, chain = "evm" } = req.body;

  if (!title || !severity || !description || !reporterWallet) {
    return res.status(400).json({ error: "Missing required fields: title, severity, description, reporterWallet" });
  }

  if (!store.program) {
    return res.status(400).json({ error: "No bounty program initialized. POST /api/bounty/create first." });
  }

  resetDailyIfNeeded();

  const reportId = `RPT-${Date.now().toString(36).toUpperCase()}`;
  const report = {
    id: reportId,
    title,
    severity,
    description,
    reporterWallet,
    chain,
    status: "evaluating",
    payout: 0,
    reasoning: "",
    txHash: null,
    signature: null,
    createdAt: new Date().toISOString(),
  };

  store.reports.push(report);
  broadcast("report_submitted", report);

  // Processing delay for evaluation pipeline
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Automated evaluation
  const evaluation = evaluateReport({ title, severity, description });
  report.qualityScore = evaluation.qualityScore;
  report.signals = evaluation.signals;
  report.reasoning = evaluation.reasoning;

  if (evaluation.approved) {
    // Check policy limits
    if (evaluation.payout > store.program.policy.maxPerBug) {
      evaluation.payout = store.program.policy.maxPerBug;
      report.reasoning += ` (Capped at policy max: $${store.program.policy.maxPerBug})`;
    }
    if (store.dailySpent + evaluation.payout > store.program.policy.dailyLimit) {
      report.status = "rejected";
      report.reasoning = `POLICY DENIED: Daily spending limit of $${store.program.policy.dailyLimit} would be exceeded. Spent today: $${store.dailySpent}.`;
      broadcast("report_evaluated", report);
      return res.json(report);
    }

    // Sign payout with OWS
    try {
      const payoutResult = signPayout(
        "bountybot-treasury",
        chain,
        evaluation.payout,
        reporterWallet
      );

      report.status = "paid";
      report.payout = evaluation.payout;
      report.txHash = payoutResult.txHash;
      report.signature = payoutResult.signature;

      store.dailySpent += evaluation.payout;
      store.program.totalPaid += evaluation.payout;

      store.transactions.push({
        id: `TX-${Date.now().toString(36).toUpperCase()}`,
        reportId: report.id,
        amount: evaluation.payout,
        to: reporterWallet,
        txHash: payoutResult.txHash,
        chain,
        signature: payoutResult.signature,
        timestamp: new Date().toISOString(),
      });

      broadcast("payout_sent", {
        report,
        transaction: store.transactions[store.transactions.length - 1],
      });
    } catch (err) {
      report.status = "approved_unsigned";
      report.payout = evaluation.payout;
      report.reasoning += ` [Signing note: ${err.message}]`;
      broadcast("report_evaluated", report);
    }
  } else {
    report.status = "rejected";
    broadcast("report_evaluated", report);
  }

  res.json(report);
});

// List all reports
app.get("/api/reports", (req, res) => {
  res.json(store.reports.slice().reverse());
});

// Get program info
app.get("/api/bounty", (req, res) => {
  if (!store.program) return res.status(404).json({ error: "No program" });
  res.json({
    ...store.program,
    dailySpent: store.dailySpent,
    reportsCount: store.reports.length,
    paidCount: store.reports.filter(r => r.status === "paid").length,
    rejectedCount: store.reports.filter(r => r.status === "rejected").length,
  });
});

// Get wallet info
app.get("/api/wallet", (req, res) => {
  const wallet = getWalletInfo("bountybot-treasury");
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  res.json(wallet);
});

// Get transactions
app.get("/api/transactions", (req, res) => {
  res.json(store.transactions.slice().reverse());
});

// Get policy info
app.get("/api/policy", (req, res) => {
  if (!store.program) return res.status(404).json({ error: "No program" });
  res.json({
    ...store.program.policy,
    dailySpent: store.dailySpent,
    dailyRemaining: store.program.policy.dailyLimit - store.dailySpent,
  });
});

app.listen(PORT, () => {
  console.log(`\n🤖 BountyBot server running at http://localhost:${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}`);
  console.log(`\nQuick start:`);
  console.log(`  1. POST /api/bounty/create to initialize`);
  console.log(`  2. POST /api/report/submit to submit a bug\n`);
});
