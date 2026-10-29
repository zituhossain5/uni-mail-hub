import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedRequestOrigin } from '../apps/web/src/lib/request-origin';

const webUrl = 'http://192.0.2.10:4395';
const requestUrl = 'http://0.0.0.0:4395/api/v1/auth/login';

function request(origin?: string, host?: string, extraHeaders: Record<string, string> = {}, url = requestUrl) {
  return new Request(url, { headers: {
    ...(origin === undefined ? {} : { origin }),
    ...(host === undefined ? {} : { host }),
    ...extraHeaders,
  } });
}

test('the configured origin remains valid in every environment', () => {
  for (const environment of ['development', 'test', 'production', undefined]) {
    assert.equal(allowedRequestOrigin(request(webUrl, '192.0.2.10:4395'), webUrl, environment), true);
  }
  assert.equal(allowedRequestOrigin(request('https://mail.example.com', 'mail.example.com'), 'https://mail.example.com/', 'production'), true);
});

test('development accepts matching loopback Hosts across SSH-forwarded ports', () => {
  for (const host of ['localhost:1337', 'localhost:4395', '127.0.0.1:1337', '127.0.0.1:4395', '[::1]:1337', 'localhost']) {
    assert.equal(allowedRequestOrigin(request(`http://${host}`, host), webUrl, 'development'), true, host);
  }
  assert.equal(allowedRequestOrigin(request('https://localhost:1337', 'localhost:1337', {}, 'https://0.0.0.0:4395/api/v1/auth/login'), webUrl, 'development'), true);
});

test('loopback access is limited to development', () => {
  for (const environment of ['production', 'test', undefined]) {
    assert.equal(allowedRequestOrigin(request('http://localhost:1337', 'localhost:1337'), webUrl, environment), false);
  }
});

test('development rejects cross-origin ports, loopback aliases, hosts and protocols', () => {
  for (const [origin, host] of [
    ['http://localhost:3000', 'localhost:1337'],
    ['http://127.0.0.1:1337', 'localhost:1337'],
    ['http://localhost:1337', '192.0.2.10:4395'],
    ['http://localhost:1337', 'untrusted.example:1337'],
    ['http://untrusted.example:1337', 'untrusted.example:1337'],
    ['http://localhost.untrusted.example:1337', 'localhost.untrusted.example:1337'],
    ['http://192.0.2.20:1337', '192.0.2.20:1337'],
    ['https://localhost:1337', 'localhost:1337'],
    ['ftp://localhost:1337', 'localhost:1337'],
  ]) {
    assert.equal(allowedRequestOrigin(request(origin, host), webUrl, 'development'), false, `${origin} -> ${host}`);
  }
});

test('missing or malformed origins, Hosts and configuration fail closed', () => {
  for (const origin of [undefined, '', 'null', 'invalid', 'http://localhost:1337/path', 'http://user@localhost:1337', 'http://localhost:1337#fragment']) {
    assert.equal(allowedRequestOrigin(request(origin, 'localhost:1337'), webUrl, 'development'), false, String(origin));
  }
  for (const host of [undefined, '', 'user@localhost:1337', 'localhost:1337, untrusted.example']) {
    assert.equal(allowedRequestOrigin(request('http://localhost:1337', host), webUrl, 'development'), false, String(host));
  }
  for (const configured of [undefined, '', 'invalid']) {
    assert.equal(allowedRequestOrigin(request('http://localhost:1337', 'localhost:1337'), configured, 'development'), false);
  }
});

test('forwarded headers cannot bypass a mismatched Host or production policy', () => {
  const headers = { 'x-forwarded-host': 'localhost:1337', 'x-forwarded-proto': 'http' };
  assert.equal(allowedRequestOrigin(request('http://localhost:1337', 'untrusted.example', headers), webUrl, 'development'), false);
  assert.equal(allowedRequestOrigin(request('http://localhost:1337', 'localhost:1337', headers), webUrl, 'production'), false);
});
