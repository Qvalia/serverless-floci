'use strict';

const fs = require('fs');
const path = require('path');

const { readConfig, isActive, assertEndpointAgreement } = require('./config');
const { fetchHealth, assertServices, runningServices, describe } = require('./health');
const { applySdkEndpoint } = require('./sdk');
const { useStackDeploymentBucket } = require('./deploymentBucket');

// Floci, like LocalStack, treats this bucket name as "the code is on disk at S3Key".
const HOT_RELOAD_BUCKET = 'hot-reload';

// Variables the framework resolves before any plugin is constructed. See SPIKE.md.
const EARLY_VARIABLE_PATTERN = /\$\{(ssm|cf|s3|aws):/;

class ServerlessFloci {
  constructor(serverless, options = {}) {
    this.serverless = serverless;
    this.options = options;
    this.log = this.buildLogger();

    this.config = readConfig(serverless, options);
    this.active = isActive(this.config);

    // A source name of our own. Unlike `ssm`, a non-built-in name is ours to define, because
    // plugin sources are registered before the pass that resolves them.
    this.configurationVariablesSources = {
      floci: { resolve: this.resolveFlociVariable.bind(this) }
    };

    this.commands = {
      floci: {
        usage: 'Inspect the Floci instance this project deploys to',
        lifecycleEvents: ['info'],
        commands: {
          info: {
            usage: 'Show the Floci instance, its version and the services it runs',
            lifecycleEvents: ['info']
          }
        }
      }
    };

    this.hooks = {
      'floci:info': () => this.printInfo(),
      'floci:info:info': () => this.printInfo(),
      'before:package:initialize': () => this.activate(),
      'before:deploy:deploy': () => this.activate(),
      'before:invoke:local:invoke': () => this.activate(),
      'before:remove:remove': () => this.activate(),
      'after:package:compileFunctions': () => this.mountLambdaCode()
    };

    if (this.active) {
      this.applyEnvironment();
      this.pointSdkAtFloci();
      useStackDeploymentBucket(this.serverless);
    }
  }

  buildLogger() {
    const write = (level) => (message) => {
      const cli = this.serverless.cli;
      if (cli && typeof cli.log === 'function') cli.log(`serverless-floci: ${message}`);
      else process.stdout.write(`serverless-floci ${level}: ${message}\n`);
    };
    return { info: write('info'), warn: write('warning') };
  }

  /**
   * Put the endpoint and dummy credentials in the environment for the AWS SDK v3 clients that
   * Serverless v4 builds during a deployment. This is deliberately not a list of services:
   * the SDK applies AWS_ENDPOINT_URL to every client, so there is no catalogue to fall behind.
   */
  applyEnvironment() {
    const disagreement = assertEndpointAgreement(
      { url: this.config.endpoint, source: this.config.endpointSource },
      process.env
    );
    if (disagreement) throw this.error(disagreement);

    if (!process.env.AWS_ENDPOINT_URL) {
      process.env.AWS_ENDPOINT_URL = this.config.endpoint;
      this.warnAboutEarlyVariables();
    }
    process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
    process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';
    process.env.AWS_REGION = process.env.AWS_REGION || this.serverless.service.provider.region || 'us-east-1';
  }

  /**
   * We can set AWS_ENDPOINT_URL for the deployment, but not for ${ssm:} and friends - those were
   * resolved two steps before this plugin existed. Say so, rather than let the run read one
   * endpoint and write to another.
   */
  warnAboutEarlyVariables() {
    const file = this.configurationFilePath();
    if (!file) return;
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const match = source.match(EARLY_VARIABLE_PATTERN);
    if (!match) return;
    this.log.warn(
      `AWS_ENDPOINT_URL was not set, so \${${match[1]}:...} in ${path.basename(file)} was resolved ` +
      `against real AWS, not against ${this.config.endpoint}.\n` +
      `  Put AWS_ENDPOINT_URL=${this.config.endpoint} in your .env file - Serverless loads it before ` +
      'it resolves variables, which is earlier than any plugin can run.'
    );
  }

  /** Serverless' own error type when it is reachable, so the CLI prints it without a stack. */
  error(message) {
    const ServerlessError = (this.serverless.classes || {}).Error;
    return ServerlessError ? new ServerlessError(message) : new Error(message);
  }

  configurationFilePath() {
    const { serviceDir, configurationFilename } = this.serverless;
    if (!serviceDir || !configurationFilename) return null;
    return path.join(serviceDir, configurationFilename);
  }

  async activate() {
    if (!this.active) {
      this.log.info(
        `not active for stage "${this.config.stage}" ` +
        `(custom.floci.stages: ${JSON.stringify(this.config.stages || null)})`
      );
      return;
    }
    if (this.config.usedLegacyKey) {
      this.log.warn('reading custom.localstack; rename it to custom.floci (edgePort becomes port)');
    }
    if (this.activated) return;
    this.activated = true;
    const health = await this.health();
    assertServices(health, (this.config.health || {}).require);
    this.log.info(`using ${this.config.endpoint} - ${describe(health)}`);
  }

  /**
   * Point the aws-sdk v2 instance behind provider.request at Floci. That SDK, not the v3 clients,
   * is what carries CloudFormation, S3, STS and ECR during a deployment.
   */
  pointSdkAtFloci() {
    const provider = this.serverless.getProvider && this.serverless.getProvider('aws');
    if (!provider) return false;
    return applySdkEndpoint(provider, {
      endpoint: this.config.endpoint,
      region: this.serverless.service.provider.region || process.env.AWS_REGION
    });
  }

  async health() {
    if (!this.healthPromise) {
      this.healthPromise = fetchHealth(this.config.endpoint, {
        timeout: (this.config.health || {}).timeout
      });
    }
    return this.healthPromise;
  }

  /**
   * Hand the Lambda service a path on disk instead of a zip, so edits to handler code take
   * effect without redeploying. Done by rewriting the compiled template on a published
   * lifecycle hook - no framework class is patched.
   */
  mountLambdaCode() {
    if (!this.active || this.config.mountCode === null) return;
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;
    const resources = (template || {}).Resources || {};
    const mountPath = this.config.mountCode
      ? path.resolve(this.serverless.serviceDir, this.config.mountCode)
      : this.serverless.serviceDir;

    const mounted = Object.values(resources).filter((resource) => {
      if (resource.Type !== 'AWS::Lambda::Function') return false;
      if (resource.Properties && resource.Properties.PackageType === 'Image') return false;
      resource.Properties.Code = { S3Bucket: HOT_RELOAD_BUCKET, S3Key: mountPath };
      return true;
    });

    if (mounted.length > 0) this.log.info(`mounting ${mounted.length} function(s) from ${mountPath}`);
  }

  async resolveFlociVariable({ address }) {
    const health = await this.health();
    const values = {
      url: this.config.endpoint,
      endpoint: this.config.endpoint,
      version: health.version,
      edition: health.edition,
      services: runningServices(health).join(',')
    };
    if (!(address in values)) {
      throw this.error(
        `serverless-floci: unknown variable \${floci:${address}}. ` +
        `Available: ${Object.keys(values).join(', ')}`
      );
    }
    return { value: values[address] };
  }

  async printInfo() {
    const health = await this.health();
    const services = runningServices(health);
    process.stdout.write(
      `\nFloci\n` +
      `  endpoint  ${this.config.endpoint}  (from ${this.config.endpointSource})\n` +
      `  version   ${health.version || '?'} (${health.edition || '?'})\n` +
      `  stage     ${this.config.stage}${this.active ? '' : '  [plugin not active for this stage]'}\n` +
      `  services  ${services.length} running\n` +
      `            ${services.join(', ')}\n\n`
    );
  }
}

module.exports = ServerlessFloci;
