import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('dist');
const base = '/unkernel-emacs/';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') {
      response.writeHead(302, { Location: base }).end();
      return;
    }
    if (!pathname.startsWith(base)) throw new Error('Outside the preview path');
    const relativePath = pathname.slice(base.length);
    const file = resolve(root, pathname.endsWith('/') ? `${relativePath}index.html` : relativePath);
    if (!file.startsWith(root + sep)) throw new Error('Outside the build directory');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const { size } = info;
    const headers = { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (relativePath.startsWith('local-graphics/')) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    let start = 0;
    let end = size - 1;
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      start = range ? Number(range[1]) : size;
      end = range?.[2] ? Math.min(Number(range[2]), end) : end;
      if (start >= size || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    response.writeHead(request.headers.range ? 206 : 200, { ...headers, 'Content-Length': Math.max(0, end - start + 1) });
    if (request.method === 'HEAD' || size === 0) response.end();
    else createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(4173, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:4173${base}`);
});
