# Pathogen Data Network agent: MCP servers, AG-UI agent and chat UI. Built from the repo root:
# docker build -f pdn-agent/Dockerfile -t pdn-agent .

# JS bundle of the chat UI
FROM node:24-slim AS js
WORKDIR /repo
# CA certificates for the vp binary
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts ./
COPY packages/js/package.json packages/js/
COPY packages/solid/package.json packages/solid/
# No scripts: `prepare` installs git hooks
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/js packages/js
COPY packages/solid packages/solid
RUN pnpm exec vp run --filter light-chat build

# Python workspace, with the JS bundle in the light-chat package
FROM ghcr.io/astral-sh/uv:0.11.21-python3.13-trixie-slim
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages/python packages/python
COPY pdn-agent pdn-agent
COPY --from=js /repo/packages/js/dist/index.js packages/python/src/light_chat/static/light-chat.js
RUN uv sync --frozen --no-editable --package pdn-agent

# Non-root user, owning the folder of the request log
RUN useradd --create-home --uid 1000 app && mkdir -p /app/pdn-agent/data && chown app /app/pdn-agent/data
USER app
WORKDIR /app/pdn-agent
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
# Number of uvicorn worker processes. One: the NCBI, GEO and PubMed tools pace their requests to the NCBI limit
# per IP (3/s, 10/s with NCBI_API_KEY) within a process, each worker would add its own share
ENV WEB_CONCURRENCY=1
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/info')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
