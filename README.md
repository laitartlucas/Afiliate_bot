# 🤖 ML Affiliate Bot — WhatsApp + Mercado Livre + Shopee + Amazon + Claude AI

Painel web multi-usuário para grupos de ofertas no WhatsApp. Você cola o link de afiliado (Mercado Livre, Shopee ou Amazon) na interface, o bot analisa o produto com IA e envia a descrição pronta com imagem para os grupos de destino configurados.

---

## 🚀 Como Funciona

```
[Interface Web]                [Bot Node.js]                  [Grupos WhatsApp]
Você cola o link   ──────►  Scraping do produto         ──────►  📸 Imagem
de afiliado                 Análise com Claude AI                💬 Descrição top
                             Download da imagem                  🔗 Link original
```

1. Você faz login na interface web e cola um link de afiliado (Mercado Livre, Shopee ou Amazon)
2. O bot faz scraping do produto (título, preço, imagem, características)
3. A Claude API cria uma descrição impactante com emojis e CTA
4. O bot envia imagem + descrição + link para os grupos de destino cadastrados na sua conta

Cada usuário tem sua própria conexão de WhatsApp (via QR Code) e sua própria lista de grupos de destino, gerenciadas por um administrador em `/admin`.

---

## 📋 Pré-requisitos

- Node.js 18+
- Um número de WhatsApp por usuário (ou o seu, ciente de que ficará conectado)
- Chave de API da Anthropic → [console.anthropic.com](https://console.anthropic.com)
- Estar presente nos grupos de destino do WhatsApp de cada usuário

---

## ⚙️ Instalação

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/ml-affiliate-bot.git
cd ml-affiliate-bot

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
```

Edite o arquivo `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
ADMIN_PASSWORD=senha-do-admin-aqui
SESSION_SECRET=string-aleatoria-longa-aqui
PORT=3000

# Opcional — API oficial de afiliados da Shopee. Sem isso, o bot usa
# scraping via navegador headless como alternativa.
SHOPEE_APP_ID=
SHOPEE_APP_SECRET=
```

---

## ▶️ Uso

```bash
npm start
```

1. Acesse `http://localhost:3000/admin` e entre com usuário `admin` e a senha definida em `ADMIN_PASSWORD`.
2. Crie um usuário para cada conta de WhatsApp que vai enviar ofertas (usuário, senha e, opcionalmente, data de vencimento da assinatura).
3. Cada usuário faz login na raiz (`/`), escaneia o **QR Code** exibido na tela com o WhatsApp que vai enviar as ofertas (Configurações → Aparelhos conectados → Conectar aparelho) e cadastra os grupos de destino pela própria interface.

A sessão do WhatsApp fica salva localmente por usuário — nos próximos starts, não precisa escanear de novo. Depois de conectado, basta colar o link de afiliado (Mercado Livre, Shopee ou Amazon) na tela correspondente e enviar.

---

## 📁 Estrutura do Projeto

```
ml-affiliate-bot/
├── .env                  # Variáveis de ambiente (não commitar)
├── .env.example          # Exemplo de configuração
├── package.json
├── index.js              # Ponto de entrada — rotas Express e orquestração
├── public/
│   ├── login.html        # Tela de login
│   ├── app.html           # Tela principal do usuário (WhatsApp, grupos, envio)
│   └── admin.html         # Painel de administração de usuários
└── src/
    ├── database.js       # Usuários e assinaturas (SQLite)
    ├── settings.js       # Configurações por usuário (grupos de destino)
    ├── whatsapp.js        # Cliente WhatsApp e lógica de grupos
    ├── scraper.js         # Scraping do Mercado Livre, Shopee e Amazon
    ├── shopeeApi.js        # API oficial de afiliados da Shopee (opcional)
    └── ai.js              # Integração com Claude API
```

---

## 🛠️ Stack

| Ferramenta | Uso |
|---|---|
| [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) | Automação do WhatsApp via Puppeteer |
| [Anthropic SDK](https://github.com/anthropic/anthropic-sdk-node) | Geração de descrições com Claude |
| [axios](https://axios-http.com) + [cheerio](https://cheerio.js.org) | Scraping do Mercado Livre |
| [dotenv](https://github.com/motdotla/dotenv) | Gerenciamento de variáveis de ambiente |

---

## 💡 Exemplo de Saída

> 🔥 **Fone Bluetooth JBL Tune 510BT**
>
> ~~R$ 249,90~~ → **R$ 189,90** ✅ 24% OFF
>
> ✔️ Até 40h de bateria  
> ✔️ Pure Bass Sound  
> ✔️ Dobrável — fácil de guardar  
> ✔️ Conexão com 2 dispositivos simultaneamente  
>
> ⚡ Promoção por tempo limitado! Corre que tá voando 👇  
> [link do produto]

---

## 🔧 Produção com PM2

Para rodar em segundo plano e reiniciar automaticamente:

```bash
npm install -g pm2
pm2 start index.js --name ml-bot
pm2 save
pm2 startup
```

---

## ⚠️ Avisos Importantes

- **whatsapp-web.js** é uma biblioteca não oficial. O WhatsApp pode banir números que automatizam envios em massa. Use com moderação.
- O Mercado Livre ocasionalmente muda seus seletores CSS. Se o scraping parar de funcionar, inspecione a página e atualize `src/scraper.js`.
- Não compartilhe sua `ANTHROPIC_API_KEY` nem a commite no repositório.
- O arquivo `.wwebjs_auth/` (sessão do WhatsApp) também não deve ser commitado.

---

## 📄 .gitignore recomendado

```
node_modules/
.env
.wwebjs_auth/
.wwebjs_cache/
data/
```

---

## 📜 Licença

MIT — use, modifique e distribua à vontade.

---

Feito com ☕ e Claude AI
