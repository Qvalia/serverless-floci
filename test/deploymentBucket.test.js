'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useStackDeploymentBucket } = require('../src/deploymentBucket');
const { applySdkEndpoint, serviceIdentifiers } = require('../src/sdk');

const fakeServerless = (providerConfig = {}) => {
  const provider = { isLegacyDeploymentBucketEnabled: undefined };
  return {
    service: { provider: providerConfig },
    getProvider: () => provider,
    _provider: provider
  };
};

const withEnv = (body) => {
  const saved = process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET;
  delete process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET;
    else process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET = saved;
  }
};

test('the per-stack deployment bucket is selected, on the config and on the provider', () => {
  withEnv(() => {
    const serverless = fakeServerless({});
    const result = useStackDeploymentBucket(serverless);
    assert.equal(result.changed, true);
    assert.equal(serverless.service.provider.enableLegacyDeploymentBucket, true);
    // The provider read the flag in its own constructor, before this plugin existed, so the
    // resolved value has to be set too or the choice is made from the stale one.
    assert.equal(serverless._provider.isLegacyDeploymentBucketEnabled, true);
    assert.equal(process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET, 'true');
  });
});

test('a project that names its own deployment bucket is left alone', () => {
  withEnv(() => {
    const serverless = fakeServerless({ deploymentBucket: 'my-bucket' });
    const result = useStackDeploymentBucket(serverless);
    assert.equal(result.changed, false);
    assert.equal(serverless.service.provider.enableLegacyDeploymentBucket, undefined);
    assert.equal(process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET, undefined);
  });
});

test('an explicit opt-out is respected', () => {
  withEnv(() => {
    const serverless = fakeServerless({ enableLegacyDeploymentBucket: false });
    assert.equal(useStackDeploymentBucket(serverless).changed, false);
    assert.equal(serverless._provider.isLegacyDeploymentBucketEnabled, undefined);
  });
});

test('service endpoints are read off the SDK rather than from a hardcoded list', () => {
  const sdk = {
    config: { update(values) { Object.assign(this, values); }, credentials: null },
    Credentials: function Credentials(c) { Object.assign(this, c); },
    S3: Object.assign(function S3() {}, { serviceIdentifier: 's3' }),
    CloudFormation: Object.assign(function CloudFormation() {}, { serviceIdentifier: 'cloudformation' }),
    STS: Object.assign(function STS() {}, { serviceIdentifier: 'sts' }),
    util: {},
    VERSION: '2.1693.0'
  };
  assert.deepEqual(serviceIdentifiers(sdk).sort(), ['cloudformation', 's3', 'sts']);

  const provider = { sdk };
  assert.equal(applySdkEndpoint(provider, { endpoint: 'http://localhost:4599', region: 'eu-west-1' }), true);
  assert.equal(sdk.config.endpoint, 'http://localhost:4599');
  assert.equal(sdk.config.s3ForcePathStyle, true);
  assert.equal(sdk.config.sslEnabled, false);
  assert.deepEqual(sdk.config.sts, { endpoint: 'http://localhost:4599' });
  assert.equal(sdk.config.credentials.accessKeyId, 'test');
});

test('existing SDK credentials are not replaced', () => {
  const sdk = {
    config: { update(values) { Object.assign(this, values); }, credentials: { accessKeyId: 'AKIAREAL' } },
    Credentials: function Credentials(c) { Object.assign(this, c); }
  };
  applySdkEndpoint({ sdk }, { endpoint: 'http://localhost:4566', region: 'eu-west-1' });
  assert.equal(sdk.config.credentials.accessKeyId, 'AKIAREAL');
});

test('a provider without the bundled SDK is reported rather than crashing', () => {
  assert.equal(applySdkEndpoint({}, { endpoint: 'http://localhost:4566' }), false);
  assert.equal(applySdkEndpoint({ sdk: {} }, { endpoint: 'http://localhost:4566' }), false);
});
