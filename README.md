# serverless-floci

Deploy a [Serverless Framework](https://www.serverless.com/) v4 service to
[Floci](https://github.com/floci-io/floci), a local AWS emulator.

Floci is wire-compatible with LocalStack, so `serverless-localstack` does work against it. This
plugin exists because that one was built for Serverless v1-v3 and for LocalStack's own
conventions, and a fair amount of it is dead or wrong here: it autostarts through the
`localstack` CLI, defaults to the licensed `localstack/localstack-pro` image, rewrites API
Gateway URLs to `localhost.localstack.cloud`, and redirects a hardcoded list of 68 services that
has fallen behind both the AWS SDK and the emulator - `rds-data` among the 76 it misses.

## Install

```bash
npm install --save-dev serverless-floci
```

```yaml
plugins:
  - serverless-floci

custom:
  floci:
    url: http://localhost:4566
    stages: [local]
```

```bash
sls deploy --stage local
```

Requires Serverless Framework v4, Node 18+, and a running Floci. For `lambda.mountCode`, Floci
2.3.0 or later.

## Configuration

```yaml
custom:
  floci:
    # Where Floci is. A bare host, "host:port" or a full URL. Defaults to localhost:4566.
    url: http://localhost:4566

    # Stages this plugin is active for. With none listed it engages only when something
    # explicitly names an instance, so it never catches a real deployment by surprise.
    stages: [local]

    # Fail the deployment up front if the emulator is not running these.
    health:
      require: [s3, sqs, lambda, cloudformation]
      timeout: 5000

    lambda:
      # true mounts the service directory; a string mounts that subdirectory of it.
      # Edits to handler code then take effect without redeploying.
      mountCode: true
```

`FLOCI_URL` and `FLOCI_PORT` are read when the yaml names no address.

## Set AWS_ENDPOINT_URL in your .env

Serverless resolves `${ssm:...}`, `${cf:...}` and `${s3:...}` *before it loads any plugin*, using
`AWS_ENDPOINT_URL` from the environment. No plugin can change that - see
[SPIKE.md](SPIKE.md) for the measurements. If your service uses those variables, put the
endpoint in the `.env` file that Serverless loads:

```
AWS_ENDPOINT_URL=http://localhost:4566
```

That is enough; it does not need to be exported in every npm script. If you leave it out, this
plugin says so, naming the variable it found in your configuration, rather than letting the run
read from real AWS and write to Floci.

If `AWS_ENDPOINT_URL` and your configured endpoint disagree, the plugin refuses to start:
by then part of the run has already read one instance and the rest would write to another, and
nothing can repair that afterwards.

## What it does

* **Points both SDKs at Floci.** Serverless v4 carries aws-sdk v2 (as `provider.sdk`, which
  `provider.request` uses for the deployment) and AWS SDK v3 (for variable resolution). Service
  endpoints are read off the loaded SDK rather than from a list that can go stale.
* **Uses the deployment bucket in your stack**, not v4's shared
  `serverless-framework-deployments-*` bucket, which is addressed virtual-host style and so is
  unreachable on an emulator (`ENOTFOUND <bucket>.localhost`). A project that names its own
  `provider.deploymentBucket` is left alone.
* **Checks the instance before deploying.** An unreachable Floci, or a service your stack needs
  that is not running, fails immediately with that named, instead of surfacing as an opaque AWS
  error in the middle of a rollback.
* **Mounts Lambda code** for hot reload, on a published lifecycle hook rather than by patching
  framework internals.
* **Adds `sls floci info`** - the endpoint, the version, and the services the instance runs.
* **Adds a `${floci:...}` variable source**: `url`, `endpoint`, `version`, `edition`, `services`.

## Migrating from serverless-localstack

Rename the plugin. `custom.localstack` is still read, `edgePort` included, so this is usually
the whole change:

```diff
 plugins:
-  - serverless-localstack
+  - serverless-floci

 custom:
-  localstack:
-    edgePort: 4566
+  floci:
+    url: http://localhost:4566
     stages: [local]
-    docker:
-      sudo: true
```

`docker.sudo` and `autostart` are not carried over. They only ever drove `serverless-localstack`'s
own container management, which shells out to the `localstack` CLI and greps `docker ps` for
`localstack/localstack` - neither of which finds Floci. Start Floci with `docker compose`.

## Development

```bash
npm test     # node:test, no test framework to install
npm run lint
```

The plugin has no runtime dependencies.

## Licence

MIT. See [LICENSE](LICENSE).
