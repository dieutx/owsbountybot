# Contributing to BountyBot

## Getting Started

```bash
git clone https://github.com/dieutx/owsbountybot.git
cd owsbountybot
npm install
npm run setup   # creates OWS wallet + policy
npm start       # http://localhost:4000
npm test        # runs integration tests
```

## Running Tests

```bash
npm test
```

Tests use Node's built-in test runner with sandboxed temp directories. Each test gets its own SQLite database and OWS vault. No external dependencies needed.

## Project Layout

| Path | Purpose |
|------|---------|
| `backend/server.js` | Express routes, SSE, middleware |
| `backend/evaluator.js` | Quality scoring engine |
| `backend/ows-wallet.js` | OWS wallet/signing operations |
| `backend/db/schema.sql` | SQLite table definitions |
| `backend/db/database.js` | Database connection management |
| `backend/lib/fingerprint.js` | Duplicate detection engine |
| `backend/lib/policy.js` | Composable spending policy rules |
| `backend/lib/audit.js` | Append-only audit logging |
| `backend/lib/schemas.js` | Zod input validation schemas |
| `backend/lib/ids.js` | ID generation utilities |
| `frontend/` | Static dashboard (vanilla JS) |
| `tests/` | Integration tests |

## Key Architecture Decisions

- **SQLite** for persistence (WAL mode, better-sqlite3). No ORM — raw SQL for clarity.
- **Zod** for input validation. Schemas defined in `lib/schemas.js`.
- **No build step** for frontend. Plain HTML/CSS/JS.
- **ESM modules** throughout (`"type": "module"` in package.json).
- **Deterministic evaluator** — no LLM calls. Pattern matching + heuristics only.
- **Signatures never sent to clients** — stripped in `sanitizeReport`/`sanitizeTransaction`.
- **No inline onclick** in HTML — all event listeners bound via `addEventListener` in `app.js` (CSP requires this).
- **Smart-diff refresh** — background sync only updates DOM for items whose status changed, no full feed rebuild.

## How to Contribute

1. Fork the repo and create a feature branch
2. Write tests for new functionality
3. Run `npm test` — all tests must pass
4. Keep PRs focused — one fix or feature per PR
5. Open a PR with a clear description

## Guidelines

- Frontend must stay XSS-safe: `textContent` and `createTextNode` only, never set HTML from user data
- All new API inputs must have Zod schemas
- State-changing actions must create audit log entries
- New report statuses must be added to the `CHECK` constraint in `schema.sql`
- No inline `onclick` attributes in HTML — bind via `addEventListener` in `app.js`
- Demo reports pool is in `app.js` — add new examples to `GOOD_REPORTS`, `MEDIUM_REPORTS`, or `BAD_REPORTS` arrays

## License

By contributing, you agree your contributions are licensed under MIT.
