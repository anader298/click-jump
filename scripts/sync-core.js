'use strict';
// Copies the shared core into the extension so the .vsix is self-contained.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'src', 'core');
const to = path.join(root, 'vscode', 'core');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(root, 'vscode', 'LICENSE'));
console.log('Synced core into vscode/core');
