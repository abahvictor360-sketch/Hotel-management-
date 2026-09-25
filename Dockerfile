ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json ./
RUN npm ci && npm run generate && npm run build
RUN mkdir -p /app/backups && chown -R node:node /app
USER node
EXPOSE 4000 4001
CMD ["npm","start"]
