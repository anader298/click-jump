# How it works

Click Jump has one shared core and two front ends. The core is plain Node with no runtime dependencies.

```
   your files (never written)
          |
          | read
          v
 +-----------------------------------+
 |  core (src/core)                  |
 |                                   |
 |  tokenizer -> instrumenter        |
 |  server on 127.0.0.1              |        GET page with data-cj
 |  change watcher                   | -----------------------------+
 +-----------------------------------+                              |
     ^                  |                                           v
     |                  | onJump(file, line, col)        +---------------------+
     |                  v                                |  browser            |
     |     +--------------------------+                  |                     |
     |     | VS Code extension        |                  |  client.js          |
     |     |   reveal line, flash     |                  |  Option+click       |
     |     | CLI                      |                  +---------------------+
     |     |   launch editor, or      |                             |
     |     |   signal Vim             |                             |
     |     +--------------------------+                             |
     |                                                              |
     +------------------- POST /__cj/open (token) ------------------+
```

| Path | Job |
| --- | --- |
| `src/core/tokenizer.js` | Finds real start tags |
| `src/core/instrument.js` | Adds `data-cj` to a copy of the page |
| `src/core/server.js` | Serves files, checks requests, watches for changes |
| `src/core/client.js` | Runs in the page and handles Option+click |
| `src/cli/` | The `click-jump` command and the Vim script |
| `vscode/src/extension.js` | Button, Integrated Browser, jump and flash |

## Instrumentation

When the browser asks for a page, the server reads the file and returns a copy with one attribute added to each element:

```html
<!-- on disk -->
<h2>Cardamom bun</h2>

<!-- what the browser gets -->
<h2 data-cj="index.html:36:9">Cardamom bun</h2>
```

Finding those tags takes a real tokenizer. A regular expression gets fooled by `<a title="1 > 0">`, by `<div>` inside a comment, by a string in a `<script>`, or by the text of a `<textarea>`. The tokenizer follows the states in the WHATWG HTML spec, including the odd ones: script escape rules, CDATA in SVG, and the way `<title>` is raw text in HTML but a normal element inside `<svg>`.

Lines count `\n`, `\r\n` and a lone `\r` as one break each. Columns count UTF-16 units, which is what VS Code uses, and the CLI converts them to characters for Vim. A byte order mark doesn't shift the first line. Files in a legacy encoding pass through byte for byte.

The tests compare this against parse5, a separate spec-compliant parser. Parsing the original and the tagged copy must give the same document apart from `data-cj`.

The client script goes right after `<head>` when there is one, and never ahead of the doctype, so a page can't fall into quirks mode because of it.

## The jump

1. Holding Option and moving the mouse draws an outline with the file and line.
2. On press, the client finds the nearest element with `data-cj`, including through open shadow DOM, and POSTs it to `/__cj/open` with the run's token.
3. The server validates the request and the path, then calls `onJump`.
4. The extension opens the file in the code column, moves the cursor and applies a yellow decoration for 1.1 seconds. The CLI launches your editor, or writes a small signal file that Vim polls.

### Why the client listens to so many events

Safari treats Option+click on a link as a download, and the default action can come from more than one event. The client listens in the capture phase on `window`, so it runs before page handlers.

- `pointerdown` starts the gesture and is stopped but deliberately not cancelled, because cancelling it would suppress the `mousedown` that follows.
- `mousedown` is cancelled, which prevents text selection and dragging.
- `mouseup` and `click` are swallowed for the rest of the gesture, even if Option is released mid-press.
- `dragstart`, `selectstart`, `auxclick` and `dblclick` are swallowed during a gesture too.
- `blur`, `pagehide` and `visibilitychange` clear the Alt state, since the keyup is lost if you release Option in another app.

### Why the preview doesn't get covered

The preview runs in VS Code's Integrated Browser, which isn't a text editor, so the extension reveals code only in text editor columns and can't cover it. When the last page disconnects for 4 seconds, the tab is treated as closed and the server stops. The extension talks to the server in-process, so there's no `vscode://` link and no security prompt.

## Live reload

The server walks the folder every 300 ms, comparing paths, modified times and sizes. It skips dot-folders and `node_modules`, slows down if a walk is expensive, and stops counting at 20,000 files. Polling is less elegant than OS file events and behaves the same on every platform. Changes reach the page over Server-Sent Events.

## Security model

The threat is a website you visit in another tab trying to reach the local server, or a hostile filename.

| Threat | Defence |
| --- | --- |
| Access from the network | Binds to `127.0.0.1` only |
| DNS rebinding | `Host` must be exactly `127.0.0.1:port` or `localhost:port` on every request |
| Another site triggering a jump | Exact `Origin` match, a per-run token in a custom header, and JSON only, which forces a CORS preflight that the server never approves |
| Another site embedding files | `Cross-Origin-Resource-Policy: same-origin`, `Sec-Fetch-Site` checks, and `frame-ancestors` |
| Path traversal | Decoded paths with `..`, backslashes or null bytes are rejected |
| Symlink escape | The real path must stay inside the real root |
| Secrets in the folder | Dotfiles and dot-folders are not served, including through a symlink |
| Shell injection through a filename | Editors and browsers are spawned with argument arrays and no shell |
| Windows `.cmd` shims | These need `cmd.exe`, so paths with its special characters are refused |
| Oversized requests | Jump bodies are capped at 4 KB |
| Changing your source | The server has no code path that writes to the served folder |

What it does not defend against: other programs running as you on the same machine can read the served files over HTTP. The page's own scripts also run as normal, so only preview sites you trust.
