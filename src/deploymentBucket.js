'use strict';

/**
 * Serverless v4 keeps artifacts in one shared bucket per account and region
 * ("serverless-framework-deployments-<region>-<id>"), created and read through an AWS SDK v3
 * client that addresses it virtual-host style - "<bucket>.localhost" against an emulator, which
 * does not resolve on Linux or WSL2 and is not what Floci serves in any case.
 *
 * The framework still supports the older behaviour, a deployment bucket per stack reached
 * through `provider.request` (aws-sdk v2, path style), and selects it with:
 *
 *   isLegacyDeploymentBucketEnabled = options['enable-legacy-deployment-bucket']
 *     || process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET
 *     || provider.enableLegacyDeploymentBucket
 *
 * The provider reads that once, in its own constructor, which has already run by the time a
 * plugin exists - so set the resolved flag on the provider as well as the configuration.
 *
 * A project that names its own `provider.deploymentBucket` is left alone: that short-circuits
 * the global bucket anyway, and the bucket is the user's to manage.
 */
const useStackDeploymentBucket = (serverless, { force = false } = {}) => {
  const service = serverless.service || {};
  const providerConfig = service.provider || {};

  if (providerConfig.deploymentBucket && !force) return { changed: false, reason: 'deploymentBucket is set' };
  if (providerConfig.enableLegacyDeploymentBucket === false && !force) {
    return { changed: false, reason: 'enableLegacyDeploymentBucket is false' };
  }
  if (providerConfig.enableLegacyDeploymentBucket && !force) {
    return { changed: false, reason: 'already enabled' };
  }

  providerConfig.enableLegacyDeploymentBucket = true;
  process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET = process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET || 'true';

  const provider = serverless.getProvider && serverless.getProvider('aws');
  if (provider) provider.isLegacyDeploymentBucketEnabled = true;

  return { changed: true };
};

module.exports = { useStackDeploymentBucket };
