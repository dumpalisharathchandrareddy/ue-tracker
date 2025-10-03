# Dockerfile — Discord UberEats tracker (Railway ready)
FROM node:22-bookworm

# Install Chromium + runtime deps + curl for healthcheck
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

# Use system Chromium (Puppeteer won’t download its own)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Install deps
COPY package*.json ./
# Prefer clean install; if lockfile mismatch, fall back to install
RUN npm ci --omit=dev || npm install --omit=dev

# Copy app
COPY . .

# Railway provides PORT env at runtime; don't hardcode it here
# Expose is optional for docs only
EXPOSE 3000

# Healthcheck: use Railway-provided $PORT
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD sh -lc 'curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1'

# Start the bot
CMD ["node", "app.js"]
