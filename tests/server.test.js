import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function createSandboxPaths() {
  const root = mkdtempSync(join(tmpdir(), "owsbountybot-"));
  return {
    root,
    statePath: join(root, "state.json"),
    vaultPath: join(root, "vault"),
  };
}

async function loadServer(paths) {
  process.env.BOUNTYBOT_STATE_PATH = paths.statePath;
  process.env.OWS_VAULT_PATH = paths.vaultPath;
  process.env.BOUNTYBOT_EVALUATION_DELAY_MS = "0";

  const cacheBust = `${Date.now()}-${Math.random()}`;
  const { createApp } = await import(`../backend/server.js?test=${cacheBust}`);
  const app = createApp();
  const server = app.listen(0);
  await new Promise(resolve => {
    server.once("listening", resolve);
  });

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close(err => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestJson(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();

  return {
    response,
    json: text ? JSON.parse(text) : null,
  };
}

async function createProgram(baseUrl, overrides = {}) {
  return requestJson(baseUrl, "/api/bounty/create", {
    method: "POST",
    body: JSON.stringify({
      name: "BountyBot Test Program",
      description: "Regression test program",
      maxPerBug: 150,
      dailyLimit: 500,
      ...overrides,
    }),
  });
}

async function submitHighQualityReport(baseUrl, overrides = {}) {
  return requestJson(baseUrl, "/api/report/submit", {
    method: "POST",
    body: JSON.stringify({
      title: "SQL Injection in /api/users search endpoint",
      severity: "critical",
      description: `Steps to reproduce:
1. Navigate to /api/users?search=test
2. Inject payload: /api/users?search=test' OR '1'='1' --
3. The query returns all users in the database

Impact: Full database read access. An attacker can extract all user credentials, PII, and payment information.

Proof of Concept:
curl "https://app.example.com/api/users?search=test%27%20OR%20%271%27%3D%271%27%20--"

Recommended fix: Use parameterized queries with prepared statements.`,
      reporterWallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38",
      ...overrides,
    }),
  });
}

function cleanupSandbox(root) {
  delete process.env.BOUNTYBOT_STATE_PATH;
  delete process.env.OWS_VAULT_PATH;
  delete process.env.BOUNTYBOT_EVALUATION_DELAY_MS;
  rmSync(root, { recursive: true, force: true });
}

test("signed approvals are no longer reported as paid transfers", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    const program = await createProgram(baseUrl);
    assert.equal(program.response.status, 200);

    const { response, json: report } = await submitHighQualityReport(baseUrl);
    assert.equal(response.status, 200);
    assert.equal(report.status, "signed");
    assert.equal(report.txHash, null);
    assert.ok(report.signature);
    assert.ok(report.authorizationId);

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.json.totalAuthorized, report.payout);
    assert.equal(bounty.json.totalPaid, 0);
    assert.equal(bounty.json.signedCount, 1);
    assert.equal(bounty.json.paidCount, 0);

    const transactions = await requestJson(baseUrl, "/api/transactions");
    assert.equal(transactions.json.length, 1);
    assert.equal(transactions.json[0].status, "signed");
    assert.equal(transactions.json[0].txHash, null);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("creating a new program resets reports, transactions, and budget counters", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);
    await submitHighQualityReport(baseUrl);

    const recreated = await createProgram(baseUrl, {
      name: "Fresh Program",
      description: "Reset state",
      maxPerBug: 75,
      dailyLimit: 120,
    });

    assert.equal(recreated.json.name, "Fresh Program");

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.json.reportsCount, 0);
    assert.equal(bounty.json.totalAuthorized, 0);
    assert.equal(bounty.json.totalPaid, 0);
    assert.equal(bounty.json.dailySpent, 0);

    const reports = await requestJson(baseUrl, "/api/reports");
    const transactions = await requestJson(baseUrl, "/api/transactions");
    assert.deepEqual(reports.json, []);
    assert.deepEqual(transactions.json, []);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("persisted state survives restart and duplicate detection still works", async () => {
  const paths = createSandboxPaths();
  const firstRun = await loadServer(paths);

  try {
    await createProgram(firstRun.baseUrl);
    const initial = await submitHighQualityReport(firstRun.baseUrl);
    assert.equal(initial.json.status, "signed");
  } finally {
    await closeServer(firstRun.server);
  }

  const secondRun = await loadServer(paths);

  try {
    const reportsBefore = await requestJson(secondRun.baseUrl, "/api/reports");
    assert.equal(reportsBefore.json.length, 1);

    const duplicate = await submitHighQualityReport(secondRun.baseUrl);
    assert.equal(duplicate.json.status, "rejected");
    assert.match(duplicate.json.reasoning, /DUPLICATE:/);

    const reportsAfter = await requestJson(secondRun.baseUrl, "/api/reports");
    assert.equal(reportsAfter.json.length, 2);
  } finally {
    await closeServer(secondRun.server);
    cleanupSandbox(paths.root);
  }
});
