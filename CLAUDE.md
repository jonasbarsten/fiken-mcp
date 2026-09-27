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
`docs/superpowers/plans/2026-09-22-fiken-mcp-foundation.md`). Next:
Task 15 first deployment, then plan 2 (tools, usage counters) and
plan 3 (upload widget).
