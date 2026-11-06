'use strict';

const HEALTH_PATHS = ['/_floci/health', '/_localstack/health'];

/**
 * Ask a Floci instance what it is running. Floci serves this under its own prefix and, for
 * wire compatibility, under LocalStack's; try ours first so the answer is unambiguous.
 */
const fetchHealth = async (endpoint, { timeout = 5000, fetchImpl = globalThis.fetch } = {}) => {
  const errors = [];
  for (const path of HEALTH_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${endpoint}${path}`, { signal: controller.signal });
      if (!response.ok) {
        errors.push(`${path} answered ${response.status}`);
        continue;
      }
      return { ...(await response.json()), path };
    } catch (err) {
      errors.push(`${path}: ${err.name === 'AbortError' ? `no answer within ${timeout}ms` : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const detail = errors.join('; ');
  throw new Error(
    `serverless-floci: no Floci instance answered at ${endpoint} (${detail}).\n` +
    '  Start one with "docker compose up -d", or point custom.floci.url at the right address.'
  );
};

/**
 * Floci reports every service it knows, with a state per service. A service that is not
 * "running" fails the deployment here, with the service named, rather than surfacing later
 * as an opaque AWS error from the middle of a CloudFormation rollback.
 */
const assertServices = (health, required) => {
  if (!Array.isArray(required) || required.length === 0) return [];
  const services = health.services || {};
  const problems = required
    .map((name) => ({ name, state: services[String(name).toLowerCase()] }))
    .filter((entry) => entry.state !== 'running');

  if (problems.length === 0) return [];

  const lines = problems.map(({ name, state }) =>
    `  - ${name}: ${state === undefined ? 'not offered by this Floci build' : state}`);
  throw new Error(
    `serverless-floci: this stack requires services that are not available:\n${lines.join('\n')}\n` +
    `  Floci ${health.version || '?'} (${health.edition || '?'}) reported ${Object.keys(services).length} services.`
  );
};

/** Services this Floci runs, for callers that want to route by what is actually there. */
const runningServices = (health) =>
  Object.entries(health.services || {})
    .filter(([, state]) => state === 'running')
    .map(([name]) => name)
    .sort();

const describe = (health) =>
  `Floci ${health.version || '?'} (${health.edition || '?'}), ${runningServices(health).length} services running`;

module.exports = { fetchHealth, assertServices, runningServices, describe, HEALTH_PATHS };
