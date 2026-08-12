# Plugin examples

Each directory is an independent Serverless Framework service. Run
`npm install` and `poetry install` inside the selected example, then deploy
with `sls deploy`. The examples consume the published
`serverless-python-mcp` package from npm.

The examples depend on `modmex-lambda` for the MCP server, resolvers and
transport implementations. This npm package only supplies the Serverless
deployment integration.

| Example | Transport | Streaming | Resolver |
|---|---|---|---|
| `http-api-buffered` | `httpApi` | no | `APIGatewayHttpResolver` |
| `rest-api-buffered` | `http` | no | `APIGatewayRestResolver` |
| `function-url-buffered` | `url` | no | `APIGatewayHttpResolver` |
| `rest-api-streaming` | `http` | yes | `LambdaWebAdapterResolver` |
| `function-url-streaming` | `url` | yes | `LambdaWebAdapterResolver` |
