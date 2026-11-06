'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fetchHealth, assertServices, runningServices, describe } = require('../src/health');

const HEALTH = {
  version: '2.3.0',
  edition: 'community',
  services: { s3: 'running', sqs: 'running', lambda: 'running', kafka: 'stopped' }
};

const respondWith = (routes) => async (url) => {
  const path = new URL(url).pathname;
  if (!(path in routes)) return { ok: false, status: 404 };
  const body = routes[path];
  return { ok: true, status: 200, json: async () => body };
};

test('the Floci health path is preferred over the LocalStack-compatible one', async () => {
  const health = await fetchHealth('http://localhost:4566', {
    fetchImpl: respondWith({ '/_floci/health': HEALTH, '/_localstack/health': { version: 'wrong' } })
  });
  assert.equal(health.version, '2.3.0');
  assert.equal(health.path, '/_floci/health');
});

test('an older Floci that only serves the LocalStack path still works', async () => {
  const health = await fetchHealth('http://localhost:4566', {
    fetchImpl: respondWith({ '/_localstack/health': HEALTH })
  });
  assert.equal(health.version, '2.3.0');
  assert.equal(health.path, '/_localstack/health');
});

test('an unreachable instance names the endpoint and how to start one', async () => {
  await assert.rejects(
    fetchHealth('http://localhost:4599', {
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); }
    }),
    (err) => {
      assert.match(err.message, /no Floci instance answered at http:\/\/localhost:4599/);
      assert.match(err.message, /docker compose up -d/);
      return true;
    }
  );
});

test('a hung instance is abandoned rather than hanging the deployment', async () => {
  await assert.rejects(
    fetchHealth('http://localhost:4566', {
      timeout: 20,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
    }),
    /no answer within 20ms/
  );
});

test('a required service that is not running fails, and is named', () => {
  assert.throws(
    () => assertServices(HEALTH, ['s3', 'kafka', 'rds-data']),
    (err) => {
      assert.match(err.message, /- kafka: stopped/);
      assert.match(err.message, /- rds-data: not offered by this Floci build/);
      assert.doesNotMatch(err.message, /- s3:/, 's3 is running and should not be reported');
      return true;
    }
  );
});

test('requiring nothing, or only running services, passes', () => {
  assert.deepEqual(assertServices(HEALTH, []), []);
  assert.deepEqual(assertServices(HEALTH, undefined), []);
  assert.deepEqual(assertServices(HEALTH, ['s3', 'LAMBDA']), []);
});

test('runningServices leaves out what is not running', () => {
  assert.deepEqual(runningServices(HEALTH), ['lambda', 's3', 'sqs']);
  assert.match(describe(HEALTH), /Floci 2\.3\.0 \(community\), 3 services running/);
});
