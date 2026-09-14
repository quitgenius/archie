// Read Pi's live model at turn start, after session selection / cron overrides.
// Pi supplies the base prompt each time, so identities never accumulate across turns.
export function createModelContextExtension() {
  return (pi) => {
    pi.on('before_agent_start', (event, ctx) => {
      const model = ctx.model;
      if (!model?.id) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n<active_model>\n${JSON.stringify({
          modelId: model.id,
          runtimeProvider: model.provider,
        })}\n</active_model>\n`
          + 'This is the actual model serving this turn, supplied by the runtime. '
          + 'When asked what model you are using, answer from this model ID. '
          + 'For Amazon Bedrock, the ID identifies the model publisher and model; Amazon Bedrock is the hosting service. '
          + 'This current identity supersedes model identity claims in earlier messages or workspace notes. '
          + 'Do not infer your model from your assistant persona or earlier replies.',
      };
    });
  };
}
