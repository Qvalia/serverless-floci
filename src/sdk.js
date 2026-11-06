'use strict';

/**
 * Serverless v4 carries two AWS SDKs and they need pointing at Floci separately.
 *
 *   * AWS SDK v3 (`@aws-sdk/client-*`) resolves `${ssm:}`, `${cf:}` and `${s3:}`. It reads
 *     AWS_ENDPOINT_URL from the environment, before any plugin exists. See SPIKE.md.
 *   * aws-sdk v2, exposed as `provider.sdk`, is what `provider.request` uses for the deployment
 *     itself - CloudFormation, S3, STS, ECR and the rest. It does *not* read AWS_ENDPOINT_URL,
 *     so it has to be configured here or the deployment reaches real AWS and is rejected with
 *     "The security token included in the request is invalid".
 */
/**
 * Every aws-sdk v2 service class carries its own config key as `serviceIdentifier` ("s3",
 * "cloudformation", "sts", ...). Reading them off the SDK that is actually loaded gives an
 * exhaustive, self-maintaining list - serverless-localstack hardcodes 68 names, which has
 * fallen behind both the SDK and the emulator.
 */
const serviceIdentifiers = (sdk) =>
  Object.values(sdk)
    .filter((value) => typeof value === 'function' && typeof value.serviceIdentifier === 'string')
    .map((value) => value.serviceIdentifier);

const applySdkEndpoint = (provider, { endpoint, region, accessKeyId = 'test', secretAccessKey = 'test' }) => {
  const sdk = provider && provider.sdk;
  if (!sdk || !sdk.config || typeof sdk.config.update !== 'function') return false;

  const update = {
    endpoint,
    region,
    // Floci serves buckets by path, as every emulator does; virtual-host style would need DNS.
    s3ForcePathStyle: true,
    sslEnabled: endpoint.startsWith('https:')
  };

  // aws-sdk v2 applies a global `endpoint` inconsistently, so set it per service as well.
  for (const identifier of serviceIdentifiers(sdk)) {
    update[identifier] = { endpoint, ...(identifier === 's3' ? { s3ForcePathStyle: true } : {}) };
  }

  // Only supply credentials when the environment has none, so a real profile is never shadowed.
  if (!sdk.config.credentials && typeof sdk.Credentials === 'function') {
    update.credentials = new sdk.Credentials({ accessKeyId, secretAccessKey });
  }

  sdk.config.update(update);

  // Some call sites build a client from cached credentials rather than from config.
  if (provider.cachedCredentials) provider.cachedCredentials.endpoint = endpoint;

  return true;
};

module.exports = { applySdkEndpoint, serviceIdentifiers };
