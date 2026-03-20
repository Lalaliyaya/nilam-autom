# Dockerfile for NILAM AutoM — Cloud Deployment (Railway / Render / Fly.io)
# Puppeteer with Chromium runs headlessly inside this container
FROM node:20-slim

# Install Chromium and required libs for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chromium (use system one)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Always run headless in cloud
ENV HEADLESS=true

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Expose the web port
EXPOSE 3000

CMD ["node", "server.js"]
