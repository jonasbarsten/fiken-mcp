# Fiken MCP website design

Date: 2026-10-03. Builds spec section 10 of
`2026-09-22-fiken-mcp-design.md`: the static site at
`https://fiken-mcp.byjoba.com`.

## 1. Purpose

The site is for Fiken customers, mostly Norwegian small-business owners
and accountants, not developers. A visitor should understand what the
connector does and that it stores nothing, then ask for early access
or add the connector within a couple of minutes.

Agreed with Jonas:

- Norwegian only (bokmål). The README stays the English, developer-facing
  page.
- The site links to the GitHub repo. The repo gets an MIT licence.
- A disclaimer: Jonas is not responsible for accounting errors.
- Early access: the Fiken app is in development status, which Fiken caps
  at 5 users, and it needs 5 active users before Jonas can apply for
  production status. Visitors email Jonas to be added. The address must
  not be readable by bots.
- Live counters from `GET /stats`, served through CloudFront on the
  site's own domain.
- All resources are defined in `/iac`; the site's content lives in
  `/web` in this repo.
- The deploy workflow detects what changed: a change only to the site
  deploys only the site, and a change only to the api or iac deploys
  nothing of the site.
- The README is reworked in the same branch to read well on GitHub.

Out of scope: analytics, cookies, a contact form, an English version,
per-user pages (ruled out in the decision record), a framework or a
build step.

## 2. Architecture

```
web/                      static files, no build step
iac/lib/web-stack.ts      new stack fiken-mcp-web
iac/lib/exec-policy.ts    new statements for CloudFront and the site bucket
iac/bin/iac.ts            instantiates fiken-mcp-iac and fiken-mcp-web
iac/lib/deploy-targets.ts pure function: changed paths -> stacks to deploy
.github/workflows/deploy.yml  a changes job, then the deploy job
LICENSE                   MIT, Jonas Barsten
```

### 2.1 Stack `fiken-mcp-web` (eu-west-1)

- **Bucket** `fiken-mcp-web-<account>`: block all public access, S3
  managed encryption, `enforceSSL`, versioning off, `RemovalPolicy.RETAIN`
  (no auto-delete custom resource; the content is rebuilt from git).
- **Distribution:**
  - Default behavior: the bucket through an Origin Access Control,
    viewer protocol redirect to HTTPS, GET/HEAD only, managed
    `CachingOptimized` policy, compression on.
  - Behavior `/stats`: an `HttpOrigin` for `api.fiken-mcp.byjoba.com`
    (HTTPS only), GET/HEAD only, a cache policy with no cookies, headers
    or query strings that honours the origin's `Cache-Control`
    (`max-age=300`), with default TTL 300 s and maximum 300 s. No origin
    request policy, so the origin sees its own host name.
  - Alias `fiken-mcp.byjoba.com`, certificate imported by ARN
    `arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30`
    (requested by hand, like the API's), TLS 1.2_2021 minimum, HTTP/2 and
    HTTP/3, price class 100, `defaultRootObject` `index.html`.
  - 403 and 404 from the bucket answer `/404.html` with status 404.
  - No access logging. The site collects nothing, not even IP addresses
    in logs.
  - A response headers policy on both behaviors: HSTS (one year,
    include subdomains), `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, frame denial, and the content
    security policy `default-src 'none'; script-src 'self'; style-src
    'self'; img-src 'self'; connect-src 'self'; base-uri 'none';
    form-action 'none'; frame-ancestors 'none'`. That is why CSS and
    JavaScript are separate files, not inline.
- **DNS:** A and AAAA alias records for the apex `fiken-mcp.byjoba.com`
  in the existing `byjoba.com` zone.
- **Content:** a `BucketDeployment` from `../web` with
  `distributionPaths: ["/*"]`, so a deploy uploads, prunes removed files
  and invalidates.
- **Permissions boundary:** the stack applies the existing
  `fiken-mcp-cfn-exec` managed policy (imported by name) as the boundary
  on every role it creates, as the other stacks do. The
  `BucketDeployment` Lambda and its role carry the stack's
  `fiken-mcp-web-` name prefix.
- **Outputs:** bucket name, distribution id and domain name.

> **Changed 2026-10-04.** The stack no longer holds a `BucketDeployment`
> (and so no Lambda, layer or role) or the A/AAAA records. Content ships
> from the deploy workflow: `aws s3 sync web/ --delete`, a copy of the
> icon and a CloudFront invalidation. The alias records now live in the iac
> stack, which imports `fiken-mcp-web-distribution-domain-name` for the A and
> AAAA aliases and `fiken-mcp-web-distribution-id` to narrow the deploy
> role's invalidation right to that one distribution. The stack outputs the bucket name and
> exports the distribution id and domain name as
> `fiken-mcp-web-distribution-id` and
> `fiken-mcp-web-distribution-domain-name`. See "Site content deploy" in
> `docs/setup.md`.

### 2.2 Execution policy (stack `fiken-mcp-iac`)

New statements, each pinned as tightly as CloudFront's ARNs allow:

- S3 bucket management (create, delete, policy, encryption, public access
  block, ownership controls, tagging) on `arn:aws:s3:::fiken-mcp-web-*`,
  and object read/write/delete/list on `arn:aws:s3:::fiken-mcp-web-*/*`
  for the deployment Lambda's boundary.
- CloudFront create, update, delete, get, tag and invalidate on this
  account's distributions, origin access controls, cache policies and
  response headers policies. CloudFront ARNs carry generated ids, so
  these are `arn:aws:cloudfront::<account>:<type>/*`.
- Whatever else the `BucketDeployment` provider needs (its AWS CLI Lambda
  layer and its log group). The plan confirms the exact layer name from
  the synthesized template instead of guessing a wildcard.
- The existing `CertificatesRead` and `DnsZone` statements already cover
  the certificate and the zone.

### 2.3 Deploy workflow

`deploy.yml` gets two jobs:

1. **`changes`** (no environment, `actions: read`): checks out the full
   history and finds the newest commit on `main` whose `deploy` run
   succeeded (`gh run list --workflow deploy --branch main --status
   success --limit 1`). It lists the files changed between that commit
   and the pushed commit, runs `deploy-targets` and outputs one flag per
   stack. When no successful run exists, it deploys everything.
   Comparing against the last successful deploy, not `HEAD~1`, means a
   rejected or failed run does not drop its changes from the next run.
2. **`deploy`** (environment `production`): runs only when at least one
   flag is set, so a docs-only merge asks for no approval. It deploys in
   the order `fiken-mcp-iac`, `fiken-mcp-web`, `fiken-mcp-api`, skipping
   the stacks whose flag is unset. The iac stack goes first because it
   holds the execution policy the others rely on.

`deploy-targets` maps changed paths to stacks:

| Path | Stacks |
|---|---|
| `web/**`, `iac/lib/web-stack.ts` | web |
| `iac/lib/iac-stack.ts` | iac |
| any other `iac/**` (exec-policy, which also holds the site constants, bin, synthesizer, package.json, cdk.json) | iac, web |
| api/src/assets/icon.png (also shipped by the site) | web, api |
| `api/**` | api |
| `package.json`, `package-lock.json`, `tsconfig.base.json`, `.github/workflows/deploy.yml` | iac, web, api |
| `iac/test/**`, `api/test/**`, `iac/lib/deploy-targets.ts` | none (CI covers them; they change no stack) |
| anything else (`docs/**`, `README.md`, `LICENSE`, `CLAUDE.md`, other workflows) | none |

> **Changed 2026-10-04.** There is a fourth flag, `content`: the sync and
> invalidation step that ships the site's files (it is not a stack). The
> deploy order is iac, web, content, api. The table rows become:
>
> | Path | Flags |
> |---|---|
> | `web/**` | content |
> | `iac/lib/web-stack.ts` | web |
> | `iac/lib/iac-stack.ts` | iac |
> | any other `iac/**` | iac, web |
> | `api/src/assets/icon.png` | content, api |
> | `api/**` | api |
> | `package.json`, `package-lock.json`, `tsconfig.base.json`, `.github/workflows/deploy.yml` | iac, web, content, api |
> | tests, `iac/lib/deploy-targets.ts`, docs and everything else | none |

### 2.4 Order of first deploy

1. Jonas requested the certificate in us-east-1 (done). Before merging,
   he confirms in the ACM console that it is Issued and covers
   `fiken-mcp.byjoba.com`.
2. One PR with all of the above. On merge, the iac step widens the
   execution policy, then the web step creates the site.

## 3. The page (`web/`)

Files: `index.html`, `404.html`, `style.css`, `site.js`, `icon.png` (a
copy of `api/src/assets/icon.png`). `<html lang="nb">`, one column,
readable on a phone, system fonts, no Fiken logo or colours (we are a
third party, as for the connector icon). Works without JavaScript except
for the email button, the copy button and the counters.

### 3.1 Copy (bokmål)

Jonas reviews and corrects this wording before the PR merges.

**Title:** Fiken MCP: Fiken i Claude og ChatGPT

**Meta description:** Koble Fiken til Claude eller ChatGPT. Bokfør
kvitteringer, lag fakturaer og få svar om regnskapet rett fra chatten.

**Header:** the icon, «Fiken MCP», then:

> Koble Fiken til Claude eller ChatGPT, og be assistenten bokføre
> kvitteringer, lage fakturaer eller finne tall i regnskapet. Alt skjer
> direkte i ditt eget Fiken-foretak.

Below that, two buttons side by side (stacked on a phone):

- «Bli med fra starten», an in-page link to the early-access section.
- «Åpen kildekode på GitHub» with the GitHub mark, linking to
  `https://github.com/jonasbarsten/fiken-mcp`. The mark is an inline
  `<svg>` in `index.html` (GitHub's published Invertocat path, used
  unmodified as their logo guidelines allow for linking to GitHub), so
  nothing loads from GitHub and the CSP stays `img-src 'self'`. The SVG
  has `aria-hidden="true"`; the button text carries the meaning.

**Bli med fra starten**

> Fiken MCP er helt nytt. Foreløpig er appen registrert hos Fiken som
> en utviklingsapp, og da kan høyst fem personer bruke den. Når fem
> brukere er aktive, kan jeg søke Fiken om produksjonsstatus, og da kan
> alle ta den i bruk.
>
> Vil du være en av de første? Send meg en e-post med adressen du logger
> inn i Fiken med, så legger jeg deg til. Det er bare noen få plasser.

Button: «Vis e-postadressen». After a click the button is replaced by
the address as a `mailto:` link with the subject «Tilgang til Fiken
MCP».

**Dette kan du gjøre**

- **Kvitteringer.** Ta bilde av kvitteringen eller last opp PDF-en, så
  bokfører assistenten kjøpet med riktig konto og mva.
- **Salg og fakturaer.** Lag fakturautkast, opprett og send fakturaer,
  og lag kreditnotaer.
- **Kunder, leverandører og produkter.** Søk dem opp, opprett nye eller
  oppdater dem.
- **Oversikt.** Spør om saldoer, banken, ubetalte fakturaer eller hva som
  er bokført på en konto.
- **Prosjekter og timer.** Før timer på prosjekter og fakturer dem.
- **Bare lesetilgang.** Skal assistenten bare lese og ikke endre noe?
  Bruk adressen som slutter på `/mcp/readonly`.

**Slik kommer du i gang**

> Du trenger:
>
> - et Fiken-foretak med tilleggstjenesten API (Foretak → Tilleggstjenester
>   → API, 99 kr i måneden; den er alltid inkludert i testforetak)
> - tilgang til appen (se over)
> - Claude eller ChatGPT
>
> **Claude** (nettleser, Mac, PC og mobil): Gå til Customize → Connectors,
> trykk Add og velg Add custom connector. Gi koblingen et navn, for
> eksempel Fiken, og lim inn denne adressen:
>
> `https://api.fiken-mcp.byjoba.com/mcp` [Kopier]
>
> Logg inn med Fiken når du blir bedt om det. Menyene i Claude er på
> engelsk.
>
> **Claude Code:**
> `claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp`
>
> **ChatGPT:** Ikke testet ennå.

**Personvern**

> Tjenesten lagrer ingen av dataene dine. Filer og regnskapsdata går
> gjennom serveren på vei til og fra Fiken, men blir verken lagret eller
> logget. Det samme gjelder innloggingen din hos Fiken.
>
> Det eneste som tas vare på, er anonym bruksstatistikk: hvor mange
> ganger hvert verktøy er brukt per måned, og om det gikk bra. Tellingen
> knyttes til en kode som lages fra e-postadressen din, og koden kan ikke
> regnes tilbake til adressen.
>
> Kobler du fra i Claude eller ChatGPT, glemmer bare den appen
> innloggingen. For å stenge tilgangen helt går du i Fiken til Rediger
> konto → Sikkerhet → Apper du har gitt tilgang til og fjerner tilgangen
> for Fiken MCP. Gjør det også hvis du tror at en enhet eller konto er på
> avveie.

**Bruk så langt** (three numbers, `–` until loaded or if the fetch fails)

- brukere totalt (`totalUsers`)
- aktive brukere i <måned> (`activeUsers` for the current month)
- kall i <måned> (`calls` for the current month)

`<måned>` is the month name from `Intl` with locale `nb-NO`, e.g.
«oktober». A month missing from `/stats` shows 0.

> Tallene oppdateres hvert femte minutt.

**Ansvarsfraskrivelse**

> Fiken MCP er et uavhengig prosjekt med åpen kildekode og har ingen
> tilknytning til Fiken AS. Tjenesten leveres som den er, uten noen form
> for garanti.
>
> KI-assistenter kan ta feil. Du er selv ansvarlig for alt som bokføres,
> faktureres eller sendes fra foretaket ditt, også når assistenten gjør
> det for deg. Kontroller alltid resultatet i Fiken. Jeg er ikke ansvarlig
> for feil i regnskapet eller for tap som følger av at du bruker
> tjenesten.

**Footer:** «Kildekoden ligger på GitHub» (link to
`https://github.com/jonasbarsten/fiken-mcp`) · «MIT-lisens» (link to
LICENSE on GitHub) · «byJoBa» with «(Jonas Barsten)» after it in
smaller text. No «Laget av» in front: «by» already says it. The README
footer uses the same signature.

**404 page:** «Denne siden finnes ikke.» with a link «Til forsiden».

### 3.2 Behaviour (`site.js`)

- **Email button.** The address is never in any file as text, nor as an
  `@`-joined or `mailto:` string. `site.js` holds it as an array of char
  codes in reverse order and builds the `mailto:` link only on click.
- **Copy button.** `navigator.clipboard.writeText` with the connector
  URL; the label changes to «Kopiert» for two seconds. Hidden when the
  clipboard API is missing.
- **Counters.** `fetch("/stats")`, then fill the three numbers. On any
  error the dashes stay; nothing is shown to the visitor beyond that.

## 4. README

Rework the README's opening so it sells the project on GitHub, keeping
every existing technical section accurate:

- The icon, a one-line pitch, badges (CI status, MIT licence) and a link
  to the website.
- «What you can ask» with five or six example prompts and what happens.
- Quick start (add the connector) near the top; early access note in
  English with a link to the site for the email button.
- Privacy and the disclaimer stated briefly up front, with the existing
  detail kept further down.
- A short «How it works» diagram (client → API Gateway → Lambda →
  Fiken) before the developer sections.
- A new «Website» section: `/web`, the `fiken-mcp-web` stack, the deploy
  flags.

No screenshots in this round (none exist yet). No Fiken logo.

## 5. Testing

- `iac/test/web-stack.test.ts` (CDK assertions): the bucket blocks public
  access and enforces SSL; the distribution has the alias, the imported
  us-east-1 certificate, an origin access control, the `/stats` behavior
  to `api.fiken-mcp.byjoba.com` with the 300 s cache policy, the
  response headers policy with the exact CSP, no logging, the 403/404
  mapping; the A and AAAA records on the apex; the `BucketDeployment`
  invalidates `/*`; every role carries the boundary.
- `iac/test/iac-stack.test.ts`: the new execution-policy statements, and
  that no new statement grants an unconditioned `*` resource.
- `iac/test/deploy-targets.test.ts`: every row of the table in 2.3, a mix
  of paths, and an empty list (nothing to deploy).
- `iac/test/web-content.test.ts`: every file in `web/` is free of the
  email address in any plain form (whole address, `mailto:`, `@gmail`);
  `index.html` has `lang="nb"`, the GitHub link, the disclaimer heading
  and no inline `<script>` or `<style>`; every local `href`/`src` exists
  in `web/`; `site.js` decodes the char codes to the expected address.
- After the first deploy, by hand: the page loads over HTTPS on the
  apex, the counters fill, the email button works, `/stats` on the site
  domain matches the API's, `curl -I` shows the security headers, and a
  web-only change deploys only the web stack.

## 6. Docs

- `docs/setup.md`: the us-east-1 certificate, the post-deploy checks.
- Design spec section 14: the website moves to done after deploy.
- `CLAUDE.md` process line.
