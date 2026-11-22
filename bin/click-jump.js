#!/usr/bin/env node
'use strict';
require('../src/cli/main').main(process.argv.slice(2)).then(
  (code) => { if (typeof code === 'number') process.exitCode = code; },
  (err) => { console.error(`click-jump: ${err.message}`); process.exitCode = 1; },
);
