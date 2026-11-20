# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/actions/package.json ./packages/actions/
COPY packages/ai/package.json ./packages/ai/
COPY packages/security/package.json ./packages/security/
COPY packages/embed/package.json ./packages/embed/
COPY packages/testkit/package.json ./packages/testkit/
COPY apps/reference-host/package.json ./apps/reference-host/

FROM manifests AS build
# Keep dependency installation independent of source changes.
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/contracts/tsconfig*.json ./packages/contracts/
COPY packages/actions/tsconfig*.json ./packages/actions/
COPY packages/ai/tsconfig*.json ./packages/ai/
COPY packages/security/tsconfig*.json ./packages/security/
COPY apps/reference-host/tsconfig*.json ./apps/reference-host/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/actions/src ./packages/actions/src
COPY packages/ai/src ./packages/ai/src
COPY packages/security/src ./packages/security/src
COPY apps/reference-host/src ./apps/reference-host/src
RUN npm run build:host

FROM manifests AS production-deps
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Preserve workspace manifests and npm's relative workspace symlinks.
COPY --from=production-deps /app/ ./
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/actions/dist ./packages/actions/dist
COPY --from=build /app/packages/ai/dist ./packages/ai/dist
COPY --from=build /app/packages/security/dist ./packages/security/dist
COPY --from=build /app/apps/reference-host/dist ./apps/reference-host/dist
COPY db ./db
USER node
EXPOSE 3000
CMD ["node", "apps/reference-host/dist/index.js"]
