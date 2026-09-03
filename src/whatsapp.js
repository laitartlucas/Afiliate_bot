const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { getGroupChatCache, setGroupChatCache, pruneGroupChatCache } = require('./database');

const MAX_GROUPS = 20;
// Intervalo entre envios para grupos diferentes, para reduzir o risco de
// bloqueio por comportamento automatizado no WhatsApp. Não é garantia contra
// banimento — apenas uma mitigação razoável para um pequeno número de grupos.
const MIN_SEND_DELAY_MS = 8000;
const MAX_SEND_DELAY_MS = 15000;

// Map<userId, { client, ready, qr, destChatIds: Map<name, chatId>, groupNames: string[], initializing }>
const clients = new Map();

function getState(userId) {
  if (!clients.has(userId)) {
    clients.set(userId, {
      client: null, ready: false, qr: null,
      destChatIds: new Map(), groupNames: [], initializing: false,
    });
  }
  return clients.get(userId);
}

function isReady(userId) { return getState(userId).ready; }
function getQR(userId) { return getState(userId).qr; }
function isInitializing(userId) { const s = getState(userId); return s.initializing || !!s.client; }

function setGroupNames(userId, names) {
  const state = getState(userId);
  state.groupNames = (names || []).slice(0, MAX_GROUPS);
  state.destChatIds = new Map();
  pruneGroupChatCache(userId, state.groupNames);
}

async function resolveDestChatId(userId, groupName) {
  const state = getState(userId);
  if (state.destChatIds.has(groupName)) return state.destChatIds.get(groupName);

  // Cache persistido no SQLite (sobrevive a restart do bot). Antes de
  // confiar nele, validamos que o chat ainda existe/responde via
  // getChatById() — bem mais barato que a varredura completa abaixo. Se
  // falhar (grupo saiu, chat mudou, etc.), cai no fluxo normal de varredura.
  const cached = getGroupChatCache(userId, groupName);
  if (cached?.chat_id) {
    try {
      const chat = await state.client.getChatById(cached.chat_id);
      if (chat) {
        state.destChatIds.set(groupName, cached.chat_id);
        return cached.chat_id;
      }
    } catch (err) {
      console.warn(
        `[WA:${userId}] Cache do banco para "${groupName}" (chat ${cached.chat_id}) não respondeu, refazendo varredura:`,
        err.message
      );
    }
  }

  // NÃO usamos client.getChats() aqui. Aquele método serializa TODOS os chats
  // e, para cada grupo, chama groupMetadata.update()/LidMigration. Se um único
  // chat da conta falhar ao serializar (metadata inválida, migração de LID,
  // canal/newsletter, comunidade...), o Promise.all interno rejeita com um erro
  // minificado ("r: r") e NENHUM grupo é retornado — mesmo os saudáveis.
  //
  // Em vez disso lemos apenas id + nome direto da collection do WhatsApp Web,
  // tolerando falha por chat individual (um chat ruim é ignorado, não derruba
  // a listagem inteira).
  // state.client.pupPage.evaluate() pode falhar intermitentemente com
  // "ProtocolError: Runtime.callFunctionOn timed out" — problema conhecido
  // do whatsapp-web.js relacionado a atualizações do WhatsApp Web, não bug
  // nosso. Tentamos novamente antes de desistir, como em trySend().
  const EVALUATE_RETRIES = 3;
  let groups;
  for (let i = 1; i <= EVALUATE_RETRIES; i++) {
    try {
      groups = await state.client.pupPage.evaluate(() => {
        const out = [];
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        for (const chat of chats) {
          try {
            const id = chat.id && chat.id._serialized;
            if (!id || !id.endsWith('@g.us')) continue; // só grupos
            const name =
              chat.formattedTitle ||
              chat.name ||
              (chat.groupMetadata && chat.groupMetadata.subject) ||
              '';
            out.push({ id, name });
          } catch (_) {
            // chat problemático: ignora e segue
          }
        }
        return out;
      });
      break;
    } catch (err) {
      console.warn(`[WA:${userId}] Tentativa ${i}/${EVALUATE_RETRIES} de listar grupos falhou:`, err.stack || err);
      if (i === EVALUATE_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const found = groups.find((g) => g.name === groupName);
  if (!found) {
    const visiveis = groups.map((g) => g.name).filter(Boolean).join(', ') || 'nenhum';
    console.warn(`[WA:${userId}] Grupo "${groupName}" não encontrado (grupos visíveis: ${visiveis})`);
    return null;
  }
  state.destChatIds.set(groupName, found.id);
  setGroupChatCache(userId, groupName, found.id);
  return found.id;
}

async function trySend(fn, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[WA] Tentativa ${i}/${retries} falhou:`, err.stack || err);
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}

function randomDelay() {
  return MIN_SEND_DELAY_MS + Math.floor(Math.random() * (MAX_SEND_DELAY_MS - MIN_SEND_DELAY_MS));
}

// Envia a mesma mensagem para todos os grupos configurados, com um intervalo
// aleatório entre cada envio. Retorna { sent: string[], failed: {name, error}[] }.
async function sendToGroups(userId, message, imageBuffer, imageUrl) {
  const state = getState(userId);
  if (!state.groupNames.length) throw new Error('Nenhum grupo de destino configurado');

  const media = imageBuffer && imageUrl
    ? new MessageMedia(
        (() => {
          const ext = (imageUrl.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
          return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        })(),
        imageBuffer.toString('base64'),
        'produto.jpg'
      )
    : null;

  const sent = [];
  const failed = [];

  for (let i = 0; i < state.groupNames.length; i++) {
    const groupName = state.groupNames[i];
    try {
      const chatId = await resolveDestChatId(userId, groupName);
      if (!chatId) throw new Error(`Grupo "${groupName}" não encontrado`);

      if (media) await trySend(() => state.client.sendMessage(chatId, media, { caption: message }));
      else await trySend(() => state.client.sendMessage(chatId, message));

      sent.push(groupName);
      console.log(`[WA:${userId}] Enviado para "${groupName}" (${i + 1}/${state.groupNames.length})`);
    } catch (err) {
      failed.push({ name: groupName, error: err.message });
      // Log completo (stack) em vez de só err.message, para não mascarar
      // erros minificados vindos de dentro do contexto do WhatsApp Web.
      console.warn(`[WA:${userId}] Falha ao enviar para "${groupName}":`, err.stack || err);
    }

    if (i < state.groupNames.length - 1) {
      const delay = randomDelay();
      console.log(`[WA:${userId}] Aguardando ${Math.round(delay / 1000)}s antes do próximo grupo...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { sent, failed };
}

async function initWhatsApp(userId, groupNames) {
  const state = getState(userId);
  if (state.client || state.initializing) {
    if (groupNames?.length && !state.groupNames.length) setGroupNames(userId, groupNames);
    return;
  }

  state.initializing = true;
  if (groupNames?.length) state.groupNames = groupNames.slice(0, MAX_GROUPS);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `user-${userId}`,
      dataPath: path.join(process.cwd(), '.wwebjs_auth'),
    }),
    // Cache da versão do WhatsApp Web isolado por usuário. Antes era um
    // único path compartilhado entre todas as sessões — isso podia fazer
    // uma sessão nova herdar/disputar uma versão de bundle incompatível
    // com a conta dela, gerando erros minificados (ex: "r") só nela.
    webVersionCache: {
      type: 'local',
      path: path.join(process.cwd(), '.wwebjs_cache', `user-${userId}`),
    },
    puppeteer: {
      headless: true,
      protocolTimeout: 300000,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--memory-pressure-off',
      ],
    },
  });

  state.client = client;

  client.on('qr', (qr) => {
    state.qr = qr;
    console.log(`\n[WA:${userId}] QR Code disponível\n`);
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    state.qr = null;
    console.log(`[WA:${userId}] Autenticado — sessão salva.`);
  });

  client.on('ready', () => {
    state.ready = true;
    state.initializing = false;
    console.log(`[WA:${userId}] Conectado e pronto!`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[WA:${userId}] Falha de autenticação: ${msg}`);
    // Sem zerar state.client aqui, o Chromium ficava aberto e "zumbi" (nunca
    // autenticado, mas consumindo RAM), e isInitializing() continuava
    // retornando true pra sempre — bloqueando qualquer nova tentativa de
    // conexão pelo /api/status.
    state.initializing = false;
    state.client = null;
    client.destroy().catch(() => {});
  });

  client.on('disconnected', (reason) => {
    console.warn(`[WA:${userId}] Desconectado:`, reason);
    // Mesmo problema do auth_failure: sem derrubar o browser e liberar
    // state.client, a sessão desconectada ficava presa em memória e nunca
    // era reaberta automaticamente pelo auto-init do /api/status.
    state.ready = false;
    state.destChatIds = new Map();
    state.client = null;
    client.destroy().catch(() => {});
  });

  client.initialize().catch((err) => {
    state.initializing = false;
    state.client = null;
    console.error(`[WA:${userId}] Erro ao inicializar:`, err.stack || err.message);
  });
}

async function destroyClient(userId) {
  const state = clients.get(userId);
  if (state?.client) {
    try { await state.client.destroy(); } catch {}
  }
  clients.delete(userId);
}

function getActiveUserIds() {
  return Array.from(clients.keys());
}

module.exports = { initWhatsApp, sendToGroups, isReady, getQR, isInitializing, setGroupNames, destroyClient, getActiveUserIds, MAX_GROUPS };