# The base image is pinned by digest (same value in the three stages) for reproducible builds; it receives no
# security patches by itself. Refresh it every month or two: `docker buildx imagetools inspect node:22-bookworm-slim`,
# copy the top-level "Digest", replace it in the three FROM lines and check with `docker build .`.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runner
ENV LANG=en_US.UTF-8
ENV DBUS_SESSION_BUS_ADDRESS=autolaunch:
# Puppeteer uses Debian's own Chromium instead of downloading Chrome for Testing — that download
# has no linux/arm64 build and is one more moving part (network, exact revision) than apt needs.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY --from=deps    /app/node_modules  ./node_modules
COPY --from=builder /app/dist          ./dist
# JSON Schemas of the messages (ST-76.1): MessageValidator reads them at runtime from ./contracts/messages.
COPY --from=builder /app/contracts     ./contracts

# Install Chromium, fonts, and dbus (requires root)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg \
      fonts-khmeros fonts-kacst fonts-freefont-ttf dbus dbus-x11 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Keep the opt-in manual publisher available for `docker compose run` without exposing it as an API.
COPY --from=builder /app/scripts/pubsub/publish-grupo-h-and-simulate.mjs ./scripts/pubsub/

RUN groupadd -r nestjs && useradd -rm -g nestjs nestjs
RUN chown -R nestjs:nestjs /app
USER nestjs

EXPOSE 3000
# node:22-bookworm-slim no trae wget; el healthcheck usa node (fetch nativo, Node 22).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["sh", "-c", "node dist/database/seeds/seed.js && exec node dist/main"]
