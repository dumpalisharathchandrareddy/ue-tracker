FROM node:22-bookworm

# Chromium + deps + curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    curl \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Do not set ENV PORT — Railway injects it
EXPOSE 3000

# Healthcheck that tolerates missing PORT by defaulting to 3000 (for local tests)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD sh -lc 'curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1'

CMD ["node", "app.js"]
