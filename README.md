# BountyBot

Automated bug bounty triage and payout authorization agent powered by the [Open Wallet Standard (OWS)](https://openwallet.sh).

Researchers submit bug reports. The system evaluates quality, detects duplicates, enforces spending policies, and cryptographically signs payout authorizations — all without exposing private keys.

[![Live Demo](https://img.shields.io/badge/Live_Demo-owsbountybot.shelmail.xyz-6c5ce7)](https://owsbountybot.shelmail.xyz)
![OWS](https://img.shields.io/badge/OWS-Powered-6c5ce7)
![Node.js](https://img.shields.io/badge/Node.js-24+-339933)
![License](https://img.shields.io/badge/License-MIT-blue)

> Built for the [OWS Hackathon 2026](https://hackathon.openwallet.sh) — Track 2: Agent Spend Governance & Identity

## Live Demo

**https://owsbountybot.shelmail.xyz**

## How It Works

```
📝 Bug Report → 🔍 Duplicate Check → 🧠 Evaluate → 🔒 Policy Check → 👤 Review → ✍️ Sign → 📦 Relay
```

1. Researcher submits a bug report with severity, description, and wallet address
2. **Fingerprinting** detects exact and probable duplicates using layered hashing + trigram similarity
3. **Evaluator** scores quality (0–10) with confidence level, extracts vulnerability class and affected asset
4. **Policy engine** checks composable rules: daily budget, per-severity caps, per-reporter limits, chain allowlists, cooldowns
5. **Review routing** sends low-value payouts to auto-approve, medium to manual review, high to admin review
6. If approved, OWS **signs** the payout authorization inside the vault — private key decrypted in hardened memory, wiped after use
7. A downstream relayer can broadcast the real transaction

## What This Is / Is Not

**Is:** A bug bounty triage + payout authorization system. It evaluates reports, enforces spending policies, and signs cryptographic authorizations.

**Is not:** A bug-finding tool, a vulnerability scanner, or a full on-chain payment processor. The current demo signs authorization messages but does not broadcast transactions.

## Features

- **Quality scoring** — Reports scored 0–10 with confidence percentage
- **Vulnerability extraction** — Auto-detects vuln class (SQLi, XSS, CSRF, etc.) and affected endpoints
- **Layered duplicate detection** — Title hash, description hash, vuln type, affected asset, combined fingerprint + fuzzy title matching (trigram similarity, program-scoped, tiered weights)
- **Probable duplicate** state — Ambiguous cases flagged for review instead of hard-rejected
- **Composable policy engine** — Per-severity caps, daily budget, per-reporter limits, chain allowlists, cooldowns
- **Multi-step review** — Auto-approve (low value), manual review (medium), admin review (high)
- **Manual review API** — Approve or reject pending reports with adjusted payouts; policy re-checked before signing; rejection requires a reason
- **Append-only audit log** — Every action recorded with correlation IDs
- **SQLite persistence** — WAL mode, proper schema with indexes, survives restarts
- **Real-time dashboard** — SSE feed with status filters (All / Signed / Pending / Rejected / Duplicates), silent background sync with smart diff (only changed items update), live connection indicator
- **Demo mode** — 16 randomized sample reports across 3 quality tiers (High / Medium / Low / Random), different each click
- **Reset** — One-click feed reset clears all reports, transactions, and budget counters
- **Click-to-expand** — Click any report to see full description + audit trail timeline
- **Admin review panel** — Inline approve/reject buttons for pending reports (requires admin token)
- **CSV export** — `GET /api/reports/export` (admin-only) downloads all reports as CSV
- **Health check** — `GET /api/health` for load balancers and monitoring
- **Retry signing** — `POST /api/report/:id/retry-sign` for reports stuck in approved state
- **Multi-chain wallets** — Supports EVM, Solana, Bitcoin, Tron, Cosmos with auto-detection from wallet address format
- **Cross-chain detection** — Flags payouts where recipient chain differs from treasury source chain, tracks bridge status (pending/bridging/bridged/failed)
- **Zod validation** — All inputs validated with structured error responses
- **Security hardened** — CORS, CSP, rate limiting, constant-time token comparison, signature redaction

## Quick Start

```bash
git clone https://github.com/dieutx/owsbountybot.git
cd owsbountybot
npm install
npm run setup   # Create OWS wallet, policy, agent key
BOUNTYBOT_ADMIN_TOKEN=admin npm start   # http://localhost:4000
npm test        # 24 integration tests
```

### Demo Flow

1. Open **http://localhost:4000** — the program auto-initializes
2. Click **"High-Quality Bug"** → **"Submit Report"** — report goes to `pending_review` (payout > $50)
3. Click **"Admin"** button in the feed header → enter token `admin`
4. Click **"Approve"** on the pending report → payout is signed with OWS
5. Click **"Low-Quality Report"** → **"Submit"** — report is auto-rejected
6. Click **"Reset All"** to clear and start over

Admin token for the live demo: `admin`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `BOUNTYBOT_ADMIN_TOKEN` | _(none)_ | Required for manual review, program reset, and re-creation. Demo: `admin` |
| `BOUNTYBOT_DB_PATH` | `data/bountybot.db` | SQLite database location |
| `BOUNTYBOT_EVALUATION_DELAY_MS` | `1500` | Evaluation delay (set to `0` in tests) |
| `CORS_ORIGIN` | `https://owsbountybot.shelmail.xyz` | Allowed CORS origin |
| `BOUNTYBOT_SOURCE_CHAIN` | `evm` | Treasury funding chain (cross-chain payouts flagged for bridging) |
| `OWS_VAULT_PATH` | _(OWS default)_ | Custom OWS vault location |

## Architecture

```
┌─────────────┐     ┌────────────────────────────┐     ┌─────────────┐
│  Dashboard   │────▶│  Express API               │────▶│  OWS SDK    │
│  (SSE)       │◀────│  ├─ evaluator.js            │◀────│  (signing)  │
└─────────────┘     │  ├─ lib/fingerprint.js       │     └─────────────┘
     :4000          │  ├─ lib/policy.js            │       ~/.ows/wallets
                    │  ├─ lib/audit.js             │
                    │  ├─ lib/schemas.js (Zod)     │
                    │  └─ db/database.js (SQLite)  │
                    └────────────────────────────┘
```

## Project Structure

```
├── backend/
│   ├── server.js            # Express API, routes, SSE
│   ├── evaluator.js         # Quality scoring, confidence, vuln detection
│   ├── ows-wallet.js        # OWS wallet, policy, signing
│   ├── setup-wallet.js      # One-time OWS setup CLI
│   ├── db/
│   │   ├── database.js      # SQLite connection + schema init
│   │   └── schema.sql       # Table definitions + indexes
│   └── lib/
│       ├── audit.js         # Append-only audit logging
│       ├── fingerprint.js   # Duplicate detection engine
│       ├── ids.js           # ID + correlation ID generation
│       ├── bridge.js        # Cross-chain detection and bridge routing
│       ├── policy.js        # Composable policy rule engine
│       └── schemas.js       # Zod validation schemas
├── frontend/                # Vanilla HTML/CSS/JS dashboard
├── tests/
│   └── server.test.js       # 24 integration tests
└── package.json
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bounty/create` | POST | Initialize bounty program |
| `/api/bounty` | GET | Program stats and spending counters |
| `/api/report/submit` | POST | Submit a bug report |
| `/api/report/:id` | GET | Report detail with audit trail |
| `/api/report/:id/review` | POST | Approve or reject a pending report (admin auth required) |
| `/api/reports` | GET | List reports (`?status=`, `?duplicates=1`) |
| `/api/reset` | POST | Clear all reports, transactions, and budgets (admin auth required) |
| `/api/wallet` | GET | Treasury wallet address (EVM only) |
| `/api/transactions` | GET | Payout authorization history |
| `/api/policy` | GET | Active policy config + daily budget |
| `/api/report/:id/retry-sign` | POST | Retry signing for approved reports (admin) |
| `/api/reports/export` | GET | CSV export of all reports (admin) |
| `/api/audit` | GET | Audit log entries (`?entity_type=`, `?entity_id=`, `?correlation_id=`) |
| `/api/health` | GET | Health check (pings database) |
| `/api/events` | GET | SSE stream for real-time updates |

### Report Lifecycle

```
pending → evaluating → rejected
                     → probable_duplicate (→ manual review)
                     → pending_review (→ approve → signed → broadcasted → confirmed)
                     →                (→ reject)
                     → approved → signed → broadcasted → confirmed
                                                      → failed
```

### Severity Payouts

| Severity | Range | Auto-Approve |
|----------|-------|-------------|
| Critical | $80 – $150 | Above $50 requires review |
| High | $40 – $80 | Above $50 requires review |
| Medium | $15 – $40 | Auto if quality sufficient |
| Low | $5 – $15 | Auto if quality sufficient |

## Supported Chains

| Chain | Wallet Format | Auto-Detect | Aliases |
|-------|--------------|-------------|---------|
| EVM (Ethereum/Base/Polygon) | `0x` + 40 hex | Yes | `eth`, `base`, `polygon` |
| Solana | Base58, 32-44 chars | Yes | `sol` |
| Bitcoin | `bc1...` or `1.../3...` | Yes | `btc` |
| Tron | `T` + 33 chars | Yes | `trx` |
| Cosmos | `cosmos1` + 38 chars | Yes | `atom` |

### Cross-Chain Payouts

When a researcher submits a wallet on a different chain than the treasury's funding chain (default: EVM), the system:

1. **Auto-detects** the recipient chain from wallet format
2. **Flags** the transaction as `needs_bridge: true`
3. **Tracks** bridge lifecycle: `pending → bridging → bridged → failed`
4. **Shows** a "cross-chain" badge in the dashboard

```
Treasury (EVM) → Researcher (Solana) = cross-chain, bridge pending
Treasury (EVM) → Researcher (EVM)    = same chain, direct payout
```

Future integration path: Circle CCTP for USDC bridging (structure ready in `backend/lib/bridge.js`).

## OWS Integration

| Primitive | Usage |
|-----------|-------|
| `createWallet` | Multi-chain treasury (EVM, Solana, Bitcoin, Cosmos, Tron, TON, Sui, Filecoin) |
| `createPolicy` | Chain allowlist enforced at signing layer |
| `createApiKey` | Policy-gated agent access scoped to treasury wallet |
| `signMessage` | Payout authorizations signed in vault; key wiped after use |

## Security

- CORS restricted to production origin
- CSP, X-Frame-Options, X-Content-Type-Options headers
- Rate limiting: 5 requests/min per IP on submit, per-IP SSE connection limits
- SSE connection cap: 200 with heartbeat for dead connection cleanup
- SSE auto-reconnect with exponential backoff (frontend)
- Atomic daily budget enforcement via SQLite transactions
- Input validation via Zod with 16kb body limit
- Wallet address format validation per chain
- Constant-time admin token comparison
- Admin token (`x-admin-token`) required for review, reset, and program re-creation
- Manual approval re-checks policy before signing (prevents exceeding limits)
- Rejection requires a reason; zero-payout approvals blocked
- Signatures never sent to clients
- Audit trail for all state-changing actions with correlation IDs
- OWS signing errors logged server-side only

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
