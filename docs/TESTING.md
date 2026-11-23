# Testing

## Last full run

macOS (Intel), Node 26.3.0, npm 11.16, Vim 9.0, 22 November 2026. Real Option+clicks in Safari were last checked on version 0.1.0.

| Suite | Command | Result |
| --- | --- | --- |
| Tokenizer, instrumenter, server | `npm run test:unit` | 160 passed, 0 failed |
| CLI | `npm run test:cli` | 21 passed, 0 failed |
| Browser end to end | `npm run test:e2e` | 87 passed, 0 failed |
| Vim | `npm run test:vim` | 16 passed, 0 failed |
| Installed Google Chrome 158 | `npm run test:chrome` | 29 passed, 0 failed |
| Installed Safari 18.0.1 | `npm run test:safari` | 7 passed, 0 failed |
| Real Option+clicks in Safari | `npm run test:safari:hands` | Passed |
| VS Code integration, packaged `.vsix` | `npm run test:vscode` | 21 passed, 0 failed |

The browser count is 28 checks in each of 3 engines, plus one parent test per engine. A 22nd VS Code step captures the demo frames when `CJ_SHOTS` is set.

## What each suite covers

**Tokenizer and instrumenter.** CRLF, lone CR, multi-line tags, `>` in attributes, unquoted attributes, comments, script, style, textarea and title content, templates, inline SVG, MathML, uppercase tags, unicode and emoji, BOMs, UTF-16, Latin-1, no body tag, a 20 MB file, malformed HTML, and filenames with spaces, quotes and unicode. Output is checked against the parse5 parser. A seeded fuzz test runs 3,000 hostile documents.

**Server.** Token, Host, Origin, DNS rebinding, traversal variants, symlink escapes, dotfiles, assets, range requests, 404s, live reload, busy ports, body size caps, clean shutdown, and source files compared by hash and modified time.

**Browsers.** Playwright drives headless Chromium, Firefox and WebKit with real Alt+clicks on text, links, images, buttons, nested elements, SVG, shadow DOM and form controls. It checks the line number, that links don't navigate or download, that normal clicks still work, that a stuck Alt clears, that saving reloads the page, and that another origin can't trigger a jump.

**Vim.** Runs `click-jump --terminal` in a real pseudo-terminal with no user config. It checks the cursor line and column, the flash appearing and clearing, a second file with a hostile name, that unsaved work is kept, and that the server stops when Vim quits.

**VS Code.** Runs the packaged extension in VS Code 1.138.0 with its own user data and extensions folders. Clicks are real, trusted input events inside VS Code's real Integrated Browser. It checks the jump, the flash decoration, that the preview stays visible, multiple files, reload on save, that unsaved edits aren't written, and clean stop.

On macOS the test harness patches a throwaway copy of VS Code in the temp folder so its windows stay hidden. It won't launch if that patch can't be verified.

## Bugs these tests found

- Comment scanning was quadratic. A 2 MB file with many comments took 15 seconds, and now takes about 130 ms.
- The preview failed to load in VS Code because `frame-ancestors` didn't allow the workbench page above the webview.
- The extension read the preview's column before VS Code had updated it.
- Opening the preview auto-saved a dirty file, which broke the rule about never writing source. Removed, with a regression test.

## What has not been verified

- **Real Safari.** Covered on Safari 18.0.1. `npm run test:safari` runs 7 checks in a normal tab with no settings changed. Scripts cannot fake an Option+click, so `npm run test:safari:hands` waits for two real clicks.
- **Windows and Linux.** GitHub Actions passed the core, CLI and browser suites on both, including Edge on Windows and Vim on Linux. The VS Code checks passed on Linux and are not confirmed on Windows. Neither has been tested by hand.
- **VS Code versions other than 1.138.0**, and forks such as Cursor and Windsurf.
- **Editors other than VS Code and Vim** as real launches. Their command lines are unit tested.

## The manual Safari check

Run `npm run test:safari:hands`. Safari opens a page with two lines of text. Hold Option and click each one. The test passes when both clicks jump and the page stays put.

## Known limits

- HTML files only. Output from React, Vue or template engines doesn't map back to its source.
- Elements created by JavaScript resolve to their nearest parent in the HTML file. Elements in shadow DOM resolve to the host.
- A strict page CSP can block the client (`script-src` without `'self'`) or the jump and reload requests (`connect-src`).
- Tags inside raw-text elements nested in `<select>` are treated as text, because parsers currently disagree there. They jump to the `<select>`.
- `--editor` jumps without a flash. The flash needs the extension or `--terminal`.
- Remote workspaces are not supported.
- HTML files over 64 MB are served without instrumentation.
- Live reload watches up to 20,000 files.
- Dotfiles and dot-folders are not served.
- Passing a single file serves its whole parent folder.
- On Windows, paths containing `% ^ & | < > !` won't launch a `.cmd` editor.
- Vim ignores a click that arrives while you're typing a `:` command.
- A file with lone CR line endings can count lines differently in Vim unless Vim detects it as `ff=mac`.
