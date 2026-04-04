import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "owsbountybot-"));
  return {
    root,
    setup() {
      process.env.BOUNTYBOT_DB_PATH = join(root, "test.db");
      process.env.OWS_VAULT_PATH = join(root, "vault");
      process.env.BOUNTYBOT_EVALUATION_DELAY_MS = "0";
      process.env.CORS_ORIGIN = "*";
    },
    cleanup() {
      delete process.env.BOUNTYBOT_DB_PATH;
      delete process.env.OWS_VAULT_PATH;
      delete process.env.BOUNTYBOT_EVALUATION_DELAY_MS;
      delete process.env.CORS_ORIGIN;
      delete process.env.BOUNTYBOT_ADMIN_TOKEN;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startServer(sb) {
  sb.setup();
  const bust = `${Date.now()}-${Math.random()}`;
  const { createApp } = await import(`../backend/server.js?t=${bust}`);
  const app = createApp();
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  const { closeDb } = await import("../backend/db/database.js");
  closeDb();
  await new Promise((r, j) => server.close(e => e ? j(e) : r()));
}

async function api(base, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function createProgram(base, overrides = {}, headers = {}) {
  return api(base, "/api/bounty/create", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Test Program", maxPerBug: 150, dailyLimit: 500, ...overrides }),
  });
}

async function submitReport(base, overrides = {}) {
  return api(base, "/api/report/submit", {
    method: "POST",
    body: JSON.stringify({
      title: "SQL Injection in /api/users search endpoint",
      severity: "critical",
      description: "Steps to reproduce: inject payload. Impact: full database access. Proof of concept: curl with SQLi payload. Vulnerability at line 142.",
      reporterWallet: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38",
      ...overrides,
    }),
  });
}

// === Tests ===

test("full flow: submit -> evaluate -> pending_review (high value auto threshold)", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status, json } = await submitReport(base);
    assert.equal(status, 200);
    assert.equal(json.status, "pending_review");
    assert.ok(json.quality_score >= 4);
    assert.ok(json.confidence > 0);
    assert.equal(json.vuln_class, "sqli");
    // Signature should NOT be in response
    assert.equal(json.signature, undefined);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("low value report auto-approves and signs", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base, { reviewThresholds: { auto: 200, manual: 500, admin: 1000 } });
    const { json } = await submitReport(base, { severity: "low" });
    // Low severity with good quality should auto-sign (payout ~15 < auto threshold 200)
    assert.equal(json.status, "signed");
    assert.ok(json.payout > 0);
    assert.ok(json.authorization_id);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("bad report is rejected", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { json } = await submitReport(base, {
      title: "something might be broken",
      severity: "low",
      description: "not sure if bug, could be maybe",
    });
    assert.equal(json.status, "rejected");
    assert.ok(json.quality_score < 5);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("duplicate detection rejects identical reports", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    await submitReport(base);
    const { json } = await submitReport(base);
    assert.equal(json.status, "rejected");
    assert.ok(json.duplicate_of);
    assert.ok(json.duplicate_score > 0);
    assert.match(json.reasoning, /DUPLICATE/);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("manual review endpoint approves pending report", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { json: report } = await submitReport(base);
    assert.equal(report.status, "pending_review");

    const { json: reviewed } = await api(base, `/api/report/${report.id}/review`, {
      method: "POST",
      body: JSON.stringify({ action: "approve", reviewedBy: "admin" }),
    });
    assert.equal(reviewed.status, "signed");
    assert.ok(reviewed.payout > 0);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("manual review endpoint rejects pending report", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { json: report } = await submitReport(base);
    const { json: reviewed } = await api(base, `/api/report/${report.id}/review`, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "Not a real vulnerability" }),
    });
    assert.equal(reviewed.status, "rejected");
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("invalid severity rejected", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status } = await submitReport(base, { severity: "mega" });
    assert.equal(status, 400);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("invalid chain rejected", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status, json } = await submitReport(base, { chain: "bitcoin" });
    assert.equal(status, 400);
    assert.match(json.error, /Unsupported chain/);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("invalid wallet address rejected", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status, json } = await submitReport(base, { reporterWallet: "not-a-wallet" });
    assert.equal(status, 400);
    assert.match(json.error, /Invalid wallet/);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("program reset requires admin token", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status } = await createProgram(base, { name: "Reset" });
    assert.equal(status, 409);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("program reset works with admin token", async () => {
  const sb = sandbox();
  process.env.BOUNTYBOT_ADMIN_TOKEN = "test-secret";
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status, json } = await createProgram(base, { name: "New Program" }, { "x-admin-token": "test-secret" });
    assert.equal(status, 200);
    assert.equal(json.name, "New Program");
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("rate limiting kicks in after 5 requests", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const { status } = await submitReport(base, {
        title: `Bug ${i} - SQL Injection vulnerability`,
        reporterWallet: `0x742d35Cc6634C0532925a3b844Bc9e759500000${i}`,
      });
      statuses.push(status);
    }
    assert.ok(statuses.includes(429));
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("report detail endpoint includes audit trail", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { json: report } = await submitReport(base);
    const { json: detail } = await api(base, `/api/report/${report.id}`);
    assert.ok(detail.audit);
    assert.ok(detail.audit.length > 0);
    assert.equal(detail.audit[0].action, "report_submitted");
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("reports endpoint supports status filter", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    await submitReport(base);
    await submitReport(base, { title: "bad", severity: "low", description: "maybe broken?" });

    const { json: all } = await api(base, "/api/reports");
    assert.ok(all.length >= 2);

    const { json: rejected } = await api(base, "/api/reports?status=rejected");
    assert.ok(rejected.every(r => r.status === "rejected"));
  } finally {
    await stop(server);
    sb.cleanup();
  }
});

test("Zod validation rejects malformed input", async () => {
  const sb = sandbox();
  const { server, base } = await startServer(sb);
  try {
    await createProgram(base);
    const { status, json } = await api(base, "/api/report/submit", {
      method: "POST",
      body: JSON.stringify({ title: "", severity: "critical", description: "test", reporterWallet: "0x123" }),
    });
    assert.equal(status, 400);
    assert.ok(json.error);
  } finally {
    await stop(server);
    sb.cleanup();
  }
});
