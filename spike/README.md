# Upload widget spike (throwaway)

Answers, before we design attachments for the Fiken MCP:

1. Does an MCP App widget with a file picker open the native photo picker
   inside the Claude iOS app (and ChatGPT)?
2. Can the widget POST the file bytes to our own domain from the phone?
3. Does the host forward the widget's model-context update, so the model
   learns what was uploaded without the user saying anything?
4. Can the widget push a downscaled image, or a rasterized PDF page, into the
   model's context so the model never reads the file back from Fiken?
5. Does the host accept a PDF as an embedded resource block in model context?
6. Can we invalidate Claude's cached widget without re-adding the connector?

No auth, no Fiken, nothing persisted. Delete when done.

## Run

```
cd spike
npm install
npm start
```

The server starts on port 3000 and opens a Cloudflare quick tunnel. It prints:

```
Connector URL:  https://<random>.trycloudflare.com/mcp
```

Each start gets a new random URL. Editing `widget.html` needs no restart:
the server reads it on every request. Editing `server.mjs` does.

## Test in Claude

1. On claude.ai, Claude Desktop or the Claude iOS app: Settings, Connectors,
   Add custom connector. Paste the connector URL, leave "Requires sign-in" off.
2. New chat: "Jeg har noen kvitteringer, åpne opplasting." Claude calls
   `upload_receipts` and renders the widget inline. The heading shows
   `widget <hash>`, the hash of the current `widget.html`.
3. Tap "Velg filer" and pick photos or PDFs. Each file shows `OK id=…`.
   The log box at the bottom records every step, including errors.
4. Before tapping Ferdig, ask "Hva står på kvitteringen jeg nettopp lastet
   opp?" If Claude describes it without calling a tool, the image reached
   the model through the widget.
5. Tap Ferdig. Claude gets a pre-filled message to send, then calls
   `list_uploads`.

Log lines that matter:

- `host capabilities {...}` - which block types the host accepts in
  `updateModelContext`
- `image block prepared …` / `pdf page 1 rendered …`
- `updateModelContext sent (text + N image blocks)`
- `updateModelContext with PDF resource block sent` or `… failed` - and
  whether Claude can then quote text from the PDF that is not visible on
  page 1

## Cache behaviour (verified 2026-09-22, Claude Desktop 2.2553.1)

- Claude caches the tool list, including each tool's `_meta.ui.resourceUri`,
  per connector. A re-add refreshes it. `tools/list_changed` sent on a tool
  call's stream did not refresh it.
- Claude re-reads the widget resource by URI, but keeps a copy for the
  lifetime of the app session. Restarting Claude Desktop is enough to pick
  up a changed widget.
- A resource URI that changes per build is a trap: the cached tool list
  keeps asking for the old URI, the read fails, and Claude shows
  "Unable to reach <connector>". The tool therefore points at the stable
  `ui://fiken-spike/upload.html`.

So: edit `widget.html`, restart Claude Desktop, done. No re-add.

## Test in ChatGPT

Settings, Apps, Advanced settings, Developer mode on (web only). Add the
connector URL. Developer mode needs a Plus plan or higher.
