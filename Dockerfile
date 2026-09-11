# syntax=docker/dockerfile:1

# ---- deps: install once, cached on the lockfile ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: needs no API keys, only the source ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- run: standalone output only ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# PORT is deliberately not set. Railway and most platforms inject their own and
# expect the server to listen on it; a baked-in value shadows theirs and the
# request never arrives. server.js falls back to 3000 when PORT is unset.
ENV HOSTNAME=0.0.0.0

# next.config.ts sets output: "standalone", which emits a self-contained
# server.js with only the modules the app actually imports.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Every credential and tuning value is read from the environment at runtime,
# so one image serves any endpoint or model:
#   docker run --env-file .env -p 3000:3000 <image>
CMD ["node", "server.js"]
