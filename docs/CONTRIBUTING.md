# Contributing

Bug reports with a small HTML file that reproduces the problem are the most useful thing you can send. If a line number is wrong, include the file and the element you clicked.

## Setup

```sh
npm install
npx playwright install chromium firefox webkit
```

## Tests

```sh
npm test               # unit, CLI, browsers, Vim
npm run test:vscode    # downloads VS Code into a temp folder
npm run build:vsix     # writes dist/click-jump.vsix
```

`test:vim` needs Python 3 and Vim 8 or newer. On Linux, run `test:vscode` under `xvfb-run`.

## Ground rules

- The CLI and core have no runtime dependencies. Dev dependencies are fine.
- Never write to the served folder.
- Never pass a path through a shell. Use argument arrays.
- A change to the tokenizer needs a test case, and the parse5 comparison has to keep passing.
- A change to `client.js` has to pass in all three browser engines.
- Update the status table only with results from a run you actually did. If you tested on a new platform, say which one.

## Layout

`src/core` is shared. `scripts/sync-core.js` copies it into `vscode/core` when the extension is built, so edit it in `src/core` only.
