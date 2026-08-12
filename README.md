# serverless-python-mcp

Serverless Framework plugin for deploying Python MCP servers on AWS Lambda.
It keeps the normal Serverless deployment model and adds MCP functions under
`custom.pythonMcp`.

This plugin works together with [`modmex-lambda`](https://pypi.org/project/modmex-lambda/).
The plugin is only the Serverless deployment integration; `modmex-lambda` is
the MCP runtime and provides `MCPServer`, tools, resources, prompts, MCP
validation, HTTP transports, middleware, context propagation,
`APIGatewayRestResolver`, `APIGatewayHttpResolver`, `LambdaWebAdapterResolver`
and `LambdaWebAdapterHandler`. A Python project using this plugin must depend
on `modmex-lambda` for those runtime capabilities.

## Quick start

Install the plugin in a Serverless service:

```bash
npm install --save-dev serverless-python-mcp
```

Register it:

```yaml
plugins:
  - serverless-python-mcp
```

Define an MCP server:

```yaml
custom:
  pythonMcp:
    servers:
      orders:
        handler: app.handler
        transport: httpApi
        streaming: false
```

The Python module exports a normal Modmex handler:

```python
from modmex_lambda import APIGatewayHttpResolver
from modmex_lambda.mcp import MCPServer

mcp = MCPServer(name="orders", version="1.0.0")

app = APIGatewayHttpResolver()
app.include_mcp(mcp, path="/mcp")

handler = app.handler
```

## Configuration reference

Each entry under `custom.pythonMcp.servers` creates one Lambda function. The
key is the server name and is used in the generated function name.

```yaml
custom:
  pythonMcp:
    servers:
      orders:
        handler: app.handler
        transport: httpApi
        streaming: false
        path: /mcp
        architecture: x86_64
        authorizer: ordersJwt
        environment:
          ORDERS_TABLE: orders
        package:
          patterns:
            - templates/**
```

### `handler`

Required. It uses Serverless' standard `module.attribute` notation:

```yaml
handler: app.handler
handler: src.orders.lambda_handler
```

The attribute must be a Modmex handler. For streaming it must be a
`LambdaWebAdapterHandler`, normally exported as `handler = app.handler`.

`handler` is the only accepted entrypoint property. The plugin does not infer
module names or use a separate `server` property.

### `transport`

The value identifies the AWS front door. It does not by itself select the
Python resolver; that is determined by `streaming` as described below:

| `transport` | AWS front door | Streaming mode | Buffered mode |
|---|---|---|---|
| `httpApi` | API Gateway HTTP API v2 | not supported | `APIGatewayHttpResolver` |
| `http` | API Gateway REST API v1 | `LambdaWebAdapterResolver` | `APIGatewayRestResolver` |
| `url` | Lambda Function URL | `LambdaWebAdapterResolver` | `APIGatewayHttpResolver` |

If `transport` is omitted, the default is `httpApi`. The aliases
`api-gateway`, `http-api`, and `lambda-url` are accepted temporarily and map
to `http`, `httpApi`, and `url` respectively.

### `streaming`

`streaming` defaults to `true`. It controls how the configured handler is
executed:

#### Streaming: `streaming: true`

Supported transports are `url` and `http` only. The application must expose a
`LambdaWebAdapterResolver` handler:

```python
from modmex_lambda import LambdaWebAdapterResolver

app = LambdaWebAdapterResolver()
app.include_mcp(mcp, path="/mcp")
handler = app.handler
```

The plugin adds the Lambda Web Adapter layer to this function, starts the
HTTP process through its temporary launcher, and enables incremental SSE
response streaming. `httpApi` with `streaming: true` is rejected.

#### Buffered: `streaming: false`

All three transports are supported. Serverless invokes the configured handler
as a normal Lambda function:

```python
handler = app.handler
```

Use the resolver matching the transport: `APIGatewayHttpResolver` for
`httpApi`, `APIGatewayRestResolver` for `http`, and `APIGatewayHttpResolver`
for `url`. No Lambda Web Adapter layer or launcher is added.

Examples:

```yaml
# API Gateway HTTP API v2, buffered
transport: httpApi
streaming: false

# API Gateway REST API v1, streaming
transport: http
streaming: true

# Lambda Function URL, buffered
transport: url
streaming: false
```

### `path`

Optional and defaults to `/mcp`:

```yaml
path: /orders/mcp
```

The value must begin with `/`. The application must register the same path:

```python
app.include_mcp(mcp, path="/orders/mcp")
```

Paths must be unique among servers sharing the same `http` or `httpApi`
transport. Different Function URLs may reuse `/mcp` because each function has
its own hostname.

### `architecture`

Supported values are `x86_64` and `arm64`. Resolution order:

```text
server architecture → provider architecture → x86_64
```

For streaming, the corresponding regional Lambda Web Adapter layer version 28
is attached only to the generated MCP function:

```text
x86_64 → LambdaAdapterLayerX86:28
arm64   → LambdaAdapterLayerArm64:28
```

No global `provider.layers` entry is required.

## Authorization

### Function URLs

Function URLs support only public access or AWS IAM:

```yaml
transport: url
authorizer: aws_iam
```

Omit `authorizer` for a public URL. API Gateway JWT, request, token, and
Cognito authorizers are not valid for Function URLs.

### HTTP API global authorizers

Use Serverless' native global configuration:

```yaml
provider:
  httpApi:
    authorizers:
      ordersJwt:
        type: jwt
        identitySource: $request.header.Authorization
        issuerUrl: https://issuer.example.com
        audience:
          - orders-client

custom:
  pythonMcp:
    servers:
      orders:
        handler: app.handler
        transport: httpApi
        streaming: false
        authorizer: ordersJwt
```

### HTTP API per-server authorizers

An HTTP API authorizer can also be declared inline. The plugin registers it in
the native Serverless authorizer collection and references it from the route:

```yaml
authorizer:
  type: jwt
  identitySource: $request.header.Authorization
  issuerUrl: https://issuer.example.com
  audience:
    - orders-client
```

All Serverless-compatible HTTP API authorizer types are preserved, including
JWT, request, IAM, existing authorizer IDs, scopes, and Lambda authorizer
properties.

### REST API authorizers

For `transport: http`, the plugin passes the authorizer configuration through
to the native REST API event compiler. Use the same authorizer shape you would
use under a regular Serverless `functions[].events[].http` event.

## Generated resources and names

Generated Lambda functions use:

```text
service-stage-mcp-serverName
```

For API Gateway transports, the shared REST API name is:

```text
service-stage-mcp
```

The HTTP API follows Serverless' normal provider configuration. A Function URL
belongs to its Lambda function and has no independent resource name.

## Streaming lifecycle

For streaming, the plugin temporarily stages an internal launcher:

```text
serverless-mcp/run.sh
```

It is created before deployment artifacts are built, included only in the
function package, and removed on successful completion or failure. It is not
part of the user's source tree or application contract.

The launcher imports the configured `module.attribute`, validates that it is a
`LambdaWebAdapterHandler`, and calls `handler.run()`. Application code does
not need `if __name__ == "__main__"` or a permanent shell script.

## Examples

The [`examples/`](examples) directory contains isolated projects for each
supported transport/mode combination:

1. `http-api-buffered`;
2. `rest-api-buffered`;
3. `function-url-buffered`;
4. `rest-api-streaming`;
5. `function-url-streaming`.

Each example has its own `serverless.yml`, `pyproject.toml`, and entrypoint so
it can be copied into a real service without inheriting configuration from
another example.

## Development and publishing

```bash
npm install
npm test
npm run lint
npm pack --dry-run
npm publish
```

Before publishing, update the version, review the tarball contents, and verify
the peer dependency against the Serverless Framework versions supported by the
release.
