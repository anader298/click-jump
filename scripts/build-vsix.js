'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
require('./sync-core');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const out = path.join(root, 'dist', 'click-jump.vsix');
require('node:fs').mkdirSync(path.dirname(out), { recursive: true });
const r = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--out', out], {
  cwd: path.join(root, 'vscode'), stdio: 'inherit',
});
process.exit(r.status ?? 1);
