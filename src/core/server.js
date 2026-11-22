'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { instrument, decodeLoc } = require('./instrument');

const MAX_BODY = 4096;
const MAX_INSTRUMENT_BYTES = 64 * 1024 * 1024;
const MAX_SSE_CLIENTS = 64;
const MAX_WATCHED_FILES = 20000;
const HOST = '127.0.0.1';
const DEFAULT_PORTS = { first: 5757, last: 5776 };
const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, 'client.js'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function isHtmlPath(p) { return /\.html?$/i.test(p); }

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hasDotSegment(rel) {
  return rel.split(/[\\/]/).some((s) => s.startsWith('.') && s !== '.');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Maps a decoded URL path to a real file inside root, or reports why not. */
async function resolveInRoot(realRoot, decoded) {
  if (decoded.includes('\0') || decoded.includes('\\')) return { status: 403 };
  const segments = decoded.split('/');
  if (segments.includes('..')) return { status: 403 };
  if (segments.some((s) => s.startsWith('.') && s !== '.' && s !== '')) return { status: 404 };
  if (process.platform === 'win32' && segments.some((s) => s.includes(':'))) return { status: 403 };
  const joined = path.join(realRoot, ...segments.filter(Boolean));
  if (!isInside(realRoot, joined)) return { status: 403 };
  let real;
  try {
    real = await fsp.realpath(joined);
  } catch {
    return { status: 404 };
  }
  if (!isInside(realRoot, real)) return { status: 403 };
  if (hasDotSegment(path.relative(realRoot, real))) return { status: 404 };
  let stat;
  try {
    stat = await fsp.stat(real);
  } catch {
    return { status: 404 };
  }
  return { real, stat };
}

async function walkSignature(root, signal) {
  const hash = crypto.createHash('sha1');
  const stack = [root];
  let files = 0;
  while (stack.length) {
    if (signal.stopped) return null;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (++files > MAX_WATCHED_FILES) return { digest: hash.digest('hex'), capped: true };
        try {
          const st = await fsp.stat(full);
          if (st.isFile()) hash.update(`${full}\0${st.mtimeMs}\0${st.size}\n`);
        } catch { /* deleted mid-walk */ }
      }
    }
  }
  return { digest: hash.digest('hex'), capped: false };
}

/**
 * Starts a preview server.
 * @param {object} o
 * @param {string} o.root folder to serve
 * @param {(jump:{file:string,rel:string,line:number,col:number})=>void} [o.onJump]
 * @param {number} [o.port] exact port; fails if busy. Omit to scan for a free one.
 * @param {string} [o.frameAncestors] CSP frame-ancestors value
 * @param {number} [o.watchIntervalMs]
 * @param {(msg:string)=>void} [o.log]
 */
async function startServer(o) {
  const realRoot = await fsp.realpath(o.root);
  const token = crypto.randomBytes(24).toString('base64url');
  const frameAncestors = o.frameAncestors || "'self'";
  const log = o.log || (() => {});
  const clients = new Set();
  let port = 0;
  let version = crypto.randomBytes(6).toString('hex');
  const clientTag = `<script src="/__cj/client.js" data-cj-client data-cj-token="${token}"></script>`;

  const allowedHosts = () => new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://${HOST}:${port}`, `http://localhost:${port}`]);

  function baseHeaders(extra = {}) {
    return {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    };
  }

  function reply(res, status, body = '', headers = {}) {
    const buf = Buffer.from(body);
    res.writeHead(status, baseHeaders({
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, ...headers,
    }));
    res.end(res.req.method === 'HEAD' ? undefined : buf);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.removeAllListeners('data');
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handleOpen(req, res) {
    if (req.method !== 'POST') return reply(res, 405, 'method not allowed', { Allow: 'POST' });
    if (!allowedOrigins().has(req.headers.origin || '')) return reply(res, 403, 'bad origin');
    if (!safeEqual(req.headers['x-cj-token'] || '', token)) return reply(res, 403, 'bad token');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return reply(res, 415, 'json only');
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      res.setHeader('Connection', 'close');
      return reply(res, err.status || 400, 'bad request');
    }
    let loc;
    try {
      loc = decodeLoc(JSON.parse(raw.toString('utf8')).loc);
    } catch {
      return reply(res, 400, 'bad json');
    }
    if (!loc) return reply(res, 400, 'bad location');
    const found = await resolveInRoot(realRoot, loc.rel);
    if (found.status) return reply(res, found.status, 'not allowed');
    if (!found.stat.isFile() || !isHtmlPath(found.real)) return reply(res, 404, 'not found');
    if (o.onJump) {
      try {
        await o.onJump({
          file: found.real,
          rel: path.relative(realRoot, found.real).split(path.sep).join('/'),
          line: loc.line,
          col: loc.col,
        });
      } catch (err) {
        log(`Jump failed: ${err.message}`);
        return reply(res, 500, 'jump failed');
      }
    }
    res.writeHead(204, baseHeaders());
    return res.end();
  }

  function handleEvents(req, res, query) {
    if (req.method !== 'GET') return reply(res, 405, 'method not allowed');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin)) return reply(res, 403, 'bad origin');
    if (!safeEqual(query.get('token') || '', token)) return reply(res, 403, 'bad token');
    if (clients.size >= MAX_SSE_CLIENTS) return reply(res, 503, 'too many connections');
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }));
    res.write(`event: hello\ndata: ${version}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }

  async function serveFile(req, res, real, stat) {
    const ext = path.extname(real).toLowerCase();
    if (isHtmlPath(real) && stat.size <= MAX_INSTRUMENT_BYTES) {
      const src = await fsp.readFile(real);
      const rel = path.relative(realRoot, real).split(path.sep).join('/');
      const out = instrument(src, rel, { clientTag });
      res.writeHead(200, baseHeaders({
        'Content-Type': out.charset ? `text/html; charset=${out.charset}` : 'text/html',
        'Content-Length': out.body.length,
        'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
      }));
      res.end(req.method === 'HEAD' ? undefined : out.body);
      return;
    }
    const type = MIME[ext] || 'application/octet-stream';
    const headers = baseHeaders({ 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    if (isHtmlPath(real)) headers['Content-Security-Policy'] = `frame-ancestors ${frameAncestors}`;
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(stat.size - Number(range[2]), 0);
      }
      if (start > end || start >= stat.size) {
        return reply(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${stat.size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || stat.size === 0) return res.end();
    const stream = fs.createReadStream(real, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return undefined;
  }

  async function handle(req, res) {
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) {
      return reply(res, 403, 'bad host');
    }
    const rawUrl = req.url || '/';
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return reply(res, 400, 'bad request');
    const q = rawUrl.indexOf('?');
    const rawPath = (q < 0 ? rawUrl : rawUrl.slice(0, q)).split('#')[0];
    const query = new URLSearchParams(q < 0 ? '' : rawUrl.slice(q + 1));

    if (rawPath === '/__cj/open') return handleOpen(req, res);
    if (rawPath === '/__cj/events') return handleEvents(req, res, query);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }

    // Other sites may not pull files from this server as subresources.
    const site = req.headers['sec-fetch-site'];
    const dest = req.headers['sec-fetch-dest'];
    if ((site === 'cross-site' || site === 'same-site') && dest !== 'document' && dest !== 'iframe') {
      return reply(res, 403, 'cross-site request blocked');
    }

    if (rawPath === '/__cj/client.js') {
      res.writeHead(200, baseHeaders({
        'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': CLIENT_SOURCE.length,
      }));
      return res.end(req.method === 'HEAD' ? undefined : CLIENT_SOURCE);
    }

    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return reply(res, 400, 'bad path');
    }
    let found = await resolveInRoot(realRoot, decoded);
    if (found.status) return reply(res, found.status, found.status === 404 ? 'not found' : 'forbidden');
    if (found.stat.isDirectory()) {
      if (!rawPath.endsWith('/')) {
        return reply(res, 301, 'moved', { Location: `${rawPath}/${q < 0 ? '' : rawUrl.slice(q)}` });
      }
      let index = null;
      for (const name of ['index.html', 'index.htm']) {
        const candidate = await resolveInRoot(realRoot, path.posix.join(decoded, name));
        if (!candidate.status && candidate.stat.isFile()) { index = candidate; break; }
      }
      if (!index) return reply(res, 404, 'No index.html in this folder.');
      found = index;
    }
    if (!found.stat.isFile()) return reply(res, 404, 'not found');
    return serveFile(req, res, found.real, found.stat);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`Request failed: ${err.message}`);
      if (!res.headersSent) reply(res, 500, 'server error');
      else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 100;

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onOk); reject(err); };
    const onOk = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(p, HOST);
  });

  if (o.port !== undefined && o.port !== null) {
    await listen(o.port);
  } else {
    let bound = false;
    for (let p = DEFAULT_PORTS.first; p <= DEFAULT_PORTS.last && !bound; p++) {
      try {
        await listen(p);
        bound = true;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      }
    }
    if (!bound) await listen(0);
  }
  port = server.address().port;

  // Change detection by polling: works the same on every OS and network drive.
  const signal = { stopped: false };
  const baseInterval = o.watchIntervalMs || 300;
  let timer = null;
  let lastDigest = null;
  let warnedCap = false;

  const broadcast = () => {
    version = crypto.randomBytes(6).toString('hex');
    for (const c of clients) c.write(`event: reload\ndata: ${version}\n\n`);
  };

  const tick = async () => {
    const began = Date.now();
    const sig = await walkSignature(realRoot, signal);
    if (signal.stopped || !sig) return;
    if (sig.capped && !warnedCap) {
      warnedCap = true;
      log(`More than ${MAX_WATCHED_FILES} files here. Live reload only watches the first ${MAX_WATCHED_FILES}.`);
    }
    if (lastDigest !== null && sig.digest !== lastDigest) broadcast();
    lastDigest = sig.digest;
    const took = Date.now() - began;
    timer = setTimeout(tick, Math.max(baseInterval, took * 3));
    timer.unref();
  };
  await tick();

  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);
  heartbeat.unref();

  let closed = null;
  function close() {
    if (closed) return closed;
    signal.stopped = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    for (const c of clients) c.end();
    clients.clear();
    closed = new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closed;
  }

  return {
    port,
    token,
    root: realRoot,
    origin: `http://${HOST}:${port}`,
    /** URL for a file inside root. */
    urlFor(file) {
      const rel = path.relative(realRoot, fs.realpathSync(file)).split(path.sep);
      return `http://${HOST}:${port}/${rel.map(encodeURIComponent).join('/')}`;
    },
    close,
  };
}

module.exports = { startServer, isInside, isHtmlPath, HOST, DEFAULT_PORTS, MAX_BODY };
