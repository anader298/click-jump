'use strict';
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect width="128" height="128" rx="24" fill="#1f2430"/>
<rect x="22" y="30" width="58" height="9" rx="4.5" fill="#6b7488"/>
<rect x="22" y="52" width="84" height="14" rx="4" fill="#ffc400"/>
<rect x="22" y="79" width="44" height="9" rx="4.5" fill="#6b7488"/>
<path d="M72 56l34 15-14 5 9 17-8 4-9-17-11 10z" fill="#fff" stroke="#1f2430" stroke-width="3" stroke-linejoin="round"/>
</svg></body>`);
  await page.screenshot({ path: path.join(__dirname, '..', 'vscode', 'media', 'icon.png'), omitBackground: true });
  await browser.close();
})();
