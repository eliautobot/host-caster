# Host-Caster server + web app in one image. Build: docker build -t hostcaster .  Run: see docker-compose.yml and
# docs/SELF-HOSTING.md. The server serves the built web app, the API, sign-in and the AI apps connector on port 8660.

# ---- 1. build the web app (Vite) --------------------------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY app/ ./
RUN npx vite build --outDir /src/dist

# ---- 2. server dependencies (production only, no native modules) -----------------------------------------------
FROM node:24-slim AS deps
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 3. runtime ---------------------------------------------------------------------------------------------------
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8660 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    APP_DIST=/opt/hostcaster/app/dist
WORKDIR /opt/hostcaster/server
COPY --from=deps /src/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /src/dist /opt/hostcaster/app/dist
RUN mkdir -p /data /music && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8660
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8660) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.js"]
