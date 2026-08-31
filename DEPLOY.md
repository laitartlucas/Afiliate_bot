# Deploy em VPS (Docker + Caddy)

Guia para colocar o bot no ar em um VPS Ubuntu novo (ex: Hetzner), rodando **sempre ligado**
(sem scale-to-zero) via Docker Compose, com HTTPS automático via Caddy.

> Se você prefere manter a opção de voltar para o Fly.io no futuro, os arquivos `fly.toml` e
> `.github/workflows/fly-deploy.yml` continuam no repositório e não são afetados por este guia.

## 1. Provisionar o VPS

Crie um VPS Ubuntu 22.04/24.04 (ex: Hetzner CX22 — 2 vCPU / 4GB RAM é um bom ponto de partida
considerando que o Chromium do Puppeteer consome memória). Anote o IP público.

## 2. Instalar Docker e Docker Compose

Conecte via SSH no VPS e rode:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Saia e reconecte via SSH para o grupo `docker` ter efeito (ou rode `newgrp docker`). O script
oficial do Docker já instala o plugin `docker compose` (v2) junto.

Confirme:

```bash
docker --version
docker compose version
```

## 3. Clonar o repositório

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <url-do-seu-repositorio> afiliate-bot
cd afiliate-bot
```

## 4. Criar o `.env` de produção

Copie o exemplo e preencha os valores reais:

```bash
cp .env.example .env
nano .env
```

Preencha pelo menos:

- `ANTHROPIC_API_KEY` — chave da API da Anthropic.
- `ADMIN_PASSWORD` — senha do painel admin.
- `SESSION_SECRET` — string aleatória longa (ex: `openssl rand -hex 32`).
- `PORT` — pode manter `3000` (não é exposto ao host, só usado internamente).
- `SHOPEE_APP_ID` / `SHOPEE_APP_SECRET` — opcionais, só se for usar a API oficial da Shopee.
- `DOMAIN` — o domínio que vai apontar para este VPS (ex: `bot.seudominio.com`).
- `LETSENCRYPT_EMAIL` — e-mail para o Let's Encrypt (avisos de expiração de certificado).

O `.env` **não é commitado** (já está no `.gitignore`) — mantenha uma cópia segura fora do
repositório (ex: gerenciador de senhas) para reconstruir o servidor se precisar.

## 5. Apontar o domínio para o VPS

No painel DNS do seu domínio, crie um registro **A** apontando para o IP público do VPS:

| Tipo | Nome                  | Valor (IP do VPS) |
|------|-----------------------|--------------------|
| A    | `bot` (ou `@`)         | `SEU.IP.PUBLICO`   |

Espere a propagação do DNS antes de subir o Caddy (pode levar de minutos a algumas horas).
Verifique com:

```bash
dig +short bot.seudominio.com
```

Certifique-se também de que as portas **80** e **443** estão liberadas no firewall do VPS
(o Let's Encrypt precisa da porta 80 para validar o domínio):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable
```

## 6. Subir os containers

```bash
docker compose up -d --build
```

Isso builda a imagem do bot a partir do `Dockerfile` existente e sobe dois serviços:

- `bot` — a aplicação (WhatsApp + servidor Express), sem porta exposta ao host.
- `caddy` — proxy reverso, escuta em 80/443 no host e emite/renova o certificado TLS
  automaticamente para o `DOMAIN` configurado no `.env`.

## 7. Escanear o QR Code do WhatsApp

Acompanhe os logs para escanear o QR code na primeira inicialização:

```bash
docker compose logs -f bot
```

Depois de escanear, a sessão fica salva em `./.wwebjs_auth` (bind mount no host) — **não será
perdida** em restarts ou atualizações do container, só se você apagar essa pasta manualmente.

## 8. Ver logs

```bash
# logs de todos os serviços
docker compose logs -f

# só o bot
docker compose logs -f bot

# só o Caddy (útil para depurar emissão de certificado)
docker compose logs -f caddy
```

## 9. Backup

Os dados que importam estão todos em bind mounts na raiz do projeto no host:

- `data/` — banco SQLite (usuários, configurações).
- `.wwebjs_auth/` — sessão autenticada do WhatsApp (perder isso = escanear QR de novo).
- `.wwebjs_cache/` — cache de versão do WhatsApp Web (não crítico, pode ser recriado).

Backup simples (com o bot rodando; `better-sqlite3` grava de forma segura, mas para consistência
máxima do `.db` prefira parar o bot brevemente antes do backup em produção crítica):

```bash
tar -czf backup-$(date +%Y%m%d-%H%M%S).tar.gz data .wwebjs_auth
```

Copie o arquivo gerado para fora do VPS (ex: `scp`, ou envie para armazenamento externo).
Automatize com um cron job se quiser backups periódicos:

```bash
# crontab -e
0 3 * * * cd /caminho/para/afiliate-bot && tar -czf /root/backups/afiliate-bot-$(date +\%Y\%m\%d).tar.gz data .wwebjs_auth
```

## 10. Atualizar o bot no futuro

```bash
cd afiliate-bot
git pull
docker compose up -d --build
```

Isso reconstrói só a imagem do `bot` (o Caddy não precisa rebuild, a menos que você mude o
`Caddyfile`) e recria os containers. **A sessão do WhatsApp não é perdida** porque
`.wwebjs_auth` é um bind mount fora do container — ele sobrevive à recriação do container,
só seria perdido se você apagasse a pasta manualmente ou rodasse algo como
`docker compose down -v` combinado com remoção dos bind mounts (bind mounts não são removidos
por `-v`, só volumes nomeados — mas tome cuidado mesmo assim).

Para reiniciar sem rebuild (ex: só mudou o `.env`):

```bash
docker compose up -d
```

## Troubleshooting rápido

- **Caddy não emite certificado**: confirme que o DNS já propagou (`dig +short $DOMAIN`) e que
  as portas 80/443 estão realmente acessíveis de fora (`curl -I http://SEU.IP` de outra máquina).
- **Bot reiniciando em loop / Chromium crashando**: aumente `mem_limit` no `docker-compose.yml`
  (de 1536m para 2048m, por exemplo) e rode `docker compose up -d` novamente.
- **Perdi a sessão do WhatsApp**: verifique se `.wwebjs_auth/` ainda existe no host
  (`ls -la .wwebjs_auth`). Se sim, o problema é outro (versão do WhatsApp Web mudou, sessão
  expirada no celular etc.) — vai pedir novo QR code mesmo com os dados intactos.
