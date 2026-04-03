# BountyBot

Automated bug bounty payout approval agent powered by the [Open Wallet Standard (OWS)](https://openwallet.sh).

Submit a bug report → agent evaluates quality & severity → payout approval is signed automatically. Private keys never leave the OWS vault.

![OWS](https://img.shields.io/badge/OWS-Powered-6c5ce7) ![License](https://img.shields.io/badge/License-MIT-blue)

## How It Works

```
📝 Bug Report → 🧠 Evaluate → 🔒 Policy Check → ✍️ Sign Approval → 📦 Relay / Broadcast
```

1. Researcher submits a bug report with severity, description, and wallet address
2. Evaluator scores the report based on quality signals (reproduction steps, impact analysis, PoC, etc.)
3. The app checks per-bug and daily spending limits before any signing occurs, while OWS policies gate chain access
4. If approved, a payout authorization is signed inside the OWS vault — the private key is never exposed
5. A downstream relayer can broadcast the real payout transaction

## Features

- **Quality scoring** — Reports are scored 0–10 based on technical signals (PoC, reproduction steps, impact, vulnerability class)
- **Duplicate detection** — Prevents double payouts for the same finding, even after a restart
- **Persistent state** — Reports, payout approvals, counters, and duplicate history survive process restarts
- **Policy enforcement** — App-level per-bug and daily spending limits with an OWS chain guard for agent access
- **Multi-chain wallets** — Single treasury with addresses for EVM, Solana, Bitcoin, Cosmos, and more
- **Real-time dashboard** — Live SSE feed showing submissions, evaluations, and payout approvals
- **Demo mode** — One-click buttons to fill high-quality and low-quality sample reports

## Quick Start

```bash
# Clone
git clone https://github.com/dieutx/owsbountybot.git
cd owsbountybot

# Install
npm install

# Setup OWS wallet, policy, and agent key
npm run setup

# Start
npm start

# Test
npm test
```

Open **http://localhost:4000** in your browser.

## Project Structure

```
├── backend/
│   ├── server.js        # Express API with SSE real-time updates
│   ├── evaluator.js     # Quality scoring and duplicate detection
│   ├── ows-wallet.js    # OWS wallet, policy, and signing operations
│   ├── setup-wallet.js  # One-time OWS setup script
│   └── store.js         # Persisted JSON state store
├── tests/
│   └── server.test.js   # Regression coverage for payout + persistence flows
├── frontend/
│   ├── index.html       # Dashboard
│   ├── app.js           # Real-time UI logic
│   └── style.css        # Dark theme
└── package.json
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bounty/create` | POST | Initialize bounty program + OWS wallet |
| `/api/bounty` | GET | Program info and stats |
| `/api/report/submit` | POST | Submit a bug report |
| `/api/reports` | GET | List all reports |
| `/api/wallet` | GET | Treasury wallet info |
| `/api/policy` | GET | Policy limits and daily spending |
| `/api/transactions` | GET | Payout transaction history |
| `/api/events` | GET | SSE stream for real-time updates |

### Submit a report

```bash
curl -X POST http://localhost:4000/api/report/submit \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SQL Injection in /api/users",
    "severity": "critical",
    "description": "Steps to reproduce: inject payload. Impact: full DB access. PoC included.",
    "reporterWallet": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38"
  }'
```

## OWS Integration

BountyBot uses three core OWS primitives:

- **`createWallet`** — Multi-chain treasury wallet (EVM, Solana, Bitcoin, Cosmos, Tron, TON, Sui, Filecoin)
- **`createPolicy`** — Chain allowlists enforced before signing
- **`signMessage`** — Cryptographic signing inside the vault; private key is decrypted in hardened memory and wiped after use

The demo currently signs payout approvals, not raw transactions. A live deployment would hand the approval to a relayer or switch to `signAndSend` with chain-specific transaction construction.

The agent can approve and sign payouts but **cannot**:
- Exceed per-transaction or daily spending limits
- Sign on unauthorized chains
- Access the raw private key

## Severity Payouts

| Severity | Range |
|----------|-------|
| Critical | $80 – $150 |
| High | $40 – $80 |
| Medium | $15 – $40 |
| Low | $5 – $15 |

Final payout scales with report quality score (0–10).

## License

MIT
