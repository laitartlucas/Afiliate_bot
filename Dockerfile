FROM node:20-slim

# Bibliotecas de sistema exigidas para rodar o Chrome for Testing em modo
# headless num container Debian bookworm (base do node:20-slim).
#
# NÃO instalamos o pacote "chromium" da Debian aqui. Esse pacote sempre
# traz a versão mais recente disponível no repositório no momento do
# build, mas o puppeteer-core embutido no whatsapp-web.js foi compilado e
# testado contra uma build EXATA e bem mais antiga do Chrome. Divergência
# entre a versão do navegador e a versão que o puppeteer-core espera causa
# incompatibilidade de protocolo (CDP), que se manifesta como travamentos
# aleatórios do tipo "Runtime.callFunctionOn timed out".
#
# Por isso, deixamos o próprio Puppeteer baixar e gerenciar a build exata
# do Chrome for Testing que ele foi projetado para usar (comportamento
# padrão/recomendado da lib — ver seção "Passo 3" abaixo). Aqui instalamos
# só as libs .so que esse Chrome baixado precisa pra rodar, sem o navegador
# em si.
#
# Se o build falhar ao iniciar o Chrome com erro do tipo
# "error while loading shared libraries: libFoo.so: cannot open shared
# object file", normalmente falta uma lib nesta lista — confira a versão
# atual da documentação oficial do Puppeteer
# (https://pptr.dev/troubleshooting) para Debian/Ubuntu, já que a lista
# pode variar entre versões do Chrome/Debian.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-freefont-ttf \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Passo 3: `npm ci` já dispara o postinstall de cada pacote "puppeteer"
# presente no projeto, que baixa sozinho a build exata do Chrome for
# Testing correspondente àquela versão (comportamento padrão do Puppeteer
# quando PUPPETEER_SKIP_CHROMIUM_DOWNLOAD não está setada — por isso as
# duas linhas ENV que existiam aqui antes foram removidas).
#
# O projeto tem DUAS cópias do puppeteer com versões diferentes:
#   - node_modules/puppeteer          → usada por puppeteer-extra em
#     src/scraper.js (dependência direta do package.json)
#   - node_modules/whatsapp-web.js/node_modules/puppeteer → usada
#     internamente pelo Client do whatsapp-web.js (versão pinada pela lib)
# Cada uma baixa seu próprio Chrome for Testing (revisões diferentes),
# para um cache compartilhado (~/.cache/puppeteer) organizado por versão
# — não há conflito entre elas.
RUN npm ci --omit=dev

# Passo de segurança/diagnóstico: força explicitamente o download do
# Chrome for Testing para as duas cópias do puppeteer, durante o BUILD da
# imagem (não em runtime). Isso garante o download mesmo se o postinstall
# automático do `npm ci` acima tiver sido pulado por algum motivo (ex:
# alguma config de npm/CI desabilitando lifecycle scripts). Os binários
# baixados ficam gravados na própria imagem (não é volume — cada rebuild
# gera uma imagem nova e autocontida com o Chrome já embutido).
#
# Se este passo falhar, rode `npx puppeteer browsers list` localmente
# (fora do Docker, com as mesmas versões do package-lock.json) pra ver
# qual build o comando tentaria baixar e ajuste o comando abaixo caso a
# sintaxe do CLI tenha mudado numa versão futura do puppeteer.
RUN npx puppeteer browsers install chrome \
  && (cd node_modules/whatsapp-web.js && npx puppeteer browsers install chrome)

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
