# BountyBot

Automated bug bounty payout approval agent powered by the [Open Wallet Standard (OWS)](https://openwallet.sh).

Submit a bug report. The agent evaluates quality and severity. If approved, a payout authorization is cryptographically signed inside the OWS vault. Private keys never leave the vault.

[![Live Demo](https://img.shields.io/badge/Live_Demo-owsbountybot.shelmail.xyz-6c5ce7)](https://owsbountybot.shelmail.xyz)
![OWS](https://img.shields.io/badge/OWS-Powered-6c5ce7)
![Node.js](https://img.shields.io/badge/Node.js-24+-339933)
![License](https://img.shields.io/badge/License-MIT-blue)

> Built for the [OWS Hackathon 2026](https://hackathon.openwallet.sh) — Track 2: Agent Spend Governance & Identity

## Live Demo

**https://owsbountybot.shelmail.xyz**

Click "Fill High-Quality Bug" to see the agent approve and sign a $150 payout in seconds. Click "Fill Low-Quality Report" to see a rejection.

## How It Works

```
📝 Bug Report → 🧠 Evaluate → 🔒 Policy Check → ✍️ Sign Approval → 📦 Relay / Broadcast
```

1. Researcher submits a bug report with severity, description, and wallet address
2. Evaluator scores the report (0–10) based on quality signals: reproduction steps, impact analysis, PoC, known vulnerability class
3. App-level spending limits and OWS chain-guard policy are checked before any signing occurs
4. If approved, a payout authorization is signed inside the OWS vault — the private key is decrypted in hardened memory and wiped after use
5. A downstream relayer can broadcast the real payout transaction

## Why OWS

BountyBot demonstrates the core OWS value proposition: **an autonomous agent that can authorize real payments, constrained by policies it cannot override**.

| OWS Primitive | How BountyBot Uses It |
|---------------|----------------------|
| `createWallet` | Multi-chain treasury (EVM, Solana, Bitcoin, Cosmos, Tron, TON, Sui, Filecoin) |
| `createPolicy` | Chain allowlist enforced at the signing layer — only EVM and Solana |
| `createApiKey` | Policy-gated agent access — the agent key is scoped to the treasury wallet |
| `signMessage` | Payout approvals signed in the vault; key decrypted in hardened memory, wiped after use |

The agent **cannot**:
- Exceed per-bug or daily spending limits
- Sign on unauthorized chains
- Access the raw private key
- Reset the program without an admin token

## Features

- **Quality scoring** — Reports scored 0–10 based on technical signals (PoC, reproduction steps, impact, vulnerability class)
- **Duplicate detection** — Prevents double payouts for the same finding, persisted across restarts
- **Persistent state** — Reports, approvals, counters, and duplicate history survive process restarts
- **Policy enforcement** — App-level per-bug and daily caps + OWS chain-guard policy
- **Safe reconfiguration** — Existing programs are reset-protected via `BOUNTYBOT_ADMIN_TOKEN`
- **Real-time dashboard** — Live SSE feed showing submissions, evaluations, and payout approvals
- **Error feedback** — Frontend displays validation errors and server failures inline
- **Demo mode** — One-click buttons to fill sample high-quality and low-quality reports

## Quick Start

```bash
git clone https://github.com/dieutx/owsbountybot.git
cd owsbountybot
npm install
npm run setup   # Create OWS wallet, chain-guard policy, and agent API key
npm start       # http://localhost:4000
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `BOUNTYBOT_ADMIN_TOKEN` | _(none)_ | Required to reset an existing program |
| `BOUNTYBOT_STATE_PATH` | `data/state.json` | Path to persistent state file |
| `BOUNTYBOT_EVALUATION_DELAY_MS` | `1500` | Evaluation delay for demo effect (set to `0` in tests) |
| `OWS_VAULT_PATH` | _(OWS default)_ | Custom OWS vault location |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Dashboard   │────▶│  Express API     │────▶│  OWS SDK    │
│  (SSE)       │◀────│  + Evaluator     │◀────│  (signing)  │
└─────────────┘     └──────────────────┘     └─────────────┘
     :4000              server.js              ~/.ows/wallets
                        store.js (JSON)
```

## Project Structure

```
├── backend/
│   ├── server.js        # Express API with SSE real-time updates
│   ├── evaluator.js     # Quality scoring and duplicate detection
│   ├── ows-wallet.js    # OWS wallet, policy, and signing operations
│   ├── setup-wallet.js  # One-time OWS setup script
│   └── store.js         # Persisted JSON state store
├── tests/
│   └── server.test.js   # Integration tests (persistence, payouts, validation)
├── frontend/
│   ├── index.html       # Dashboard
│   ├── app.js           # Real-time UI logic (SSE, DOM-safe rendering)
│   ├── style.css        # Dark theme
│   └── favicon.svg      # Shield icon
├── CONTRIBUTING.md
└── package.json
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bounty/create` | POST | Initialize bounty program + OWS wallet |
| `/api/bounty` | GET | Program info, stats, and spending counters |
| `/api/report/submit` | POST | Submit a bug report for evaluation |
| `/api/reports` | GET | List all reports (newest first) |
| `/api/wallet` | GET | Treasury wallet info |
| `/api/policy` | GET | Policy limits and daily remaining budget |
| `/api/transactions` | GET | Payout authorization history |
| `/api/events` | GET | SSE stream for real-time dashboard updates |

### Example: Submit a Report

```bash
curl -X POST https://owsbountybot.shelmail.xyz/api/report/submit \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SQL Injection in /api/users",
    "severity": "critical",
    "description": "Steps to reproduce: inject payload. Impact: full DB access. Proof of concept included.",
    "reporterWallet": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38"
  }'
```

### Severity Payouts

| Severity | Range | Quality Multiplier |
|----------|-------|--------------------|
| Critical | $80 – $150 | score / 10 |
| High | $40 – $80 | score / 10 |
| Medium | $15 – $40 | score / 10 |
| Low | $5 – $15 | score / 10 |

## Testing

```bash
npm test
```

Tests use Node's built-in test runner with sandboxed temp directories. No external test framework needed.

Coverage includes:
- Signed approvals are not reported as paid transfers
- Program reset clears reports, transactions, and counters
- State persists across process restarts
- Duplicate detection survives restarts
- Policy limit validation on program creation
- Error responses for invalid severity, chain, and missing fields
- Frontend error display for failed submissions

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

MIT
