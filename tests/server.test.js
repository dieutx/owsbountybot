import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listApiKeys } from "@open-wallet-standard/core";

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
  process.env.CORS_ORIGIN = "*";

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

async function createProgram(baseUrl, overrides = {}, requestOptions = {}) {
  return requestJson(baseUrl, "/api/bounty/create", {
    method: "POST",
    headers: requestOptions.headers,
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
  delete process.env.CORS_ORIGIN;
  rmSync(root, { recursive: true, force: true });
}

test("signed approvals strip signatures from response and are not reported as paid", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    const program = await createProgram(baseUrl);
    assert.equal(program.response.status, 200);

    const { response, json: report } = await submitHighQualityReport(baseUrl);
    assert.equal(response.status, 200);
    assert.equal(report.status, "signed");
    assert.equal(report.txHash, null);
    // Signatures should be stripped from client responses (C-1)
    assert.equal(report.signature, undefined);
    assert.ok(report.authorizationId);
    // Reporter wallet should be stripped from response
    assert.equal(report.reporterWallet, undefined);

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.json.totalAuthorized, report.payout);
    assert.equal(bounty.json.totalPaid, 0);
    assert.equal(bounty.json.signedCount, 1);
    assert.equal(bounty.json.paidCount, 0);
    // agentKeyId should be stripped (L-1)
    assert.equal(bounty.json.agentKeyId, undefined);

    const transactions = await requestJson(baseUrl, "/api/transactions");
    assert.equal(transactions.json.length, 1);
    assert.equal(transactions.json[0].status, "signed");
    assert.equal(transactions.json[0].txHash, null);
    // Signatures stripped from transactions too
    assert.equal(transactions.json[0].signature, undefined);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("creating a new program resets reports, transactions, and budget counters", async () => {
  const paths = createSandboxPaths();
  process.env.BOUNTYBOT_ADMIN_TOKEN = "reset-token";
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);
    await submitHighQualityReport(baseUrl);

    const recreated = await createProgram(baseUrl, {
      name: "Fresh Program",
      description: "Reset state",
      maxPerBug: 75,
      dailyLimit: 120,
    }, {
      headers: { "x-admin-token": "reset-token" },
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
    delete process.env.BOUNTYBOT_ADMIN_TOKEN;
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

  // Wait for async writes to flush
  await new Promise(resolve => setTimeout(resolve, 200));

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

test("daily budget endpoints self-heal after a date rollover", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);
    const initial = await submitHighQualityReport(baseUrl);
    assert.equal(initial.json.status, "signed");
    assert.ok(initial.json.payout > 0);

    // Wait for async save to flush
    await new Promise(resolve => setTimeout(resolve, 200));

    const { default: store, saveStoreSync } = await import("../backend/store.js");
    store.lastResetDate = "Thu Jan 01 1970";
    saveStoreSync();

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.response.status, 200);
    assert.equal(bounty.json.dailySpent, 0);

    const policy = await requestJson(baseUrl, "/api/policy");
    assert.equal(policy.response.status, 200);
    assert.equal(policy.json.dailySpent, 0);
    assert.equal(policy.json.dailyRemaining, 500);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("unsupported payout chains are rejected before signing", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);

    const { response, json } = await submitHighQualityReport(baseUrl, {
      chain: "bitcoin",
    });

    assert.equal(response.status, 400);
    assert.match(json.error, /Allowed chains: evm, solana/);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("invalid policy limits are rejected before a program is created", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    const invalid = await createProgram(baseUrl, {
      maxPerBug: -25,
      dailyLimit: "not-a-number",
    });

    assert.equal(invalid.response.status, 400);
    assert.match(invalid.json.error, /maxPerBug must be a positive number/);

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.response.status, 404);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("missing JSON bodies are rejected with JSON 400s", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    const createResponse = await fetch(`${baseUrl}/api/bounty/create`, { method: "POST" });
    assert.equal(createResponse.status, 400);

    const submitResponse = await fetch(`${baseUrl}/api/report/submit`, { method: "POST" });
    assert.equal(submitResponse.status, 400);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("malformed JSON requests return JSON 400 errors", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    const response = await fetch(`${baseUrl}/api/bounty/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    assert.equal(response.status, 400);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("program reset is blocked without admin token", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);
    await submitHighQualityReport(baseUrl);

    const resetAttempt = await createProgram(baseUrl, { name: "Unexpected Reset" });
    assert.equal(resetAttempt.response.status, 409);

    const bounty = await requestJson(baseUrl, "/api/bounty");
    assert.equal(bounty.json.name, "BountyBot Test Program");
    assert.equal(bounty.json.reportsCount, 1);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("program reset succeeds with admin token", async () => {
  const paths = createSandboxPaths();
  process.env.BOUNTYBOT_ADMIN_TOKEN = "secret-reset-token";
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);
    await submitHighQualityReport(baseUrl);

    const denied = await createProgram(baseUrl, { name: "Denied" }, {
      headers: { "x-admin-token": "wrong-token" },
    });
    assert.equal(denied.response.status, 403);

    const allowed = await createProgram(baseUrl, {
      name: "Authorized Reset",
      maxPerBug: 60,
      dailyLimit: 90,
    }, {
      headers: { "x-admin-token": "secret-reset-token" },
    });

    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.json.name, "Authorized Reset");
    assert.equal(allowed.json.policy.maxPerBug, 60);
    assert.equal(allowed.json.policy.dailyLimit, 90);

    const reports = await requestJson(baseUrl, "/api/reports");
    assert.deepEqual(reports.json, []);

    const apiKeys = listApiKeys(paths.vaultPath);
    assert.equal(apiKeys.length, 2);
  } finally {
    await closeServer(server);
    delete process.env.BOUNTYBOT_ADMIN_TOKEN;
    cleanupSandbox(paths.root);
  }
});

test("invalid wallet address format is rejected", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);

    const { response, json } = await submitHighQualityReport(baseUrl, {
      reporterWallet: "not-a-wallet",
    });

    assert.equal(response.status, 400);
    assert.match(json.error, /Invalid wallet address format/);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});

test("rate limiting rejects excessive submissions", async () => {
  const paths = createSandboxPaths();
  const { server, baseUrl } = await loadServer(paths);

  try {
    await createProgram(baseUrl);

    // Submit 6 reports (limit is 5/min)
    const results = [];
    for (let i = 0; i < 6; i++) {
      const { response } = await submitHighQualityReport(baseUrl, {
        title: `Bug report ${i} — SQL Injection vulnerability`,
        reporterWallet: `0x742d35Cc6634C0532925a3b844Bc9e759500000${i}`,
      });
      results.push(response.status);
    }

    // Last one should be rate limited
    assert.equal(results[5], 429);
  } finally {
    await closeServer(server);
    cleanupSandbox(paths.root);
  }
});
