const test = require('node:test');
const assert = require('node:assert/strict');
const Plugin = require('../index');

function createPlugin(overrides = {}) {
  const service = {
    service: 'example',
    custom: { pythonMcp: { servers: {} } },
    provider: { name: 'aws', region: 'us-east-1' },
    functions: {},
    ...overrides,
  };
  const serverless = {
    service,
    configurationInput: { custom: service.custom },
    serviceDir: '/tmp/example',
    getProvider: () => ({ getStage: () => 'dev' }),
  };
  return { plugin: new Plugin(serverless, {}, { log() {} }), serverless };
}

test('synthesizes a streaming Function URL with the configured handler', async () => {
  const { plugin, serverless } = createPlugin({
    custom: { pythonMcp: { servers: { pizza: {
      handler: 'app.handler', transport: 'url', streaming: true,
    } } } },
  });
  serverless.configurationInput.custom = serverless.service.custom;
  await plugin.initialize();
  const fn = serverless.service.functions.pizza;
  assert.equal(fn.name, 'example-dev-mcp-pizza');
  assert.equal(fn.handler, 'serverless-mcp/run.sh');
  assert.equal(fn.url.invokeMode, 'RESPONSE_STREAM');
  assert.equal(fn.environment.MCP_HANDLER_MODULE, 'app');
  assert.equal(fn.environment.MCP_HANDLER_ATTRIBUTE, 'handler');
  assert.deepEqual(fn.layers, [{ 'Fn::Sub': 'arn:aws:lambda:${AWS::Region}:753240598075:layer:LambdaAdapterLayerX86:28' }]);
});

test('synthesizes a buffered HTTP API without the Web Adapter', async () => {
  const { plugin, serverless } = createPlugin({
    custom: { pythonMcp: { servers: { pizza: {
      handler: 'buffered_app.handler', transport: 'httpApi', streaming: false,
    } } } },
  });
  await plugin.initialize();
  const fn = serverless.service.functions.pizza;
  assert.equal(fn.handler, 'buffered_app.handler');
  assert.equal(fn.events[0].httpApi.path, '/mcp');
  assert.equal(fn.environment.AWS_LWA_PORT, undefined);
});

test('rejects duplicate paths on the same API transport', async () => {
  const { plugin } = createPlugin({
    custom: { pythonMcp: { servers: {
      one: { handler: 'one.handler', transport: 'http', path: '/mcp', streaming: false },
      two: { handler: 'two.handler', transport: 'http', path: '/mcp', streaming: false },
    } } },
  });
  await assert.rejects(() => plugin.initialize(), /same path/);
});

test('accepts a per-server HTTP API authorizer definition', async () => {
  const { plugin, serverless } = createPlugin({
    custom: { pythonMcp: { servers: { secure: {
      handler: 'app.handler', transport: 'httpApi', streaming: false,
      authorizer: { type: 'jwt', identitySource: '$request.header.Authorization', issuerUrl: 'https://issuer', audience: ['client'] },
    } } } },
  });
  await plugin.initialize();
  assert.equal(serverless.service.provider.httpApi.authorizers.secureJwt.type, 'jwt');
  assert.equal(serverless.service.functions.secure.events[0].httpApi.authorizer, 'secureJwt');
});

test('rejects API Gateway authorizers on Function URLs', async () => {
  const { plugin } = createPlugin({
    custom: { pythonMcp: { servers: { secure: {
      handler: 'app.handler', transport: 'url', streaming: false,
      authorizer: 'cognitoJwt',
    } } } },
  });
  await assert.rejects(() => plugin.initialize(), /Function URLs/);
});

test('selects the arm64 Lambda Web Adapter layer', async () => {
  const { plugin, serverless } = createPlugin({
    custom: { pythonMcp: { servers: { arm: {
      handler: 'app.handler', transport: 'url', streaming: true, architecture: 'arm64',
    } } } },
    provider: { name: 'aws', region: 'us-east-1', architecture: 'arm64' },
  });
  await plugin.initialize();
  assert.deepEqual(serverless.service.functions.arm.layers, [{ 'Fn::Sub': 'arn:aws:lambda:${AWS::Region}:753240598075:layer:LambdaAdapterLayerArm64:28' }]);
});
