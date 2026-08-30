FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production SSC_DATA_DIR=/data SSC_PORT=8080
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.MOE_PORT || process.env.SSC_PORT||'8080')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["bun", "run", "src/index.ts"]
