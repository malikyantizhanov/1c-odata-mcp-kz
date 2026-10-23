# Общий HTTP-режим коннектора (src/http.ts): один сервис на много пользователей — учётка базы приходит с каждым
# запросом в заголовке X-OneC-Connection, доступ к сервису — по ключу MCP_HTTP_TOKEN. См. docs/HTTP-MODE.md.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    MCP_LOG_STDERR=1 \
    PORT=8080 \
    READ_ONLY=true \
    ODATA_RETRIES=1 \
    ODATA_WRITE_JOURNAL_DIR=/data/write-journal \
    ODATA_CACHE_DIR=/data/cache \
    ODATA_PRINT_DIR=/data/print
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
