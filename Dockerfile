FROM node:20-slim

# Dependências do Chromium (necessário para o Puppeteer/WhatsApp)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Usa o Chromium do sistema em vez de baixar um separado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
