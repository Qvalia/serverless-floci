# Spike: variable resolution ordering in Serverless Framework v4

Measured against `serverless@4.46.0` (the pinned binary under `~/.serverless/releases/4.46.0`),
with a Floci 2.1.0 instance on `localhost:4566`.

## Question

Can a plugin make `${ssm:...}` / `${cf:...}` / `${s3:...}` resolve against Floci,
so that consumers no longer have to export `AWS_ENDPOINT_URL` before running `sls`?

## Result: no. The resolution order forbids it.

| # | Setup | `${ssm:/spike/p}` |
|---|---|---|
| A | plugin registers its own `ssm` source | built-in wins; plugin resolver **never called** |
| B | `AWS_ENDPOINT_URL` exported in the shell | resolves from Floci |
| C | plugin sets `process.env.AWS_ENDPOINT_URL` in its constructor | **fails** - constructor never ran |
| D | same as C, but `${ssm:}` given a default | constructor runs *after* `${ssm:}` already resolved |
| F | `AWS_ENDPOINT_URL` in a dotenv file only, never exported | resolves from Floci |
| G | negative control: no dotenv file, nothing exported | `Cannot resolve '${ssm:...}'` |

## The order, as established by C/D

1. The dotenv file is loaded.
2. Built-in variable sources resolve: `aws` (which serves `ssm`, `s3`, `cf`), `env`, `opt`,
   `file`, `param`, `self`, `sls`, ...
3. Plugins are constructed, and their `configurationVariablesSources` are registered.
4. A second pass resolves plugin-provided sources.

A plugin is therefore built two steps too late to influence `${ssm:}`. Registering a source
named `ssm` does nothing either: `ProviderRegistry.register` does overwrite
(`register(type, provider) { this.providers[type] = provider }`), but `${ssm:}` is served by the
built-in `aws` provider (`static type = "aws"; static resolvers = ["ssm", "s3", "cf"]`) in a pass
that has already finished.

## Consequences for this plugin

* `AWS_ENDPOINT_URL` **must** be in the environment before `sls` starts. That is a framework
  constraint, not a shortcoming of `serverless-localstack`, and no plugin can remove it.
* A dotenv file is sufficient, so consumers do not need an `AWS_ENDPOINT_URL=` prefix on every
  npm script. This is the recommended setup.
* What the plugin *can* do is make the failure legible: check the variable at construction time
  and say exactly what to set. Today a wrong or missing value silently resolves against real AWS,
  or against the wrong emulator.
* A plugin-owned source name that is *not* a built-in (`${floci:...}`) does work, and is free for
  the plugin to define.

---

# Spike 2: what actually has to be redirected

Two further things were measured while making a deployment succeed, and both contradict a
reasonable first guess about Serverless v4.

## Serverless v4 carries *both* AWS SDKs

v4 bundles `@aws-sdk/client-*` (v3) **and** aws-sdk **v2.1693.0**, the latter exposed as
`provider.sdk` and used by `provider.request`. Tracing a deployment shows every
CloudFormation, S3, STS and ECR call going through `provider.request`, i.e. through v2:

```
>>> request: STS.getCallerIdentity
>>> request: CloudFormation.describeStacks
>>> request: S3.listObjectsV2
>>> request: S3.upload
>>> request: CloudFormation.updateStack
```

So the deployment needs the v2 instance configured (endpoint, per-service endpoints,
`s3ForcePathStyle`), and that is what `serverless-localstack` has always done. Variable
resolution is the v3 half, and that one reads `AWS_ENDPOINT_URL`. Both are needed, for
different reasons.

Rather than hardcode service names, `src/sdk.js` reads them off the SDK that is loaded: every
aws-sdk v2 service class carries its own config key as `serviceIdentifier`.

## The v4 global deployment bucket cannot be reached on an emulator

v4 keeps artifacts in one shared bucket per account and region,
`serverless-framework-deployments-<region>-<id>`, created through an SDK v3 client that
addresses it virtual-host style. Against an emulator that becomes

```
Error: getaddrinfo ENOTFOUND serverless-framework-deployments-eu-west-1-71e7c2cf-2e93.localhost
```

`*.localhost` is not loopback on Linux or WSL2, and Floci serves buckets by path in any case.

The framework still supports a deployment bucket per stack, reached over `provider.request`
(v2, path style). It is selected by:

```js
isLegacyDeploymentBucketEnabled = options['enable-legacy-deployment-bucket']
  || process.env.ENABLE_LEGACY_DEPLOYMENT_BUCKET
  || provider.enableLegacyDeploymentBucket
```

`AwsProvider` resolves that once in its own constructor, which has already run by the time a
plugin exists, so `src/deploymentBucket.js` sets the resolved flag on the provider as well as
the configuration value.

This bites `serverless-localstack` too. It is not visible on a stack that already has a
deployment bucket from an earlier deploy, nor on a project that names its own
`provider.deploymentBucket` - which is why our repositories have not hit it.

## Floci's CloudFormation hot-reload support is recent

`lambda.mountCode` emits `Code: { S3Bucket: 'hot-reload', S3Key: <path> }`. Floci's
`CreateFunction` has honoured that marker for a long time, but its *CloudFormation* provisioner
only started passing it through in `34f4f72e8` ("fix(cloudformation): pass Lambda hot-reload
code through to the Lambda service", #4093). That commit is **not** in 2.1.0 and **is** in
2.3.0, so against 2.1.0 a mounted function fails with

```
Error occurred while GetObject. S3 Error Message: The specified bucket does not exist. (bucket: hot-reload)
```

Verified working against Floci 2.4.0: deployed, invoked, then edited the handler on disk and
invoked again without redeploying, and the new value came back.
