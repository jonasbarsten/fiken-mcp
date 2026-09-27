# fiken-mcp

A remote MCP server that lets Fiken customers work with their own
accounting from Claude and ChatGPT, on their own AI subscription, after
logging into Fiken themselves. Read and write, including sending
invoices, and booking receipts picked straight from a phone.

Status: the foundation (OAuth flow, `list_companies`, infrastructure and
CI) is implemented and awaiting its first deployment.

- Design: [docs/superpowers/specs/2026-09-22-fiken-mcp-design.md](docs/superpowers/specs/2026-09-22-fiken-mcp-design.md)
- Decision record (what we ruled out and why): [docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md](docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md)
- The throwaway spike that verified the widget flow lives in git history
  (`git show c8dd493:spike/README.md`).

## Privacy

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse. Revoke access at any time in Fiken under Rediger
konto, API.

## Adding the connector

Claude (web, Desktop, iOS): Settings, Connectors, Add custom connector,
URL `https://fiken-mcp.byjoba.com/mcp`, sign-in required. Log in with
Fiken when asked.

Claude Code:

```
claude mcp add --transport http fiken https://fiken-mcp.byjoba.com/mcp
```

ChatGPT: Settings, Apps, Advanced settings, Developer mode, add the same
URL. Needs Plus or higher.

## Development

```
npm install
npm test
npm run typecheck
```

`api/` is the Lambda and its CDK stack; `iac/` is the shared
infrastructure stack. Deployments run from GitHub Actions only; see
`docs/setup.md` for the one-time setup.
