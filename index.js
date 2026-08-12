'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Local Serverless Framework plugin for Python MCP applications.
 *
 * It deliberately mutates the normal Serverless service configuration rather
 * than introducing a second deployment model. Existing provider.apiGateway,
 * provider.httpApi and per-function authorizer settings remain authoritative.
 */
class ServerlessPythonMcpPlugin {
  constructor(serverless, options, utils) {
    this.serverless = serverless;
    this.utils = utils;
    this.provider = serverless.getProvider('aws');
    this.hooks = {
      initialize: async () => this.initialize(),
      'before:package:createDeploymentArtifacts': async () => this.writeLaunchers(),
      'before:deploy:function:packageFunction': async () => this.writeLaunchers(),
      finalize: async () => this.removeLaunchers(),
      error: async () => this.removeLaunchers(),
    };
    this.configured = false;
  }

  async initialize() {
    if (this.configured) return;
    const config = this.serverless.configurationInput?.custom?.pythonMcp
      || this.serverless.service.custom?.pythonMcp;
    if (!config || !config.servers) {
      this.log('pythonMcp configuration not available at lifecycle hook');
      return;
    }

    const servers = config.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      throw new Error('custom.pythonMcp.servers must be an object');
    }

    this.serverless.service.functions ||= {};
    if (
      Object.values(servers).some((definition) => normalizeTransport(definition?.transport) !== 'url')
      && !this.serverless.service.provider.apiName
    ) {
      this.serverless.service.provider.apiName = `${this.serverless.service.service}-${this.provider.getStage()}-mcp`;
    }
    for (const [name, definition] of Object.entries(servers)) {
      this.configureServer(name, definition);
    }
    this.validatePathCollisions(servers);
    this.configured = true;
    this.log(`configured ${Object.keys(servers).length} MCP server(s)`);
  }

  log(message) {
    if (this.utils?.log) this.utils.log(`serverless-python-mcp: ${message}`);
  }

  configureServer(name, definition) {
    if (!definition || typeof definition !== 'object') {
      throw new Error(`custom.pythonMcp.servers.${name} must be an object`);
    }
    const application = definition.handler;
    if (!application) {
      throw new Error(`MCP server '${name}' requires handler, e.g. app.handler`);
    }

    const transport = normalizeTransport(definition.transport);
    const streaming = definition.streaming !== false;
    const path = normalizePath(definition.path, name);
    if (transport === 'url') {
      normalizeUrlAuthorizer(definition.authorizer);
    }
    if (transport === 'url' && definition.apiGateway) {
      throw new Error(`apiGateway is not valid for Lambda URL server '${name}'`);
    }
    if (streaming && transport === 'httpApi') {
      throw new Error(
        `MCP server '${name}' cannot use transport 'httpApi' with streaming enabled; `
        + "use 'http' or 'url'",
      );
    }

    const functionName = name;
    const functions = this.serverless.service.functions || (this.serverless.service.functions = {});
    if (functions[functionName]) {
      throw new Error(`Function '${functionName}' already exists`);
    }

    const [handlerModule, handlerAttribute] = parseHandler(application, name);
    const architecture = definition.architecture
      || this.serverless.service.provider.architecture
      || 'x86_64';
    if (!['x86_64', 'arm64'].includes(architecture)) {
      throw new Error(
        `Unsupported architecture '${architecture}' for MCP server '${name}'. `
        + "Expected 'x86_64' or 'arm64'",
      );
    }
    const functionConfig = {
      name: `${this.serverless.service.service}-${this.provider.getStage()}-mcp-${functionName}`,
      handler: streamingHandler(definition, streaming),
      architecture,
      environment: {
        ...(definition.environment || {}),
        MCP_APPLICATION: application,
        MCP_HANDLER_MODULE: handlerModule,
        MCP_HANDLER_ATTRIBUTE: handlerAttribute,
        AWS_LWA_PORT: '8080',
        AWS_LWA_INVOKE_MODE: streaming ? 'response_stream' : 'buffered',
        PYTHONUNBUFFERED: '1',
      },
      package: {
        patterns: [application.split('.')[0] + '.py', 'server.py', 'serverless-mcp/**', ...(definition.package?.patterns || [])],
      },
      events: [],
    };

    if (streaming) {
      functionConfig.environment.AWS_LAMBDA_EXEC_WRAPPER = '/opt/bootstrap';
      functionConfig.url = {
        invokeMode: 'RESPONSE_STREAM',
        ...(definition.authorizer ? { authorizer: normalizeUrlAuthorizer(definition.authorizer) } : {}),
      };
      if (transport === 'http') {
        const normalizedPath = path.replace(/\/$/, '') || '/';
        const httpEvent = (routePath) => ({
          http: {
            path: routePath,
            method: 'ANY',
            response: { transferMode: 'STREAM' },
            ...(definition.authorizer ? { authorizer: definition.authorizer } : {}),
          },
        });
        functionConfig.events = [
          httpEvent(normalizedPath),
          ...(normalizedPath === '/'
            ? []
            : [httpEvent(`${normalizedPath}/{proxy+}`)]),
        ];
        delete functionConfig.url;
      }
      if (!functionConfig.layers) {
        const layerName = architecture === 'arm64'
          ? 'LambdaAdapterLayerArm64'
          : 'LambdaAdapterLayerX86';
        functionConfig.layers = [
          {
            'Fn::Sub': `arn:aws:lambda:\${AWS::Region}:753240598075:layer:${layerName}:28`,
          },
        ];
      }
    } else if (transport === 'url') {
      functionConfig.url = {
        invokeMode: 'BUFFERED',
        ...(definition.authorizer
          ? { authorizer: normalizeUrlAuthorizer(definition.authorizer) }
          : {}),
      };
      functionConfig.events = [];
      delete functionConfig.environment.AWS_LAMBDA_EXEC_WRAPPER;
      delete functionConfig.environment.AWS_LWA_PORT;
      delete functionConfig.environment.AWS_LWA_INVOKE_MODE;
    } else if (transport === 'http') {
      functionConfig.events = [{
        http: {
          path,
          method: 'POST',
          ...(definition.authorizer ? { authorizer: definition.authorizer } : {}),
        },
      }];
      delete functionConfig.environment.AWS_LAMBDA_EXEC_WRAPPER;
      delete functionConfig.environment.AWS_LWA_PORT;
      delete functionConfig.environment.AWS_LWA_INVOKE_MODE;
      delete functionConfig.url;
    } else {
      const httpApiAuthorizer = resolveHttpApiAuthorizer(
        this.serverless.service.provider,
        name,
        definition.authorizer,
      );
      functionConfig.events = [{
        httpApi: {
          path,
          method: 'POST',
          ...(httpApiAuthorizer ? { authorizer: httpApiAuthorizer } : {}),
        },
      }];
      delete functionConfig.environment.AWS_LAMBDA_EXEC_WRAPPER;
      delete functionConfig.environment.AWS_LWA_PORT;
      delete functionConfig.environment.AWS_LWA_INVOKE_MODE;
      delete functionConfig.url;
    }

    if (definition.apiGateway) {
      this.applyProviderConfig('apiGateway', definition.apiGateway);
    }
    if (definition.httpApi) {
      this.applyProviderConfig('httpApi', definition.httpApi);
    }
    functions[functionName] = functionConfig;
  }

  validatePathCollisions(servers) {
    const pathsByTransport = new Map();
    for (const [name, definition] of Object.entries(servers)) {
      const transport = normalizeTransport(definition?.transport);
      if (transport === 'url') continue;
      const path = normalizePath(definition?.path, name);
      const key = `${transport}:${path}`;
      const previous = pathsByTransport.get(key);
      if (previous) {
        throw new Error(
          `MCP servers '${previous}' and '${name}' use the same path '${path}' `
          + `on transport '${transport}'`,
        );
      }
      pathsByTransport.set(key, name);
    }
  }

  async writeLaunchers() {
    const config = this.serverless.configurationInput?.custom?.pythonMcp
      || this.serverless.service.custom?.pythonMcp;
    if (!config?.servers) return;
    const directory = path.join(this.serverless.serviceDir, 'serverless-mcp');
    fs.mkdirSync(directory, { recursive: true });
    const launcher = path.join(directory, 'run.sh');
    if (fs.existsSync(launcher) && !this.generatedLauncher) {
      throw new Error(
        'Cannot stage the MCP launcher because serverless-mcp/run.sh already exists; '
        + 'move the user file or configure a different staging path',
      );
    }
    fs.writeFileSync(launcher, '#!/bin/sh\nexec python3 -m modmex_lambda.mcp.web_adapter_launcher\n', { mode: 0o755 });
    this.generatedLauncher = launcher;
  }

  async removeLaunchers() {
    if (!this.generatedLauncher) return;
    const launcher = this.generatedLauncher;
    const directory = path.dirname(launcher);
    try {
      if (fs.existsSync(launcher)) fs.unlinkSync(launcher);
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } finally {
      this.generatedLauncher = undefined;
    }
  }

  applyProviderConfig(key, override) {
    const provider = this.serverless.service.provider;
    provider[key] = { ...(provider[key] || {}), ...override };
  }
}

function parseHandler(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`MCP server '${name}' handler must use module.attribute notation, e.g. app.handler`);
  }
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`MCP server '${name}' handler must use module.attribute notation, e.g. app.handler`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function streamingHandler(definition, streaming) {
  if (!streaming) return definition.handler;
  return 'serverless-mcp/run.sh';
}

function normalizeUrlAuthorizer(authorizer) {
  if (typeof authorizer === 'undefined' || authorizer === null) {
    return undefined;
  }
  if (typeof authorizer === 'string') {
    const normalized = authorizer.toLowerCase();
    if (normalized === 'aws_iam') return 'aws_iam';
    if (normalized === 'none') return undefined;
  }
  throw new Error(
    "Lambda URL authorizer only supports 'aws_iam' or 'none'; "
    + "API Gateway authorizers such as token, request, Cognito, or custom "
    + 'are not supported by Function URLs',
  );
}

function normalizeTransport(transport) {
  const value = transport || 'httpApi';
  const aliases = {
    httpApi: 'httpApi',
    'http-api': 'httpApi',
    http: 'http',
    'api-gateway': 'http',
    url: 'url',
    'lambda-url': 'url',
  };
  if (!aliases[value]) {
    throw new Error(
      `Unsupported MCP transport '${value}'. Expected 'httpApi', 'http', or 'url'`,
    );
  }
  return aliases[value];
}

function resolveHttpApiAuthorizer(provider, serverName, authorizer) {
  if (!authorizer) return undefined;
  if (typeof authorizer === 'string') return authorizer;
  if (
    typeof authorizer !== 'object'
    || Array.isArray(authorizer)
  ) {
    throw new Error(
      `HTTP API authorizer for MCP server '${serverName}' must be a named authorizer `
      + 'or a compatible Serverless authorizer object',
    );
  }

  if (authorizer.type === 'aws_iam') return authorizer;

  const routeKeys = new Set(['name', 'id', 'type', 'scopes']);
  if (Object.keys(authorizer).every((key) => routeKeys.has(key))) {
    return authorizer;
  }

  const httpApi = provider.httpApi || (provider.httpApi = {});
  const authorizers = httpApi.authorizers || (httpApi.authorizers = {});
  const generatedName = authorizer.name || `${serverName}Jwt`;
  const { name: _name, ...definition } = authorizer;
  const existing = authorizers[generatedName];
  if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
    throw new Error(
      `HTTP API authorizer '${generatedName}' is already configured with a different definition`,
    );
  }
  authorizers[generatedName] = definition;
  return generatedName;
}

function normalizePath(value, name) {
  const path = value || '/mcp';
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`MCP server '${name}' path must start with '/'`);
  }
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

module.exports = ServerlessPythonMcpPlugin;
