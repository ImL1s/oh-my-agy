import * as readline from 'readline';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  McpOperationContextV1,
  invokeMcpOperation,
  listMcpTools,
} from './operations';

export const OMA_MCP_PROTOCOL_VERSION_V1 = '2025-03-26' as const;

export interface JsonRpcRequestV1 {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseV1 {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function handleMcpJsonRpc(
  rawRequest: unknown,
  context: Readonly<McpOperationContextV1>,
): Promise<JsonRpcResponseV1 | null> {
  let request: JsonRpcRequestV1;
  try {
    request = parseRequest(rawRequest);
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: typeof (error as { rpcCode?: unknown }).rpcCode === 'number'
          ? (error as { rpcCode: number }).rpcCode : -32600,
        message: error instanceof Error ? error.message : 'Invalid JSON-RPC request',
      },
    };
  }
  const id = request.id ?? null;
  const notification = request.id === undefined;
  try {
    let result: unknown;
    if (request.method === 'initialize') {
      result = {
        protocolVersion: OMA_MCP_PROTOCOL_VERSION_V1,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'oh-my-agy', version: '1' },
      };
    } else if (request.method === 'ping') {
      result = {};
    } else if (request.method === 'tools/list') {
      result = { tools: listMcpTools() };
    } else if (request.method === 'tools/call') {
      const params = plainObject(request.params, 'tools/call params');
      if (typeof params.name !== 'string') throw new Error('E_MCP_ARGUMENT: tool name is required');
      const structuredContent = await invokeMcpOperation(
        params.name,
        params.arguments ?? {},
        context,
      );
      result = {
        content: [{ type: 'text', text: canonicalBytesV1(structuredContent).toString('utf8') }],
        structuredContent,
        isError: false,
      };
    } else if (request.method.startsWith('notifications/')) {
      result = {};
    } else {
      throw Object.assign(new Error(`Method not found: ${request.method}`), { rpcCode: -32601 });
    }
    return notification ? null : { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (notification) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: typeof (error as { rpcCode?: unknown }).rpcCode === 'number'
          ? (error as { rpcCode: number }).rpcCode : -32602,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function startMcpNdjsonServer(
  context: Readonly<McpOperationContextV1>,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const lines = readline.createInterface({ input });
  let chain = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    chain = chain.then(async () => {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
        })}\n`);
        return;
      }
      const response = await handleMcpJsonRpc(request, context);
      if (response !== null) output.write(`${canonicalBytesV1(response).toString('utf8')}\n`);
    });
  });
}

function parseRequest(value: unknown): JsonRpcRequestV1 {
  const request = plainObject(value, 'request');
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string'
    || (request.id !== undefined && request.id !== null
      && typeof request.id !== 'string' && typeof request.id !== 'number')) {
    throw Object.assign(new Error('Invalid JSON-RPC request'), { rpcCode: -32600 });
  }
  return request as unknown as JsonRpcRequestV1;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`E_MCP_ARGUMENT: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

if (require.main === module) {
  const repositoryRoot = process.env.OMA_REPOSITORY_ROOT ?? process.cwd();
  const stateRoot = process.env.OMA_STATE_ROOT ?? `${repositoryRoot}/.agy/state`;
  startMcpNdjsonServer({ repositoryRoot, stateRoot });
}
