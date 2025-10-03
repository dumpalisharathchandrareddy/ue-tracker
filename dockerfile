# Dockerfile — Railway friendly (Chromium installed)
FROM node:22-bookworm

# Install Chromium + runtime deps
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
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

# Simple healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT||3000) + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
