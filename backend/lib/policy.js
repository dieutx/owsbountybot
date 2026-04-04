// Composable policy engine
// Each rule returns { allowed: bool, reason: string }
// All rules must pass for the action to proceed.

import { getDb } from "../db/database.js";
import { generateId } from "./ids.js";

const DEFAULT_POLICY = {
  maxPerBug: { critical: 150, high: 80, medium: 40, low: 15 },
  dailyLimit: 500,
  allowedChains: ["evm", "solana"],
  allowedTokens: ["USDC"],
  cooldownSeconds: 0,
  maxPerReporterPerDay: 3,
  reviewThresholds: {
    auto: 50,       // auto-approve below this
    manual: 150,    // manual review above auto threshold
    admin: Infinity, // admin review above manual threshold
  },
};

export function loadPolicy(programId) {
  const db = getDb();
  const row = db.prepare("SELECT config FROM policies WHERE program_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(programId);
  if (row) {
    return { ...DEFAULT_POLICY, ...JSON.parse(row.config) };
  }
  return DEFAULT_POLICY;
}

export function savePolicy(programId, config, name = "default") {
  const db = getDb();
  // Deactivate existing policies
  db.prepare("UPDATE policies SET active = 0 WHERE program_id = ?").run(programId);
  db.prepare("INSERT INTO policies (id, program_id, name, config, active, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(
    generateId("POL"),
    programId,
    name,
    JSON.stringify({ ...DEFAULT_POLICY, ...config }),
    new Date().toISOString(),
  );
}

export function evaluatePolicy(policy, { severity, payout, chain, reporterWallet, programId }) {
  const results = [];

  // Rule 1: Chain allowlist
  if (!policy.allowedChains.includes(chain)) {
    results.push({ allowed: false, rule: "chain_allowlist", reason: `Chain "${chain}" not in allowed list: ${policy.allowedChains.join(", ")}` });
  }

  // Rule 2: Max per severity
  const maxForSeverity = typeof policy.maxPerBug === "object" ? policy.maxPerBug[severity] : policy.maxPerBug;
  if (payout > maxForSeverity) {
    results.push({ allowed: false, rule: "max_per_severity", reason: `Payout $${payout} exceeds max $${maxForSeverity} for ${severity} severity` });
  }

  // Rule 3: Daily budget
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const budgetRow = db.prepare("SELECT spent FROM daily_budgets WHERE date = ? AND program_id = ?").get(today, programId);
  const dailySpent = budgetRow?.spent || 0;
  if (dailySpent + payout > policy.dailyLimit) {
    results.push({ allowed: false, rule: "daily_limit", reason: `Daily limit $${policy.dailyLimit} would be exceeded (spent: $${dailySpent})` });
  }

  // Rule 4: Max submissions per reporter per day
  if (policy.maxPerReporterPerDay > 0) {
    const reporterCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM reports WHERE reporter_wallet = ? AND program_id = ? AND date(created_at) = ? AND status NOT IN ('rejected', 'probable_duplicate')"
    ).get(reporterWallet, programId, today);
    if (reporterCount?.cnt >= policy.maxPerReporterPerDay) {
      results.push({ allowed: false, rule: "reporter_daily_limit", reason: `Reporter has reached ${policy.maxPerReporterPerDay} submissions today` });
    }
  }

  // Rule 5: Cooldown
  if (policy.cooldownSeconds > 0) {
    const lastPayout = db.prepare(
      "SELECT created_at FROM transactions WHERE program_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(programId);
    if (lastPayout) {
      const elapsed = (Date.now() - new Date(lastPayout.created_at).getTime()) / 1000;
      if (elapsed < policy.cooldownSeconds) {
        results.push({ allowed: false, rule: "cooldown", reason: `Cooldown: ${Math.ceil(policy.cooldownSeconds - elapsed)}s remaining` });
      }
    }
  }

  const denied = results.filter(r => !r.allowed);
  return {
    allowed: denied.length === 0,
    results,
    denied,
  };
}

// Determine review level based on payout amount
export function determineReviewLevel(policy, payoutAmount) {
  const thresholds = policy.reviewThresholds || DEFAULT_POLICY.reviewThresholds;
  if (payoutAmount <= thresholds.auto) return "auto";
  if (payoutAmount <= thresholds.manual) return "manual";
  return "admin";
}

// Record daily spend
export function recordDailySpend(programId, amount) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO daily_budgets (date, program_id, spent) VALUES (?, ?, ?)
    ON CONFLICT(date, program_id) DO UPDATE SET spent = spent + ?`).run(today, programId, amount, amount);
}

export function getDailySpent(programId) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT spent FROM daily_budgets WHERE date = ? AND program_id = ?").get(today, programId);
  return row?.spent || 0;
}
