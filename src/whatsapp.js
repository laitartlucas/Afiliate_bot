const axios = require('axios');
const { getGroupChatCache, setGroupChatCache, pruneGroupChatCache } = require('./database');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

const api = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_API_KEY },
  timeout: 30000,
});

const MAX_GROUPS = 20;
// Intervalo entre envios para grupos diferentes, para reduzir o risco de
// bloqueio por comportamento automatizado no WhatsApp. Não é garantia contra
// banimento — apenas uma mitigação razoável para um pequeno número de grupos.
const MIN_SEND_DELAY_MS = 8000;
const MAX_SEND_DELAY_MS = 15000;

// Map<userId, { instanceName, created, ready, qr, destGroupIds: Map<name, jid>, groupNames: string[], initializing }>
const clients = new Map();

function getState(userId) {
  if (!clients.has(userId)) {
    clients.set(userId, {
      instanceName: `user-${userId}`,
      created: false,
      ready: false,
      qr: null,
      destGroupIds: new Map(),
      groupNames: [],
      initializing: false,
    });
  }
  return clients.get(userId);
}

function isApiError(err, statusPredicate, textMatch) {
  const status = err.response?.status;
  if (statusPredicate && !statusPredicate(status)) return false;
  const body = JSON.stringify(err.response?.data || '').toLowerCase();
  return body.includes(textMatch);
}

async function createInstance(instanceName) {
  try {
    await api.post('/instance/create', { instanceName, integration: 'WHATSAPP-BAILEYS' });
  } catch (err) {
    // A Evolution API responde com erro (403) se a instância já existe.
    // Como o nome é determinístico (user-${userId}), isso normalmente
    // significa que já criamos essa instância antes (ex: bot reiniciou e
    // perdeu o estado em memória) — tratamos como sucesso, não como falha.
    if (isApiError(err, (s) => s === 403 || s === 409, 'already in use')) return;
    throw err;
  }
}

async function connectInstance(instanceName, number) {
  const res = await api.get(`/instance/connect/${instanceName}`, number ? { params: { number } } : undefined);
  return res.data || {};
}

async function getConnectionState(instanceName) {
  const res = await api.get(`/instance/connectionState/${instanceName}`);
  return res.data?.instance?.state;
}

async function fetchAllGroups(instanceName) {
  const res = await api.get(`/group/fetchAllGroups/${instanceName}`, { params: { getParticipants: false } });
  return Array.isArray(res.data) ? res.data : [];
}

async function findGroupInfo(instanceName, groupJid) {
  const res = await api.get(`/group/findGroupInfos/${instanceName}`, { params: { groupJid } });
  return res.data;
}

async function sendText(instanceName, number, text) {
  await api.post(`/message/sendText/${instanceName}`, { number, text });
}

async function sendMedia(instanceName, number, media, caption) {
  const ext = media.mimetype === 'image/png' ? 'png' : media.mimetype === 'image/webp' ? 'webp' : 'jpg';
  await api.post(`/message/sendMedia/${instanceName}`, {
    number,
    mediatype: 'image',
    mimetype: media.mimetype,
    media: media.base64,
    fileName: `produto.${ext}`,
    caption,
  });
}

async function isReady(userId) {
  const state = getState(userId);
  try {
    const connState = await getConnectionState(state.instanceName);
    const open = connState === 'open';
    state.ready = open;
    if (open) state.qr = null;
    return open;
  } catch (err) {
    // Instância pode ainda não existir (init em andamento, ou bot acabou de
    // subir e o auto-init do /api/status ainda não rodou) — tratamos como
    // "não pronto" em vez de propagar erro, já que os callers só checam bool.
    console.warn(`[WA:${userId}] Falha ao consultar connectionState:`, err.response?.data || err.message);
    return false;
  }
}

function getQR(userId) { return getState(userId).qr; }
function isInitializing(userId) { const s = getState(userId); return s.initializing || s.created; }

function setGroupNames(userId, names) {
  const state = getState(userId);
  state.groupNames = (names || []).slice(0, MAX_GROUPS);
  state.destGroupIds = new Map();
  pruneGroupChatCache(userId, state.groupNames);
}

function normalizeName(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function trySend(fn, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      // Erros de validação da própria API (4xx, exceto 429/rate-limit) não se
      // resolvem tentando de novo — ex: payload inválido, instância inexistente.
      // Só vale re-tentar erro de rede/timeout ou instabilidade do servidor.
      const isClientError = status && status >= 400 && status < 500 && status !== 429;
      if (isClientError || i === retries) throw err;
      console.warn(`[WA] Tentativa ${i}/${retries} falhou:`, err.response?.data || err.message);
      await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
}

function randomDelay() {
  return MIN_SEND_DELAY_MS + Math.floor(Math.random() * (MAX_SEND_DELAY_MS - MIN_SEND_DELAY_MS));
}

async function resolveGroupId(userId, groupName) {
  const state = getState(userId);
  if (state.destGroupIds.has(groupName)) return state.destGroupIds.get(groupName);

  // Cache persistido no SQLite (sobrevive a restart do bot). Antes de
  // confiar nele, validamos que o grupo ainda existe via findGroupInfos —
  // bem mais barato que buscar a lista inteira de grupos. Se falhar (saiu
  // do grupo, JID mudou etc.), cai no fluxo normal de varredura abaixo.
  const cached = getGroupChatCache(userId, groupName);
  if (cached?.chat_id) {
    try {
      const info = await findGroupInfo(state.instanceName, cached.chat_id);
      if (info?.group?.id) {
        state.destGroupIds.set(groupName, cached.chat_id);
        return cached.chat_id;
      }
    } catch (err) {
      console.warn(
        `[WA:${userId}] Cache do banco para "${groupName}" (grupo ${cached.chat_id}) não respondeu, refazendo varredura:`,
        err.response?.data || err.message
      );
    }
  }

  const groups = await trySend(() => fetchAllGroups(state.instanceName));
  const target = normalizeName(groupName);
  const found = groups.find((g) => normalizeName(g.subject) === target);
  if (!found) {
    const visiveis = groups.map((g) => g.subject).filter(Boolean).join(', ') || 'nenhum';
    console.warn(`[WA:${userId}] Grupo "${groupName}" não encontrado (grupos visíveis: ${visiveis})`);
    return null;
  }
  state.destGroupIds.set(groupName, found.id);
  setGroupChatCache(userId, groupName, found.id);
  return found.id;
}

// Envia a mesma mensagem para todos os grupos configurados, com um intervalo
// aleatório entre cada envio. Retorna { sent: string[], failed: {name, error}[] }.
// Recebe imageUrl (além do buffer já baixado) só para inferir a extensão/
// mimetype da imagem, do mesmo jeito que o código anterior fazia.
async function sendToGroups(userId, message, imageBuffer, imageUrl) {
  const state = getState(userId);
  if (!state.groupNames.length) throw new Error('Nenhum grupo de destino configurado');

  const media = imageBuffer
    ? {
        mimetype: (() => {
          const ext = (imageUrl || '').split('?')[0].split('.').pop()?.toLowerCase();
          return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        })(),
        base64: imageBuffer.toString('base64'),
      }
    : null;

  const sent = [];
  const failed = [];

  for (let i = 0; i < state.groupNames.length; i++) {
    const groupName = state.groupNames[i];
    try {
      const groupId = await resolveGroupId(userId, groupName);
      if (!groupId) throw new Error(`Grupo "${groupName}" não encontrado`);

      if (media) await trySend(() => sendMedia(state.instanceName, groupId, media, message));
      else await trySend(() => sendText(state.instanceName, groupId, message));

      sent.push(groupName);
      console.log(`[WA:${userId}] Enviado para "${groupName}" (${i + 1}/${state.groupNames.length})`);
    } catch (err) {
      failed.push({ name: groupName, error: err.response?.data?.message || err.message });
      console.warn(`[WA:${userId}] Falha ao enviar para "${groupName}":`, err.response?.data || err.stack || err);
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
  if (groupNames?.length && !state.groupNames.length) setGroupNames(userId, groupNames);
  if (state.initializing || state.created) return;

  state.initializing = true;
  try {
    await createInstance(state.instanceName);
    state.created = true;
    try {
      const { base64 } = await connectInstance(state.instanceName);
      state.qr = base64 || null;
      console.log(
        `[WA:${userId}] Instância "${state.instanceName}" pronta para conectar. ${
          state.qr ? 'QR Code disponível.' : 'Sem QR retornado (instância pode já estar conectada).'
        }`
      );
    } catch (err) {
      // Instância foi criada mas o connect falhou (ex: já conectada). Não é
      // fatal — isReady()/getQR() continuam funcionando a partir daqui.
      console.warn(`[WA:${userId}] Instância criada, mas falha ao iniciar conexão:`, err.response?.data || err.message);
    }
  } catch (err) {
    state.created = false;
    console.error(`[WA:${userId}] Erro ao criar instância:`, err.response?.data || err.message);
  } finally {
    state.initializing = false;
  }
}

// Gera um código de pareamento (ex: "ABCD-1234") como alternativa ao QR code
// para vincular o WhatsApp, associado a um número de telefone específico.
//
// AVISO: diferente dos demais endpoints deste arquivo, o parâmetro `number`
// em GET /instance/connect/{instance}?number=... NÃO foi validado
// manualmente contra a Evolution API — só QR code (sem number) foi
// confirmado. Testar manualmente antes de depender deste fluxo em produção.
async function requestPairingCode(userId, phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, '');
  if (!digits || digits.length < 10 || digits.length > 15) {
    throw new Error('Número de telefone inválido. Use o formato internacional sem símbolos, ex: 5511999999999');
  }

  const state = getState(userId);
  if (await isReady(userId)) throw new Error('WhatsApp já está conectado.');

  if (!state.created && !state.initializing) await initWhatsApp(userId);

  const WAIT_RETRIES = 15;
  const WAIT_DELAY_MS = 2000;
  for (let i = 1; i <= WAIT_RETRIES; i++) {
    if (state.created) break;
    if (i === WAIT_RETRIES) throw new Error('WhatsApp não ficou pronto para gerar o código de pareamento a tempo.');
    await new Promise((r) => setTimeout(r, WAIT_DELAY_MS));
  }

  const { code } = await connectInstance(state.instanceName, digits);
  if (!code) throw new Error('A Evolution API não retornou um código de pareamento para este número.');
  console.log(`[WA:${userId}] Código de pareamento gerado.`);
  return code;
}

async function destroyClient(userId) {
  const state = clients.get(userId);
  if (state) {
    try {
      await api.delete(`/instance/logout/${state.instanceName}`);
    } catch (err) {
      console.warn(`[WA:${userId}] Erro ao desconectar instância:`, err.response?.data || err.message);
    }
    try {
      await api.delete(`/instance/delete/${state.instanceName}`);
      console.log(`[WA:${userId}] Instância removida com sucesso.`);
    } catch (err) {
      console.warn(`[WA:${userId}] Erro ao remover instância:`, err.response?.data || err.message);
    }
  }
  clients.delete(userId);
}

function getActiveUserIds() {
  return Array.from(clients.keys());
}

module.exports = { initWhatsApp, sendToGroups, isReady, getQR, isInitializing, setGroupNames, destroyClient, getActiveUserIds, requestPairingCode, MAX_GROUPS };
