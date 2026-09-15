// Shared by the Pi runtime and gateway. Only reviewed conversational models belong here.
// Exact IDs deliberately prevent a newly listed embedding/image/video model becoming an agent.
export const CHAT_MODEL_IDS = new Set([
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-opus-4-7',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-20250514-v1:0',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-fable-5',
  'anthropic.claude-sonnet-5',
  'anthropic.claude-opus-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-fable-5-1',
  'amazon.nova-micro-v1:0',
  'amazon.nova-lite-v1:0',
  'amazon.nova-pro-v1:0',
  'amazon.nova-premier-v1:0',
  'amazon.nova-2-lite-v1:0',
  'openai.gpt-5.6-sol',
  'openai.gpt-5.6-terra',
  'openai.gpt-5.6-luna',
  'openai.gpt-6-astra',
  'xai.grok-4.6',
]);

export const foundationModelId = (id) => String(id || '').replace(/^(?:us|eu|ap|apac|au|jp|global)\./, '');
// These profiles still appear ACTIVE in ListInferenceProfiles, but live invocation on 2026-09-14
// rejected them. Keep definitions for existing configs; do not offer them as working choices.
// Re-enable only after the corresponding lifecycle/retention requirement is resolved and tested.
// US Fable 5 verified in production and 5.1 in Austin sandbox with aws_review on 2026-09-15.
// Other deployments must configure compatible Bedrock retention before invoking them.
export const UNAVAILABLE_MODELS = {
  'anthropic.claude-3-sonnet-20240229-v1:0': 'Retired model',
  'anthropic.claude-3-haiku-20240307-v1:0': 'Legacy model access restricted by AWS',
  'anthropic.claude-opus-4-1-20250805-v1:0': 'Legacy model access restricted by AWS',
  'amazon.nova-premier-v1:0': 'Legacy model access restricted by AWS',
};
export const isSelectableModel = (id) => typeof id === 'string' && id.startsWith('us.')
  && CHAT_MODEL_IDS.has(foundationModelId(id)) && !UNAVAILABLE_MODELS[foundationModelId(id)];

// AWS model cards, checked 2026-09-14:
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html
// maxTokens below is an operational output budget, not a claim about the model's maximum.
// Pi's fixed per-token price cannot represent OpenAI's context-dependent pricing. NaN keeps
// its cost arithmetic safe while causing the adapter to OMIT cost telemetry, never report $0.
const UNPRICED = { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN };
const EXTRA_MODELS = {
  // Historical definition retained for saved configurations; this model is not selectable.
  'anthropic.claude-3-sonnet-20240229-v1:0': {
    name: 'Anthropic Claude 3 Sonnet', contextWindow: 200000, maxTokens: 4096, reasoning: false,
  },
  'openai.gpt-5.6-sol': { name: 'OpenAI GPT-5.6 Sol', contextWindow: 1000000 },
  'openai.gpt-5.6-terra': { name: 'OpenAI GPT-5.6 Terra', contextWindow: 1000000 },
  'openai.gpt-5.6-luna': { name: 'OpenAI GPT-5.6 Luna', contextWindow: 1000000 },
  'openai.gpt-6-astra': { name: 'OpenAI GPT-6 Astra', contextWindow: 1050000 },
  'xai.grok-4.6': { name: 'xAI Grok 4.6', contextWindow: 500000 },
};

// The catalog lookup is injected so the gateway can import the eligibility list without Pi.
export function resolveRegisteredModel(id, lookup) {
  const baseId = foundationModelId(id);
  if (!CHAT_MODEL_IDS.has(baseId)) return null;
  const base = lookup(baseId);
  if (base) return { ...base, id, _registeredFrom: baseId };
  const extra = EXTRA_MODELS[baseId];
  if (!extra) return null; // Claude's existing catalog/sibling/factory ladder handles it.
  return {
    id, provider: 'amazon-bedrock', api: 'bedrock-converse-stream',
    baseUrl: `https://bedrock-runtime.${process.env.AWS_REGION || process.env.REGION || 'us-east-1'}.amazonaws.com`,
    input: ['text', 'image'], reasoning: true, maxTokens: 8192,
    ...extra,
    cost: { ...UNPRICED }, _registeredFrom: 'aws-model-card',
  };
}
