# Accounting guides design

Date: 2026-10-05.

## 1. Purpose

Claude and ChatGPT should book correctly in Fiken when a case is more than
a plain purchase or sale. The receipts example on the website showed the
problem: the model booked an employee's outlay as an unpaid purchase with
the employee as supplier, but Fiken books it as «Betalt av ansatt» on 2911
Gjeld til ansatte. The Fiken API also cannot mark a purchase that way, so
the right answer through this connector is a journal entry. A generic skill
cannot know that; the server can.

The guides are short Norwegian bookkeeping recipes. They live in the repo,
are served to the model through `fiken_read`, and are published on
`fiken-mcp.byjoba.com` so anyone can see what the model is told and
suggest corrections through GitHub.

Agreed with Jonas:

- First round covers four areas: outlays and private payments, VAT special
  cases, periods and assets, sales corrections (section 3).
- Norwegian only, for both the model and the website. Jonas reads the
  first two or three guides closely before the rest are written.
- Guides ship unreviewed by an accountant, with sources and a visible
  note. Review can come later per guide.
- The website pages are generated in the deploy (no JavaScript).
- Pages invite corrections as pull requests on GitHub.
- The eval set (realistic messages → expected booking, run against a
  model) is a separate, later plan.

Out of scope: tax advice beyond bookkeeping, payroll, year-end
(årsoppgjør), a Claude skill package (can be generated from the same files
later), the eval.

## 2. Format

`guides/` at the repo root, one file per guide, `guides/<id>.md`.

```markdown
---
id: ansattutlegg
tittel: Ansatt har lagt ut for firmaet
når: En ansatt har betalt en utgift for firmaet privat og skal ha pengene tilbake.
operasjoner: [create_journal_entry, attach_inbox_document]
kilder:
  - https://hjelp.fiken.no/hvordan-registrere-ansattutlegg
  - https://kontohjelp.fiken.no/enk/medMoms/2911
gjennomgått: false
oppdatert: 2026-10-05
---

## Situasjon
## Spør brukeren først
## Slik føres det
## Dokumentasjon
## Vanlige feil
```

Rules:

- `id` is lowercase `a-z0-9-` and equals the file name.
- `når` is one sentence; the model chooses a guide from it.
- `operasjoner` names operations that exist in the server's registry.
- `kilder` has at least one `https` URL, each from `fiken.no`,
  `skatteetaten.no` or `lovdata.no`. Every claim about accounts, VAT codes
  or rules is backed by a listed source. A URL is only listed after it was
  opened and read.
- `gjennomgått` is `false` until an accountant has reviewed the guide.
- The five headings appear in that order. «Slik føres det» names accounts,
  VAT codes and the operation(s) with example inputs in this server's
  format. Where the Fiken API cannot do what Fiken's web interface does,
  the guide says so and gives the alternative.

## 3. First round (13 guides)

| id | Title | Area |
|---|---|---|
| ansattutlegg | Ansatt har lagt ut for firmaet | Outlays |
| eierutlegg | Eieren har betalt for firmaet privat (ENK og AS) | Outlays |
| privat-kjop | Firmaet har betalt noe privat | Outlays |
| representasjon | Representasjon (bevertning, kundemøter) | VAT |
| gaver | Gaver til kunder og ansatte | VAT |
| snudd-avregning | Tjenester kjøpt fra utlandet | VAT |
| delvis-fradrag | Utgifter som brukes både i og utenfor mva-pliktig virksomhet | VAT |
| forskuddsbetalt | Forskuddsbetalte kostnader over flere perioder | Periods |
| periodisering | Periodisering av kostnader og inntekter | Periods |
| driftsmidler | Kjøp som skal aktiveres og avskrives | Periods |
| kreditere-og-fakturere-pa-nytt | Kreditere en faktura og lage en ny | Sales |
| delvis-kreditering | Kreditere deler av en faktura | Sales |
| tap-pa-fordringer | Kunden betaler ikke (tap på fordringer) | Sales |

Payment with fees or in cash is covered inside the relevant guides
(`settle_sale`, `register_payment`, `paymentFee`) rather than as its own
guide. The exact content of each guide comes from its sources during
implementation.

## 4. In the MCP server

- **Instructions at connect time.** `createMcpServer` passes `instructions`
  to `McpServer` (supported by the SDK):
  «Før du fører noe annet enn et vanlig kjøp eller salg: hent
  accounting_guides med fiken_read og les guiden som passer. Gå gjennom
  forslaget med brukeren før du skriver noe.»
- **Concept `guides`** with two read operations through `fiken_read`:
  - `accounting_guides` (no input): `[{ id, tittel, når, gjennomgått }]`.
  - `accounting_guide { id }`: the guide's Markdown body with its
    frontmatter fields as a header block. If `gjennomgått` is false the
    first line is «Ikke gjennomgått av regnskapsfører. Be brukeren
    kontrollere føringen i Fiken.» An unknown id answers a tool error that
    lists the valid ids.
- Visible on every connection, including `/mcp/readonly` and concept
  filters (they are reads, and filters only limit writes).
- No Fiken call, so they are not queued; they are counted in the usage
  statistics like other operations.
- Relevant operation descriptions point to guides by id, e.g.
  `create_purchase`: «Har en ansatt betalt privat, se guiden
  ansattutlegg.» Only where a guide exists.

## 4a. VAT on journal entries (added 2026-10-05)

The outlay guides need one journal entry with VAT from the receipts and
the debt on 2911 (or the owner's account). `create_journal_entry` refuses
VAT codes today (decision record, coverage plan: "No VAT codes: VAT is
booked through create_purchase or create_sale, where Fiken checks it").
Fiken's API accepts `debitVatCode` and `creditVatCode` on journal entry
lines; with a VAT code, a debit line's amount is net and a credit line's
amount is gross, and Fiken books the VAT.

Jonas decided to add them:

- Lines accept optional `debitVatCode` and `creditVatCode` (integers,
  Fiken's VAT codes).
- When any line has a VAT code, the server skips its own balance check
  (net and gross amounts do not sum) and lets Fiken validate; without
  VAT codes the check stays as it is.
- The description explains net/gross and points to the guides.
- The decision record gets a dated reversal of the old ruling.
- Verified live on the demo company after deploy (an outlay with 25 %
  VAT booked against 2911, read back with the VAT line).

## 5. One parser, two builds

- `guides/parse.mjs` (plain ESM JavaScript, so both the CDK bundling step
  and the site build can run it with `node`): reads `guides/*.md`, parses
  the frontmatter, validates section 2's rules and returns the guides
  sorted by id. It throws with the file name and the broken rule.
- **API:** `api/scripts/build-guides.mjs` runs in the API's
  `beforeBundling` hook (like `build-widget.mjs`) and writes
  `api/src/assets/guides.json` (gitignored), which the guide operations
  import. A test parses `guides/` directly so it never depends on the
  generated file.
- **Website:** `scripts/build-guides.mjs` writes `web/guider/index.html`
  and `web/guider/<id>.html` (gitignored) with the site's layout and
  `style.css`, using a Markdown library at build time only (version taken
  from npm when added). Pages contain no JavaScript and keep the site's
  CSP. Files are `.html` because CloudFront resolves `index.html` only at
  the root.
- The deploy workflow's content step runs the site build before the sync.
  Locally: `npm run build:guides`.

## 6. The website

- `/guider/index.html`: intro, the list (title, «når», a «Ikke
  gjennomgått av regnskapsfører» tag), and the contribution note.
- `/guider/<id>.html`: the guide, its sources as links, «Sist oppdatert»,
  the unreviewed note when it applies, and a «Rediger på GitHub» link to
  `https://github.com/jonasbarsten/fiken-mcp/edit/main/guides/<id>.md`
  (GitHub forks and opens a pull request for the visitor).
- Contribution note on both: «Ser du en feil, eller vil du bidra? Guidene
  ligger på GitHub. Lag en pull request, eller åpne en sak om du ikke vil
  skrive selv.» linking to the `guides/` folder and to new issues.
- Home page, in «Hva den kan»: a link «Se guidene Claude og ChatGPT får om
  føring i Fiken» to `/guider/index.html`.
- Disclaimer on the guide pages: the guides are not accounting advice;
  check with an accountant.

## 7. Deploy

`iac/lib/deploy-targets.ts`:

- `guides/**` → api, content
- `scripts/build-guides.mjs` → content
- `api/scripts/build-guides.mjs` → api (already covered by `api/**`)

## 8. Testing

- Every guide: valid frontmatter, `id` equals file name and is unique,
  every operation exists in the registry, the five headings in order, at
  least one `https` source on an allowed host, `gjennomgått` boolean,
  `oppdatert` a date.
- Operations: the index lists every guide; a guide returns its body; the
  unreviewed line appears exactly when `gjennomgått` is false; an unknown
  id is a tool error naming the valid ids; both are visible on
  `/mcp/readonly`.
- Server: `initialize` returns the instructions.
- Site build: one page per guide plus the index, each with the edit link
  and sources, no inline script or style, valid local links.
- `deploy-targets`: the new rows.

## 9. Docs

README: a «Guides» section (format, how the model gets them, how to
contribute). `CONTRIBUTING.md` at the root: how to add or correct a
guide, the rules from section 2, and that every claim needs a source.
`docs/setup.md`: the build step.
