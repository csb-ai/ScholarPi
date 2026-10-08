import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
export type McpResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class KnowledgeClient {
  private client?: Client;
  private connecting?: Promise<Client>;
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    return (this.connecting ??= this.open());
  }
  private async open() {
    try {
      const client = new Client({ name: 'scholarpi-web', version: '0.1.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpUrl)));
      this.client = client;
      return client;
    } finally {
      this.connecting = undefined;
    }
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpResult> {
    const invoke = async () => {
      const c = await this.connect();
      return (await c.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 60000,
      })) as McpResult;
    };
    try {
      return await invoke();
    } catch (e) {
      if (e instanceof Error && e.message.includes('Session not found')) {
        await this.close();
        return invoke();
      }
      if (e instanceof Error && e.message.includes('fetch failed')) {
        await this.close();
        throw new BusinessError(
          'RETRYABLE_FAILURE',
          '知识服务暂不可用，请重试；写操作保留原幂等标识',
        );
      }
      throw e;
    }
  }
  async operation<T = Record<string, unknown>>(
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const r = await this.call('app_operation', { operation, args });
    const data =
      r.structuredContent ??
      JSON.parse(
        r.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n') || '{}',
      );
    if (r.isError)
      throw new BusinessError(
        String(data.code ?? (data.error as { code?: string })?.code ?? 'RETRYABLE_FAILURE'),
        String(
          data.message ?? (data.error as { message?: string })?.message ?? JSON.stringify(data),
        ),
      );
    return data as T;
  }
  async close() {
    await this.client?.close();
    this.client = undefined;
  }
}
export const knowledge = new KnowledgeClient();
