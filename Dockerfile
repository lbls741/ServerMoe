FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production MOE_DATA_DIR=/data MOE_PORT=8080
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
COPY LICENSE THIRD-PARTY-NOTICES.md ./
LABEL org.opencontainers.image.title="ServerMoe" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.description="私有部署微信消息网关（ServerChan 兼容推送 + 关键词路由）" \
      org.opencontainers.image.source="https://github.com/lbls741/SeverMoe"
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.MOE_PORT || process.env.SSC_PORT||'8080')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["bun", "run", "src/index.ts"]
