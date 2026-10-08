import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { config, ROOT } from './config.js';
let runtimePromise: Promise<ModelRuntime> | undefined;
export function modelRuntime(): Promise<ModelRuntime> {
  return (runtimePromise ??= create());
}
async function create() {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: path.join(ROOT, 'data/runtime-auth.json'),
    modelsStorePath: path.join(ROOT, 'data/models-store.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('agnes', {
    baseUrl: config.baseUrl,
    api: 'openai-completions',
    authHeader: true,
    models: [
      {
        id: config.model,
        name: 'Agnes 3.0 Flash',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 524288,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
        },
      },
    ],
  });
  if (config.apiKey) await runtime.setRuntimeApiKey('agnes', config.apiKey);
  return runtime;
}
