# THROWAWAY spike image (Phase 0). Minimal SSE echo server — no Pi, no deps.
#   docker build --platform linux/arm64 -f agentcore-pi/spike/Dockerfile \
#     -t <ecr>/clawdbot-agentcore:spike-sse agentcore-pi/spike
FROM node:22-slim
WORKDIR /app
COPY sse-echo-server.mjs .
EXPOSE 8080
CMD ["node", "sse-echo-server.mjs"]
