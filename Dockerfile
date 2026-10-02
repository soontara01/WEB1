# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
# Skip downloading the mongod binary used only by tests.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 public ./public
# Built SPAs: CI places each Angular output (dist/<project>/browser) at apps/<name>/browser before
# `docker build`; enable them at runtime with SPA_APPS=<name>:/app/apps/<name>/browser,...
COPY --chown=1000:1000 apps ./apps
# Numeric UID (the image's `node` user) so Kubernetes `runAsNonRoot: true` can verify it.
USER 1000:1000
EXPOSE 3000
# Used by Docker/compose only; Kubernetes uses the pod's probes (/healthz, /readyz).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist/server.js"]
