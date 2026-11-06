'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ServerlessFloci = require('../src/index');

const HEALTH = { version: '2.3.0', edition: 'community', services: { s3: 'running', lambda: 'running' } };

const fakeServerless = (custom, { serviceDir = '/srv/app', functions = {} } = {}) => ({
  service: {
    custom,
    provider: { stage: 'local', region: 'eu-west-1', compiledCloudFormationTemplate: { Resources: functions } }
  },
  serviceDir,
  configurationFilename: 'serverless.yml',
  classes: { Error },
  cli: { log: () => {} }
});

/** Run a body with process.env restored afterwards, whatever happens. */
const withEnv = (vars, body) => {
  const saved = { ...process.env };
  for (const key of ['AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'FLOCI_URL', 'FLOCI_PORT']) {
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return body();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
};

test('an active plugin sets AWS_ENDPOINT_URL and dummy credentials for the SDK', () => {
  withEnv({}, () => {
    const plugin = new ServerlessFloci(fakeServerless({ floci: { url: 'http://localhost:4599', stages: ['local'] } }), { stage: 'local' });
    assert.equal(plugin.active, true);
    assert.equal(process.env.AWS_ENDPOINT_URL, 'http://localhost:4599');
    assert.equal(process.env.AWS_ACCESS_KEY_ID, 'test');
  });
});

test('real credentials in the environment are left alone', () => {
  withEnv({ AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'realsecret' }, () => {
    new ServerlessFloci(fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'] } }), { stage: 'local' });
    assert.equal(process.env.AWS_ACCESS_KEY_ID, 'AKIAREAL');
  });
});

test('an endpoint disagreement refuses at construction, before anything is deployed', () => {
  withEnv({ AWS_ENDPOINT_URL: 'http://localhost:4566' }, () => {
    assert.throws(
      () => new ServerlessFloci(fakeServerless({ floci: { url: 'http://localhost:4599', stages: ['local'] } }), { stage: 'local' }),
      /AWS_ENDPOINT_URL is http:\/\/localhost:4566 but custom\.floci\.url is http:\/\/localhost:4599/
    );
  });
});

test('an inactive stage touches neither the environment nor the template', () => {
  withEnv({}, () => {
    const plugin = new ServerlessFloci(fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'] } }), { stage: 'prod' });
    assert.equal(plugin.active, false);
    assert.equal(process.env.AWS_ENDPOINT_URL, undefined);
  });
});

test('mountCode points functions at the working directory via the hot-reload bucket', () => {
  withEnv({}, () => {
    const resources = {
      ApiFn: { Type: 'AWS::Lambda::Function', Properties: { Code: { S3Bucket: 'deploy-bucket', S3Key: 'a/b.zip' } } },
      Role: { Type: 'AWS::IAM::Role', Properties: {} }
    };
    const plugin = new ServerlessFloci(
      fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'], lambda: { mountCode: true } } },
        { functions: resources }),
      { stage: 'local' }
    );
    plugin.mountLambdaCode();
    assert.deepEqual(resources.ApiFn.Properties.Code, { S3Bucket: 'hot-reload', S3Key: '/srv/app' });
    assert.deepEqual(resources.Role.Properties, {}, 'non-Lambda resources are untouched');
  });
});

test('a container-image function is never remapped to a code mount', () => {
  withEnv({}, () => {
    const resources = {
      ImageFn: { Type: 'AWS::Lambda::Function', Properties: { PackageType: 'Image', Code: { ImageUri: 'repo:tag' } } }
    };
    const plugin = new ServerlessFloci(
      fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'], lambda: { mountCode: true } } },
        { functions: resources }),
      { stage: 'local' }
    );
    plugin.mountLambdaCode();
    assert.deepEqual(resources.ImageFn.Properties.Code, { ImageUri: 'repo:tag' });
  });
});

test('mountCode given a subdirectory resolves it against the service directory', () => {
  withEnv({}, () => {
    const resources = { Fn: { Type: 'AWS::Lambda::Function', Properties: { Code: {} } } };
    const plugin = new ServerlessFloci(
      fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'], lambda: { mountCode: '.build' } } },
        { functions: resources }),
      { stage: 'local' }
    );
    plugin.mountLambdaCode();
    assert.equal(resources.Fn.Properties.Code.S3Key, path.join('/srv/app', '.build'));
  });
});

test('${floci:...} serves the endpoint and what the instance reports', async () => {
  await withEnv({}, async () => {
    const plugin = new ServerlessFloci(fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'] } }), { stage: 'local' });
    plugin.healthPromise = Promise.resolve(HEALTH);
    assert.deepEqual(await plugin.resolveFlociVariable({ address: 'url' }), { value: 'http://localhost:4566' });
    assert.deepEqual(await plugin.resolveFlociVariable({ address: 'version' }), { value: '2.3.0' });
    assert.deepEqual(await plugin.resolveFlociVariable({ address: 'services' }), { value: 'lambda,s3' });
    await assert.rejects(plugin.resolveFlociVariable({ address: 'nope' }), /unknown variable/);
  });
});

test('a required service that is missing stops the deployment at activation', async () => {
  await withEnv({}, async () => {
    const plugin = new ServerlessFloci(
      fakeServerless({ floci: { url: 'http://localhost:4566', stages: ['local'], health: { require: ['rds-data'] } } }),
      { stage: 'local' }
    );
    plugin.healthPromise = Promise.resolve(HEALTH);
    await assert.rejects(plugin.activate(), /rds-data: not offered by this Floci build/);
  });
});
