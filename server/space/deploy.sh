#!/usr/bin/env bash
# Deploy the demo server to a Hugging Face Docker Space: ./server/space/deploy.sh [<owner>/<space>]
# Needs a write token in HF_TOKEN, or `hf auth login`. The `hf` CLI command can be set with HF (default: uvx)
set -euo pipefail

SPACE="${1:-vemonet/uniprot-agent}"
HF="${HF:-uvx --from huggingface_hub hf}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# Files needed to build the image, with the repo layout: tracked or not ignored, so never `.env` or builds
cd "$ROOT"
git ls-files -z --cached --others --exclude-standard -- \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts pyproject.toml uv.lock \
  .dockerignore packages/js packages/solid packages/python server |
  while IFS= read -r -d '' file; do
    # Skip files deleted from the working tree
    if [ -f "$file" ]; then mkdir -p "$OUT/$(dirname "$file")" && cp "$file" "$OUT/$file"; fi
  done

# The Space builds the Dockerfile at its root, and shows the README with its config in front matter
cp server/Dockerfile "$OUT/Dockerfile"
cp server/space/README.md "$OUT/README.md"
# LLM of the Space: OpenRouter, with its key in the `OPENAI_API_KEY` Space secret. Space variables override these
cat >>"$OUT/Dockerfile" <<'EOF'
ENV OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
    MODELS=deepseek/deepseek-v4.1-flash,anthropic/claude-haiku-5.5
EOF

$HF repos create "$SPACE" --type space --sdk docker --exist-ok
# Files not in this upload are deleted from the Space
$HF upload "$SPACE" "$OUT" . --type space --delete "*" \
  --commit-message "Deploy $(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo ' with local changes')"
echo "Deployed to https://huggingface.co/spaces/$SPACE"
