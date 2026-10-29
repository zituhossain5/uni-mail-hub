// Private bridge from the host's dev frontend to the existing live API.
// Docker network DNS resolves the API again after container recreation.
import http from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const upstream = new URL(process.env.DEV_LIVE_API_UPSTREAM || 'http://uni-mail-hub-api:4000');
if (upstream.protocol !== 'http:' || upstream.hostname !== 'uni-mail-hub-api' || upstream.port !== '4000') {
  throw new Error('The dev bridge must use the existing private Uni Mail Hub API.');
}

http.createServer((request, response) => {
  if (!request.url?.startsWith('/api/v1/')) {
    response.writeHead(404, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    response.end(JSON.stringify({ message:'API route required' }));
    return;
  }
  const forwarded = http.request({
    hostname:upstream.hostname,
    port:upstream.port,
    method:request.method,
    path:request.url,
    headers:{ ...request.headers, host:upstream.host, connection:'close' },
    timeout:30000,
  }, incoming => {
    response.writeHead(incoming.statusCode || 502, { ...incoming.headers, 'cache-control':'private, no-store' });
    incoming.on('error', () => response.destroy());
    incoming.pipe(response);
  });
  forwarded.on('timeout', () => forwarded.destroy(new Error('Live API timeout')));
  forwarded.on('error', () => {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(502, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    response.end(JSON.stringify({ code:'LIVE_API_UNAVAILABLE', message:'The live API is unavailable. Try again shortly.' }));
  });
  request.on('aborted', () => forwarded.destroy());
  response.on('close', () => { if (!response.writableFinished) forwarded.destroy(); });
  request.pipe(forwarded);
}).listen(4000,'0.0.0.0');
