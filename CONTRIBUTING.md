# Contributing to BountyBot

Thanks for your interest in contributing! This project was built for the [OWS Hackathon 2026](https://hackathon.openwallet.sh) and we welcome improvements.

## Getting Started

```bash
git clone https://github.com/dieutx/owsbountybot.git
cd owsbountybot
npm install
npm run setup   # creates OWS wallet + policy
npm start       # http://localhost:4000
```

## Running Tests

```bash
npm test
```

Tests use Node's built-in test runner (`node:test`) with sandboxed temp directories. No external test dependencies required.

## Project Structure

| Path | Purpose |
|------|---------|
| `backend/server.js` | Express API, SSE broadcasting, route handlers |
| `backend/evaluator.js` | Bug report quality scoring engine |
| `backend/ows-wallet.js` | OWS wallet/policy/signing operations |
| `backend/store.js` | Persistent JSON state store |
| `frontend/` | Static dashboard (vanilla JS, no build step) |
| `tests/` | Integration tests |

## How to Contribute

1. **Fork** the repo and create a feature branch
2. **Write tests** for new functionality (`tests/server.test.js`)
3. **Run `npm test`** and ensure all tests pass
4. **Keep PRs focused** — one fix or feature per PR
5. **Open a PR** with a clear description of what and why

## Guidelines

- No build tools required — the frontend is plain HTML/CSS/JS
- The backend is ESM (`"type": "module"` in package.json)
- OWS SDK is a native binary via NAPI — it works on macOS and Linux (x64/arm64)
- State is persisted to `data/state.json` — this file is gitignored
- Keep the frontend XSS-safe: use `textContent` and `document.createTextNode()`, never `innerHTML`

## Areas for Improvement

- [ ] Rate limiting on `/api/report/submit`
- [ ] CORS restriction for production deployment
- [ ] Wallet address format validation per chain
- [ ] Collision-resistant report IDs (add random suffix)
- [ ] WebSocket support as SSE alternative
- [ ] Docker container for easy deployment
- [ ] Integration with `signAndSend` for real on-chain payouts

## Code of Conduct

Be respectful. Focus on the code. Keep it constructive.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
