FROM node:22-bookworm-slim

WORKDIR /app

# Install the official Antigravity CLI used by server/agy.js.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl bash \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://antigravity.google/cli/install.sh | bash

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN npm install --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/server.js"]
