FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
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

RUN groupadd -r nestjs && useradd -rm -g nestjs nestjs
RUN chown -R nestjs:nestjs /app
USER nestjs

EXPOSE 3000
# node:22-bookworm-slim no trae wget; el healthcheck usa node (fetch nativo, Node 22).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["sh", "-c", "node dist/database/seeds/seed.js && exec node dist/main"]
