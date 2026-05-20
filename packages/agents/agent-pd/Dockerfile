FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Copy shared packages first (changes less often — better layer caching)
COPY packages/client/py/ /app/packages/client/py/
COPY packages/ctls/py/ /app/packages/ctls/py/
COPY packages/amp/py/ /app/packages/amp/py/
COPY packages/langchain/py/ /app/packages/langchain/py/

# Copy full agent package (hatchling needs source present to build editables)
COPY packages/agents/agent-pd/ /app/packages/agents/agent-pd/

# Install dependencies
WORKDIR /app/packages/agents/agent-pd
RUN uv sync --frozen --no-dev

EXPOSE 8804

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8804/health')"

CMD ["uv", "run", "agent-pd"]
