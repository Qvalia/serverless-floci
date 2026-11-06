'use strict';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 4566;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

const isTrue = (value) => value === true || TRUTHY.has(String(value).toLowerCase());

const FALSEY = new Set(['0', 'false', 'no', 'off', '']);

/**
 * mountCode is either a flag or a path: `true` mounts the service directory, a string mounts
 * that subdirectory of it. Returns the subdirectory, '' for the service directory itself, or
 * null when mounting is off.
 */
const mountCodePath = (value) => {
  if (value === undefined || value === null || value === false) return null;
  const raw = `${value}`.trim();
  if (FALSEY.has(raw.toLowerCase())) return null;
  return isTrue(raw) ? '' : raw;
};

/**
 * Normalise anything that could name a Floci instance into an origin.
 * Accepts "localhost", "localhost:4599", "http://localhost:4599", "http://localhost:4599/".
 */
const toOrigin = (value, fallbackPort) => {
  if (value === undefined || value === null || `${value}`.trim() === '') return undefined;
  const raw = `${value}`.trim();
  const withScheme = raw.includes('://') ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (err) {
    throw new Error(`serverless-floci: "${raw}" is not a usable Floci address: ${err.message}`);
  }
  // A scheme's default port is normalised away by URL ("https://h:443" -> port ""), so only
  // supply the fallback when the caller genuinely wrote no port.
  const hadExplicitPort = /:\d+(?:[/?#]|$)/.test(withScheme.slice(withScheme.indexOf('://') + 3));
  if (!url.port && !hadExplicitPort && fallbackPort) url.port = `${fallbackPort}`;
  return url.origin;
};

/**
 * Resolve where Floci is, and record which setting said so, so that a disagreement
 * can be reported against the names the user actually wrote.
 *
 * Precedence is deliberately the inverse of serverless-localstack's: what is written in
 * serverless.yml wins over the ambient environment. The environment is still consulted,
 * but a disagreement is an error rather than a silent override - see assertEndpointAgreement.
 */
const resolveEndpoint = (flociConfig, env) => {
  const port = flociConfig.port || env.FLOCI_PORT;

  const candidates = [
    ['custom.floci.url', flociConfig.url],
    ['custom.floci.host', flociConfig.host],
    ['FLOCI_URL', env.FLOCI_URL],
    ['FLOCI_PORT', env.FLOCI_PORT && `${DEFAULT_HOST}:${env.FLOCI_PORT}`],
    ['AWS_ENDPOINT_URL', env.AWS_ENDPOINT_URL]
  ];

  for (const [source, value] of candidates) {
    const origin = toOrigin(value, port || DEFAULT_PORT);
    if (origin) return { url: origin, source };
  }

  return { url: `http://${DEFAULT_HOST}:${port || DEFAULT_PORT}`, source: 'default' };
};

/**
 * `${ssm:}`, `${cf:}` and `${s3:}` are resolved by the framework before any plugin is
 * constructed, using AWS_ENDPOINT_URL alone (see SPIKE.md). If that variable disagrees with
 * where this plugin is about to deploy, then part of the run has already read one endpoint
 * and the rest will write to another. Nothing can repair that after the fact, so refuse.
 */
const assertEndpointAgreement = ({ url, source }, env) => {
  const ambient = toOrigin(env.AWS_ENDPOINT_URL);
  if (!ambient || source === 'AWS_ENDPOINT_URL' || ambient === url) return null;
  return (
    `serverless-floci: AWS_ENDPOINT_URL is ${ambient} but ${source} is ${url}.\n` +
    '  Variables such as ${ssm:...} are resolved by Serverless before this plugin loads, using\n' +
    `  AWS_ENDPOINT_URL, so they have already been read from ${ambient} while the deployment\n` +
    `  itself would go to ${url}. Point both at the same instance, or unset one of them.`
  );
};

const readConfig = (serverless, options = {}, env = process.env) => {
  const custom = (serverless.service || {}).custom || {};
  // custom.localstack is accepted so an existing project migrates by swapping the plugin name.
  const flociConfig = custom.floci || {};
  const legacy = custom.localstack || {};
  const merged = {
    ...legacy,
    ...flociConfig,
    // serverless-localstack spelled the port "edgePort"; honour it when no floci port is given.
    port: flociConfig.port || legacy.edgePort,
    stages: flociConfig.stages || legacy.stages,
    lambda: { ...(legacy.lambda || {}), ...(flociConfig.lambda || {}) }
  };

  const endpoint = resolveEndpoint(merged, env);
  const stage = options.stage || serverless.service.provider.stage || merged.stage;

  return {
    ...merged,
    usedLegacyKey: !custom.floci && Boolean(custom.localstack),
    endpoint: endpoint.url,
    endpointSource: endpoint.source,
    stage,
    mountCode: mountCodePath((merged.lambda || {}).mountCode),
    stages: merged.stages
  };
};

/**
 * Active when the running stage is listed, or when no stages are listed at all, in which case
 * the plugin only engages if something explicitly named a Floci instance. serverless-localstack
 * defaults to engaging on stage "dev", which surprises anyone whose real stage is called dev.
 */
const isActive = (config) => {
  if (Array.isArray(config.stages) && config.stages.length > 0) {
    return config.stages.map(String).includes(String(config.stage));
  }
  return config.endpointSource !== 'default';
};

module.exports = {
  readConfig, isActive, resolveEndpoint, assertEndpointAgreement, toOrigin, isTrue, mountCodePath, DEFAULT_PORT
};
