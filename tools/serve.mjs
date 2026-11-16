#!/usr/bin/env node
/*
 * Dependency-free static server for local development.
 *
 * Web Bluetooth requires a secure context. http://localhost counts as one, so
 * this server is all you need. No HTTPS certificate required for localhost.
 *
 *   node tools/serve.mjs [port]
 *
 * The UI is served from web/. Docs and the bridge folder are also exposed so
 * the in-app links work without leaving the server.
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

function chooseBase(pathname) {
  if (
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    pathname === '/bridge' ||
    pathname.startsWith('/bridge/') ||
    pathname === '/README.md' ||
    pathname === '/LICENSE'
  ) {
    return ROOT;
  }
  return WEB;
}

async function resolveFile(pathname) {
  const base = chooseBase(pathname);
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(base, relative || 'index.html');

  // Path traversal guard: the resolved file must stay inside its base.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) return null;

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try {
      const indexStat = await fs.stat(index);
      if (indexStat.isFile()) return { file: index, size: indexStat.size };
    } catch {
      return null;
    }
    return null;
  }

  return stat.isFile() ? { file: target, size: stat.size } : null;
}

const server = createServer(async (request, response) => {
  const started = Date.now();
  let pathname = '/';

  try {
    const url = new URL(request.url || '/', 'http://localhost');
    pathname = url.pathname === '/' ? '/index.html' : url.pathname;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method Not Allowed');
      return;
    }

    const found = await resolveFile(pathname);
    if (!found) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found: ' + pathname);
      log(404, pathname, started);
      return;
    }

    const type = MIME[path.extname(found.file).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': found.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    if (request.method === 'HEAD') {
      response.end();
    } else {
      createReadStream(found.file).pipe(response);
    }
    log(200, pathname, started);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Server error: ' + error.message);
    log(500, pathname, started);
  }
});

function log(status, pathname, started) {
  const ms = Date.now() - started;
  console.log(`${status}  ${pathname}  ${ms}ms`);
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  RoninS-Ctrl-Plus');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Open it in Chrome or Edge. Web Bluetooth needs a secure context,');
  console.log('  and http://localhost is one. Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node tools/serve.mjs ${PORT + 1}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
