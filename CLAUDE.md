# byjoba-fiken-mcp

Remote MCP server for the Fiken accounting API. Fiken customers log in
with Fiken themselves and use it from Claude (web, Desktop, iOS, Claude
Code) and ChatGPT on their own plan. Full read and write access.

Repo: `jonasbarsten/fiken-mcp` (public). AWS: byjoba account
(`--profile byjoba`), region eu-west-1, API at `api.fiken-mcp.byjoba.com`
(`fiken-mcp.byjoba.com` itself is reserved for a future CloudFront site).

## Read these first

- `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` is the design.
- `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md` lists
  every alternative we ruled out and why. Do not re-propose those.
- The throwaway spike that verified the widget upload flow on Claude
  Desktop and iOS was deleted before the first deploy. Its code and manual
  test protocol are in git history: `git show c8dd493:spike/README.md`.

## Hard rules

- Store no user data: no tokens, no files, no accounting data. Files pass
  through Lambda memory only. Only anonymous usage counters in DynamoDB.
- One stable MCP App resource URI. Never version it per build.
- All Fiken calls through one `fikenFetch` wrapper with the queue.
  Fiken allows one concurrent request.
- Secrets in Parameter Store (`/fiken_mcp/*`), read at cold start. Never
  in code, env vars or the CloudFormation template. Load the
  `aws-secrets-manager` skill before any secret handling and never fetch
  secret values into context.
- Deploy only via GitHub Actions. Feature branches and PRs; no direct
  pushes to main.
- Keep the README up to date.

## Process

Foundation plan executed 2026-09-22 (see
`docs/superpowers/plans/2026-09-22-fiken-mcp-foundation.md`); first
deploy live 2026-09-27 at `api.fiken-mcp.byjoba.com`. Receipts-flow plan
executed 2026-09-28 (widget, upload, booking tools; see
`docs/superpowers/plans/2026-09-28-fiken-mcp-receipts-flow.md`).
Usage-and-CIMD plan executed 2026-09-28 (counters, `my_usage`, `/stats`,
401 refresh, CIMD; see
`docs/superpowers/plans/2026-09-28-fiken-mcp-usage-and-cimd.md`).
Remaining-tools plan executed 2026-09-29 (invoices, credit notes,
payments, balances, journal entries, attachments, `get_inbox_document`,
write guard; see
`docs/superpowers/plans/2026-09-29-fiken-mcp-remaining-tools.md`).
Operations plan executed 2026-09-29 (registry, `fiken_explore`,
`fiken_read`, `fiken_write`, hot-path tools, connector URL options; see
`docs/superpowers/plans/2026-09-29-fiken-mcp-operations.md`). Next: the
Fiken areas spec section 14 lists as not covered yet, as operations.
