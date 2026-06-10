const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');

// Map<userId, { client, ready, qr, destChatId, groupName, initializing }>
const clients = new Map();

function getState(userId) {
  if (!clients.has(userId)) {
    clients.set(userId, { client: null, ready: false, qr: null, destChatId: null, groupName: null, initializing: false });
  }
  return clients.get(userId);
}

function isReady(userId) { return getState(userId).ready; }
function getQR(userId) { return getState(userId).qr; }
function isInitializing(userId) { const s = getState(userId); return s.initializing || !!s.client; }

function setGroupName(userId, name) {
  const state = getState(userId);
  state.groupName = name;
  state.destChatId = null;
}

async function resolveDestChatId(userId) {
  const state = getState(userId);
  if (state.destChatId) return state.destChatId;
  if (!state.groupName) return null;
  const chats = await state.client.getChats();
  const found = chats.find((c) => c.isGroup && c.name === state.groupName);
  if (!found) {
    console.warn(`[WA:${userId}] Grupo "${state.groupName}" não encontrado`);
    return null;
  }
  state.destChatId = found.id._serialized;
  console.log(`[WA:${userId}] Grupo destino: "${found.name}"`);
  return state.destChatId;
}

async function trySend(fn, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[WA] Tentativa ${i}/${retries} falhou: ${err.message}`);
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}

async function sendToGroup(userId, message, imageBuffer, imageUrl) {
  const state = getState(userId);
  if (!state.groupName) throw new Error('Grupo de destino não configurado');
  const chatId = await resolveDestChatId(userId);
  if (!chatId) throw new Error(`Grupo "${state.groupName}" não encontrado`);

  if (imageBuffer && imageUrl) {
    const ext = (imageUrl.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const media = new MessageMedia(mime, imageBuffer.toString('base64'), `produto.${ext}`);
    await trySend(() => state.client.sendMessage(chatId, media, { caption: message }));
  } else {
    await trySend(() => state.client.sendMessage(chatId, message));
  }
}

async function initWhatsApp(userId, groupName) {
  const state = getState(userId);
  if (state.client || state.initializing) {
    if (groupName && !state.groupName) setGroupName(userId, groupName);
    return;
  }

  state.initializing = true;
  if (groupName) state.groupName = groupName;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `user-${userId}`,
      dataPath: path.join(process.cwd(), '.wwebjs_auth'),
    }),
    webVersionCache: { type: 'local', path: './.wwebjs_cache' },
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

  client.on('ready', async () => {
    state.ready = true;
    state.initializing = false;
    console.log(`[WA:${userId}] Conectado e pronto!`);
    if (state.groupName) await resolveDestChatId(userId).catch(() => {});
  });

  client.on('auth_failure', (msg) => {
    state.initializing = false;
    console.error(`[WA:${userId}] Falha de autenticação: ${msg}`);
  });

  client.on('disconnected', (reason) => {
    state.ready = false;
    state.destChatId = null;
    console.warn(`[WA:${userId}] Desconectado:`, reason);
  });

  client.initialize().catch((err) => {
    state.initializing = false;
    state.client = null;
    console.error(`[WA:${userId}] Erro ao inicializar:`, err.message);
  });
}

async function destroyClient(userId) {
  const state = clients.get(userId);
  if (state?.client) {
    try { await state.client.destroy(); } catch {}
  }
  clients.delete(userId);
}

module.exports = { initWhatsApp, sendToGroup, isReady, getQR, isInitializing, setGroupName, destroyClient };
