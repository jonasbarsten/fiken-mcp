function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function consentPage(opts: { clientLabel: string; clientName: string; redirectHost: string; fields: Record<string, string>; cancelUrl: string }): string {
  const hidden = Object.entries(opts.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  const who = opts.clientName ? `${esc(opts.clientName)} via ${esc(opts.clientLabel)}` : esc(opts.clientLabel);
  return `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Koble til Fiken</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.5rem; }
    button { font-size: 1rem; padding: .75rem 1.25rem; border-radius: 8px; border: 0; background: #5b3df5; color: #fff; }
    .cancel { display: inline-block; padding: .75rem 1.25rem; border-radius: 8px; background: #eee; color: #222; text-decoration: none; margin-left: .5rem; }
    .muted { color: #666; font-size: .9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Koble til Fiken</h1>
    <p><strong>${who}</strong> ber om tilgang til Fiken-kontoen din gjennom Fiken MCP.</p>
    <p class="muted">Etter at du fortsetter, logger du inn hos fiken.no og godkjenner tilgangen der. Svaret sendes tilbake til ${esc(opts.redirectHost)}.</p>
    <form method="post" action="/authorize">
      ${hidden}
      <button type="submit">Fortsett til Fiken</button>
      <a class="cancel" href="${esc(opts.cancelUrl)}">Avbryt</a>
    </form>
  </div>
</body>
</html>
`;
}
