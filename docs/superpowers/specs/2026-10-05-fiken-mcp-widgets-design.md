# Widgets for choices and booking previews: design

Date: 2026-10-05.

## 1. Purpose

When the user has to choose (which company, which customer, which
account, which of several alternatives) or approve a booking, the model
asks in text today. In clients that render MCP Apps (Claude on web,
desktop and mobile; ChatGPT unverified), a small widget is quicker and
clearer: buttons for the choices, and a readable preview of the booking
before anything is written.

Agreed with Jonas:

- Two widgets: one generic **choice** widget (covers company, contact,
  account and any other alternatives) and one **booking preview**.
- A click puts the answer into the chat as the user's message (the same
  `sendMessage` the upload widget uses; verified in the spike: it fills
  the composer and the user sends it). Nothing happens silently, and the
  choice stays visible in the conversation.
- MCP elicitation (native multiple choice from the protocol) is out: it
  needs a server request in the middle of a tool call, which a stateless
  Lambda behind API Gateway (buffered responses, a new server per
  request) cannot do.

Out of scope: widgets that write to Fiken themselves, account/contact
search inside the widget, ChatGPT-specific code (the MCP Apps standard
only; ChatGPT verification is its own item).

## 2. Clients without widgets

The server is stateless: only the initialize request carries the
client's capabilities, so it cannot register tools per client. Both
widget tools are therefore always registered, with `_meta.ui` pointing
at their resource, and always return a complete text result too.
Clients that render the widget show it; others show the text, and the
conversation works the same.

## 3. `ask_user_choice`

A real tool (MCP Apps tools are registered with `registerAppTool`, not
through the gateway), annotated read-only, counted like other tools. No
Fiken call.

Input (strict):

```
question: string (1–200)
options: [{ label: string (1–80), value: string (1–200), description?: string (≤ 160) }]  (2–12 options, unique values)
allowOther?: boolean  (default false: the widget shows a free-text field «Annet …»)
```

Result:

- `structuredContent: { question, options, allowOther }` for the widget.
- Text content (the fallback and what the model sees):
  `Spurte brukeren: <question>` followed by a numbered list
  `1. <label> – <description>` and the line `Vent på svaret i chatten.`
  The question and labels are the model's own words; only these frame
  words are fixed, in Norwegian like the widget.

Widget (`ui://fiken-mcp/choice.html`):

- Shows the question and one button per option (label, description
  below in smaller text). With `allowOther`, a text field and a «Send»
  button.
- A click sends the user message `<label>` followed by
  ` (<value>)` when value differs from label, e.g.
  «Fiken-demo – Amerikansk hytte AS (fiken-demo-amerikansk-hytte-as3)».
  The model gets both what the user saw and the machine value.
- After a click all buttons are disabled and the chosen one is marked,
  so a double click cannot send twice.
- No network access (empty `connectDomains`), no `innerHTML` (DOM built
  with `textContent`), so option text from the model cannot inject
  markup.

## 4. `preview_booking`

A real tool, read-only, no Fiken write. It validates a proposed write
without performing it and shows it.

Input (strict): `{ operation: string, args: object }`, where `operation`
is a write operation in the registry and `args` its input.

Behaviour:

- Unknown or read operation: a tool error (as the gateway answers).
- `args` parsed with the operation's strict input schema; validation
  errors are returned (as the gateway formats them) and shown in the
  widget as «Kan ikke føres slik:» with the messages.
- Local checks that today live inside `run` and need no Fiken call are
  extracted into pure functions and reused: for `create_journal_entry`
  the balance check (without VAT codes) and the VAT-code/account pairing.
  Other operations get schema validation only.
- On success, `structuredContent: { operation, title, companySlug,
  summary: [{ label, value }], lines?: [{ … }], totals?: … , checks:
  "ok" | [messages] }`:
  - `summary`: the operation's top-level scalar args with readable
    labels (date, description, kind, supplier/customer ids, due date …).
  - `lines`: when args has a `lines` array, one row per line with its
    fields; amounts in øre shown as kroner (`1 234,56 kr`).
  - `totals` for journal entries: debit and credit sums, and «Fiken
    beregner mva» when VAT codes are present.
- Text content: the same, as a compact Markdown table, ending with
  `Ingenting er ført ennå.`

Widget (`ui://fiken-mcp/preview.html`):

- Shows title, company, the summary, the lines table, totals, and the
  checks result.
- Buttons «Før dette» and «Endre»: «Før dette» sends the user message
  `Ja, før dette.`; «Endre» focuses nothing and sends `Jeg vil endre
  noe før det føres.` Disabled after a click.
- When checks failed, only «Endre» is shown.
- Same safety rules as the choice widget.

The model still performs the write with `fiken_write` after the user's
message; the widget never writes.

## 5. Instructions and descriptions

The connect-time instructions (from the Fiken help plan) get two
sentences:

«When the user must choose between options (company, customer, account,
alternatives), call ask_user_choice instead of asking in text. Before
any write, call preview_booking with the operation and args and wait for
the user's answer.»

`list_companies`, `search_contacts` and `list_accounts` descriptions
mention ask_user_choice when there are several matches; `fiken_write`'s
description mentions preview_booking.

## 6. Build

`api/scripts/build-widget.mjs` builds every widget from its template
(`src/widget/*.template.html`) into `src/assets/<name>.html`, with a per
widget bundle list (the choice and preview widgets need only
`@modelcontextprotocol/ext-apps/app-with-deps`, not pdf.js). The CDK
`beforeBundling` hook already runs it. `src/assets.ts` exports
`CHOICE_HTML` and `PREVIEW_HTML`. Resource URIs are stable
(`ui://fiken-mcp/choice.html`, `ui://fiken-mcp/preview.html`), per the
hard rule.

## 7. Testing

- Tools: listed with `_meta.ui.resourceUri`; resources served with the
  MCP Apps mime type and no connect domains; `ask_user_choice` input
  limits (2–12 options, unique values, lengths); fallback text format;
  `preview_booking` refuses unknown and read operations, returns schema
  errors, runs the journal checks, formats øre as kroner, never calls
  Fiken.
- Widgets: built HTML contains the bundle and no `innerHTML`; the
  widget scripts run in a `node:vm` sandbox with a fake `App` and fake
  DOM: rendering from `structuredContent`, one message per click with
  the exact text, buttons disabled after a click, `allowOther` field.
- Manual after deploy: both widgets in Claude on web and iOS (as the
  upload widget was verified); text fallback in Claude Code.
