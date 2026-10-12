import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { services, networks } = JSON.parse(input);
const traefik = process.argv.includes('--traefik');

const names = service => Object.keys(services[service].networks);
const hasNetworks = (service, expected) => {
  assert.deepEqual(names(service).sort(), expected.sort(), `${service} network membership changed`);
};
const hasAlias = (service, network, alias) => {
  assert.ok(services[service].networks[network]?.aliases?.includes(alias), `${service} needs ${alias} on ${network}`);
};
const hasHost = (value, expected, label) => {
  assert.equal(new URL(value).hostname, expected, `${label} must use the unique internal DNS alias`);
};

hasAlias('api', 'front', 'uni-mail-hub-api');
hasAlias('postgres', 'back', 'uni-mail-hub-postgres');
hasAlias('redis', 'back', 'uni-mail-hub-redis');
const example = readFileSync('.env.production.example', 'utf8');
assert.match(example, /^API_URL=http:\/\/uni-mail-hub-api:4000$/m);
assert.match(example, /^DATABASE_URL=postgresql:\/\/[^\r\n]+@uni-mail-hub-postgres:5432\//m);
assert.match(example, /^REDIS_URL=redis:\/\/uni-mail-hub-redis:6379$/m);
const nginx = readFileSync('deploy/nginx/uni-mail-hub.conf', 'utf8');
assert.equal((nginx.match(/proxy_pass http:\/\/uni-mail-hub-api:4000;/g) ?? []).length, 3);
assert.doesNotMatch(nginx, /proxy_pass http:\/\/api:4000;/);
hasNetworks('postgres', ['back']);
hasNetworks('redis', ['back']);
hasNetworks('worker', ['back', 'egress']);
hasNetworks('ops', ['front', 'back']);
hasHost(services.web.environment.API_URL, 'uni-mail-hub-api', 'API_URL');
for (const service of ['api', 'worker', 'ops']) {
  hasHost(services[service].environment.DATABASE_URL, 'uni-mail-hub-postgres', `${service} DATABASE_URL`);
  hasHost(services[service].environment.REDIS_URL, 'uni-mail-hub-redis', `${service} REDIS_URL`);
}
for (const service of ['web', 'api', 'worker', 'postgres', 'redis', 'ops']) {
  assert.ok(!services[service].ports?.length, `${service} must not publish a port`);
  assert.ok(!services[service].container_name, `${service} must not set container_name`);
}

if (traefik) {
  assert.ok(!services['reverse-proxy'], 'built-in proxy must be disabled with Traefik');
  assert.equal(networks.app_plane?.external, true, 'app_plane must be an existing external network');
  hasNetworks('web', ['front', 'app_plane']);
  hasNetworks('api', ['front', 'back', 'app_plane']);
  for (const service of ['web', 'api']) {
    assert.equal(services[service].labels['traefik.docker.network'], 'app_plane');
    assert.equal(services[service].labels['traefik.enable'], 'true');
  }
  assert.ok(!services.api.networks.app_plane?.aliases?.includes('uni-mail-hub-api'), 'API alias belongs on front only');
} else {
  assert.ok(services['reverse-proxy'], 'standalone Nginx must remain available');
  hasNetworks('web', ['front']);
  hasNetworks('api', ['front', 'back']);
}

console.log(`OK ${traefik ? 'Traefik' : 'standalone'} Compose DNS aliases and network isolation`);
