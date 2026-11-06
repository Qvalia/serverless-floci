'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { readConfig, isActive, resolveEndpoint, assertEndpointAgreement, toOrigin } = require('../src/config');

const serverlessWith = (custom, provider = {}) => ({
  service: { custom, provider: { stage: 'local', ...provider } },
  classes: { Error }
});

test('toOrigin accepts a bare host, a host:port and a full URL', () => {
  assert.equal(toOrigin('localhost', 4566), 'http://localhost:4566');
  assert.equal(toOrigin('localhost:4599', 4566), 'http://localhost:4599');
  assert.equal(toOrigin('http://127.0.0.1:4599/', 4566), 'http://127.0.0.1:4599');
  assert.equal(toOrigin('https://floci.internal:443', 4566), 'https://floci.internal');
  assert.equal(toOrigin(undefined, 4566), undefined);
  assert.equal(toOrigin('   ', 4566), undefined);
});

test('a port given in config applies to a host that carries none', () => {
  const { url } = resolveEndpoint({ host: 'localhost', port: 4599 }, {});
  assert.equal(url, 'http://localhost:4599');
});

test('an explicit url in serverless.yml beats AWS_ENDPOINT_URL', () => {
  // This is the inverse of serverless-localstack, where the environment silently won.
  const { url, source } = resolveEndpoint(
    { url: 'http://localhost:4599' },
    { AWS_ENDPOINT_URL: 'http://localhost:4566' }
  );
  assert.equal(url, 'http://localhost:4599');
  assert.equal(source, 'custom.floci.url');
});

test('FLOCI_PORT is honoured when nothing in the yaml names an address', () => {
  const { url, source } = resolveEndpoint({}, { FLOCI_PORT: '4599' });
  assert.equal(url, 'http://localhost:4599');
  assert.equal(source, 'FLOCI_PORT');
});

test('the endpoint falls back to localhost:4566, and says it is a default', () => {
  const { url, source } = resolveEndpoint({}, {});
  assert.equal(url, 'http://localhost:4566');
  assert.equal(source, 'default');
});

test('a disagreement between AWS_ENDPOINT_URL and the configured endpoint is reported', () => {
  const message = assertEndpointAgreement(
    { url: 'http://localhost:4599', source: 'custom.floci.url' },
    { AWS_ENDPOINT_URL: 'http://localhost:4566' }
  );
  assert.ok(message, 'expected a disagreement to be reported');
  assert.match(message, /AWS_ENDPOINT_URL is http:\/\/localhost:4566/);
  assert.match(message, /custom\.floci\.url is http:\/\/localhost:4599/);
});

test('agreement, or an endpoint that came from AWS_ENDPOINT_URL itself, is not a disagreement', () => {
  assert.equal(
    assertEndpointAgreement({ url: 'http://localhost:4566', source: 'custom.floci.url' },
      { AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    null
  );
  assert.equal(
    assertEndpointAgreement({ url: 'http://localhost:4566', source: 'AWS_ENDPOINT_URL' },
      { AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    null
  );
  assert.equal(
    assertEndpointAgreement({ url: 'http://localhost:4566', source: 'default' }, {}),
    null
  );
});

test('custom.localstack is read, so a project migrates by renaming the plugin', () => {
  const config = readConfig(
    serverlessWith({ localstack: { edgePort: 4599, stages: ['local'], lambda: { mountCode: true } } }),
    { stage: 'local' },
    {}
  );
  assert.equal(config.endpoint, 'http://localhost:4599');
  assert.equal(config.mountCode, '');
  assert.equal(config.usedLegacyKey, true);
  assert.ok(isActive(config));
});

test('custom.floci wins over a custom.localstack left in place', () => {
  const config = readConfig(
    serverlessWith({
      localstack: { edgePort: 4566, stages: ['local'] },
      floci: { port: 4599, stages: ['local'] }
    }),
    { stage: 'local' },
    {}
  );
  assert.equal(config.endpoint, 'http://localhost:4599');
  assert.equal(config.usedLegacyKey, false);
});

test('a stage outside the list leaves the plugin inactive', () => {
  const config = readConfig(
    serverlessWith({ floci: { stages: ['local'] } }),
    { stage: 'prod' },
    {}
  );
  assert.equal(isActive(config), false);
});

test('with no stages listed, the plugin engages only if something named an instance', () => {
  // serverless-localstack activates on stage "dev" by default, which catches real deployments.
  const unnamed = readConfig(serverlessWith({ floci: {} }), { stage: 'dev' }, {});
  assert.equal(isActive(unnamed), false);

  const named = readConfig(serverlessWith({ floci: { url: 'http://localhost:4566' } }), { stage: 'dev' }, {});
  assert.equal(isActive(named), true);
});
