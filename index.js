// Rede de segurança contra crash total do processo Node.
//
// A biblioteca whatsapp-web.js (via Puppeteer) pode lançar exceções não
// capturadas ao processar eventos internos de uma conta específica — por
// exemplo, ao lidar com um LOGOUT/desconexão. Sem esses handlers, esse erro
// isolado derruba o processo inteiro e desconecta TODAS as contas, não só a
// que teve o problema. O ideal a longo prazo é que a aplicação continue
// rodando normalmente para as outras contas mesmo se uma delas falhar; até lá,
// isso evita a queda total. Os logs abaixo são propositalmente bem visíveis
// para permitir identificar se isso está ocorrendo com frequência e investigar
// a causa raiz.
process.on('uncaughtException', (err) => {
  console.error('[CRASH PREVENIDO] uncaughtException:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason) => {
  const stack = reason && reason.stack ? reason.stack : reason;
  console.error('[CRASH PREVENIDO] unhandledRejection:', stack);
});

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./src/database');
const { get: getSetting, set: setSetting } = require('./src/settings');
const { initWhatsApp, sendToGroups, isReady, getQR, isInitializing, setGroupNames, destroyClient, getActiveUserIds, requestPairingCode, getClient, MAX_GROUPS } = require('./src/whatsapp');
const { scrapeProduct, scrapeShopeeProduct, scrapeAmazonProduct, downloadImage } = require('./src/scraper');
const shopeeApi = require('./src/shopeeApi');
const { generateSalesMessage } = require('./src/ai');

// Lista de grupos de destino, com migração automática do formato antigo
// (DEST_GROUP_NAME, um único grupo) para o novo (DEST_GROUPS, lista).
function getGroups(userId) {
  const list = getSetting('DEST_GROUPS', userId);
  if (Array.isArray(list)) return list;
  const legacy = getSetting('DEST_GROUP_NAME', userId);
  return legacy ? [legacy] : [];
}

function saveGroups(userId, groups) {
  setSetting('DEST_GROUPS', groups, userId);
  setGroupNames(userId, groups);
}

// Usa a API oficial de afiliados da Shopee quando configurada (SHOPEE_APP_ID/
// SHOPEE_APP_SECRET); caso contrário cai no scraping via navegador headless.
async function getShopeeProduct(url) {
  if (shopeeApi.isConfigured()) {
    try {
      const product = await shopeeApi.getShopeeProductViaApi(url);
      if (product.scraped) return product;
      console.warn('[SHOPEE] API oficial não retornou dados, tentando scraping como fallback.');
    } catch (err) {
      console.warn('[SHOPEE] Erro na API oficial, tentando scraping como fallback:', err.message);
    }
  }
  return scrapeShopeeProduct(url);
}

const required = ['ANTHROPIC_API_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[BOT] Variáveis ausentes no .env: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Middleware ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.isAdmin || req.session?.userId != null) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Acesso negado' });
  res.redirect('/');
}

function requireActiveSubscription(req, res, next) {
  const user = db.getUser(req.session.userId);
  if (!user || !user.active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
  if (!db.isSubscriptionActive(user)) {
    return res.status(402).json({
      error: 'subscription_expired',
      message: 'Sua assinatura expirou. Entre em contato para renovar o acesso.',
    });
  }
  next();
}

// ── Public routes ────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.userId != null) return res.redirect(req.session.isAdmin ? '/admin' : '/');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password?.trim()) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }

  if (username.trim() === 'admin' && password === process.env.ADMIN_PASSWORD) {
    req.session.userId = null;
    req.session.isAdmin = true;
    req.session.username = 'admin';
    return res.json({ success: true, redirect: '/admin' });
  }

  const user = db.getUserByUsername(username.trim());
  if (!user || !db.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'Conta desativada. Entre em contato com o administrador.' });
  }

  req.session.userId = user.id;
  req.session.isAdmin = false;
  req.session.username = user.username;
  res.json({ success: true, redirect: '/' });
});

// ── Admin routes ─────────────────────────────────────────────────────────────

app.get('/admin', requireAuth, requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, expiresAt } = req.body;
  if (!username?.trim() || !password?.trim()) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  try {
    const id = db.createUser(username.trim(), password.trim(), expiresAt || null);
    console.log(`[ADMIN] Usuário criado: "${username.trim()}" (id=${id})`);
    res.json({ success: true, id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Usuário já existe' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { password, expiresAt, active } = req.body;

  if (password?.trim()) db.setPassword(id, password.trim());

  const fields = {};
  if (expiresAt !== undefined) fields.subscription_expires_at = expiresAt || null;
  if (active !== undefined) fields.active = active ? 1 : 0;
  if (Object.keys(fields).length) db.updateUser(id, fields);

  if (active === false || active === 0) destroyClient(id).catch(() => {});

  console.log(`[ADMIN] Usuário ${id} atualizado:`, { expiresAt, active });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await destroyClient(id).catch(() => {});
  db.deleteUser(id);
  console.log(`[ADMIN] Usuário ${id} excluído`);
  res.json({ success: true });
});

// ── User routes ──────────────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public/app.html'));
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });

  const userId = req.session.userId;
  const user = db.getUser(userId);
  const subscriptionActive = db.isSubscriptionActive(user);
  const groups = getGroups(userId);

  // Auto-init WhatsApp on first status check
  if (!isInitializing(userId)) {
    initWhatsApp(userId, groups).catch((err) =>
      console.error(`[WA:${userId}] Erro ao inicializar:`, err.message)
    );
  }

  res.json({
    ready: isReady(userId),
    hasQR: !!getQR(userId),
    groups,
    maxGroups: MAX_GROUPS,
    subscriptionActive,
    subscriptionExpiresAt: user?.subscription_expires_at || null,
    username: req.session.username,
  });
});

app.get('/api/qr', requireAuth, async (req, res) => {
  if (req.session.isAdmin) return res.json({ qr: null });
  const qrString = getQR(req.session.userId);
  if (!qrString) return res.json({ qr: null });
  const dataUrl = await QRCode.toDataURL(qrString, {
    width: 260, margin: 2, color: { dark: '#000', light: '#fff' },
  });
  res.json({ qr: dataUrl });
});

app.post('/api/whatsapp/pairing-code', requireAuth, async (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });
  const userId = req.session.userId;
  const phoneNumber = req.body.phoneNumber?.trim();
  if (!phoneNumber) return res.status(400).json({ error: 'Número de telefone é obrigatório' });

  try {
    const code = await requestPairingCode(userId, phoneNumber);
    res.json({ code });
  } catch (err) {
    console.error(`[WA:${userId}] Erro ao gerar código de pareamento:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// TEMPORÁRIO - remover depois do diagnóstico. Envia uma mensagem direta para
// um número (fora do fluxo de grupos), retornando o retorno bruto de
// sendMessage() para inspecionar campos como "ack".
app.post('/api/debug/send-direct', requireAuth, async (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });
  const userId = req.session.userId;
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber e message são obrigatórios' });
  }

  const client = getClient(userId);
  if (!client) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });

  try {
    const chatId = `${phoneNumber}@c.us`;
    const result = await client.sendMessage(chatId, message);
    res.json({ chatId, result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, stack: err.stack } });
  }
});

app.post('/api/settings/groups', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });
  const userId = req.session.userId;
  const name = req.body.groupName?.trim();
  if (!name) return res.status(400).json({ error: 'Nome do grupo é obrigatório' });

  const groups = getGroups(userId);
  if (groups.includes(name)) return res.status(409).json({ error: 'Esse grupo já foi adicionado' });
  if (groups.length >= MAX_GROUPS) return res.status(400).json({ error: `Limite de ${MAX_GROUPS} grupos atingido` });

  groups.push(name);
  saveGroups(userId, groups);
  console.log(`[SETTINGS:${userId}] Grupo adicionado: "${name}" (${groups.length}/${MAX_GROUPS})`);
  res.json({ success: true, groups });
});

app.delete('/api/settings/groups', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });
  const userId = req.session.userId;
  const name = req.body.groupName?.trim();
  if (!name) return res.status(400).json({ error: 'Nome do grupo é obrigatório' });

  const groups = getGroups(userId).filter((g) => g !== name);
  saveGroups(userId, groups);
  console.log(`[SETTINGS:${userId}] Grupo removido: "${name}" (${groups.length}/${MAX_GROUPS})`);
  res.json({ success: true, groups });
});

app.post('/api/process', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url, coupon } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });
  if (!isReady(userId)) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });
  if (!getGroups(userId).length) return res.status(400).json({ error: 'Adicione ao menos um grupo antes de enviar.' });

  try {
    console.log(`[PIPELINE:${userId}] Processando: ${url.trim()}`);
    const product = await scrapeProduct(url.trim());
    console.log(`[PIPELINE:${userId}] Produto: "${product.title}"`);

    const message = await generateSalesMessage(product, coupon?.trim().toUpperCase() || null);
    console.log(`[PIPELINE:${userId}] Mensagem gerada`);

    let imageBuffer = null;
    if (product.imageUrl) {
      try { imageBuffer = await downloadImage(product.imageUrl); }
      catch (err) { console.warn(`[PIPELINE:${userId}] Imagem não baixada:`, err.message); }
    }

    const { sent, failed } = await sendToGroups(userId, message, imageBuffer, product.imageUrl);
    console.log(`[PIPELINE:${userId}] Enviado para ${sent.length}/${sent.length + failed.length} grupos`);

    res.json({ success: true, message, product, sent, failed });
  } catch (err) {
    console.error(`[PIPELINE:${userId}] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shopee/process', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url, title, currentPrice, originalPrice, discountPercent, imageUrl, coupon } = req.body;

  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });
  if (!isReady(userId)) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });
  if (!getGroups(userId).length) return res.status(400).json({ error: 'Adicione ao menos um grupo antes de enviar.' });

  let product;
  if (title?.trim()) {
    // Dados já revisados/informados manualmente pelo cliente
    product = {
      title: title.trim(),
      currentPrice: currentPrice !== undefined && currentPrice !== '' ? parseFloat(currentPrice) : null,
      originalPrice: originalPrice !== undefined && originalPrice !== '' ? parseFloat(originalPrice) : null,
      discountPercent: discountPercent !== undefined && discountPercent !== '' ? parseInt(discountPercent, 10) : null,
      imageUrl: imageUrl?.trim() || null,
      features: [],
      url: url.trim(),
    };
  } else {
    // Fluxo automático: raspa os dados agora, sem etapa de revisão manual
    console.log(`[SHOPEE:${userId}] Analisando automaticamente: ${url.trim()}`);
    product = await getShopeeProduct(url.trim());
    if (!product.scraped) {
      return res.status(422).json({
        error: 'Não conseguimos identificar os dados desse produto automaticamente (a Shopee bloqueou a análise). Tente novamente em alguns instantes ou use outro link.',
      });
    }
  }

  try {
    console.log(`[SHOPEE:${userId}] Processando: "${product.title}"`);
    const message = await generateSalesMessage(product, coupon?.trim().toUpperCase() || null);
    console.log(`[SHOPEE:${userId}] Mensagem gerada`);

    let imageBuffer = null;
    if (product.imageUrl) {
      try { imageBuffer = await downloadImage(product.imageUrl); }
      catch (err) { console.warn(`[SHOPEE:${userId}] Imagem não baixada:`, err.message); }
    }

    const { sent, failed } = await sendToGroups(userId, message, imageBuffer, product.imageUrl);
    console.log(`[SHOPEE:${userId}] Enviado para ${sent.length}/${sent.length + failed.length} grupos`);

    res.json({ success: true, message, product, sent, failed });
  } catch (err) {
    console.error(`[SHOPEE:${userId}] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/amazon/process', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url, title, currentPrice, originalPrice, discountPercent, imageUrl, coupon } = req.body;

  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });
  if (!isReady(userId)) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });
  if (!getGroups(userId).length) return res.status(400).json({ error: 'Adicione ao menos um grupo antes de enviar.' });

  let product;
  if (title?.trim()) {
    // Dados já revisados/informados manualmente pelo cliente
    product = {
      title: title.trim(),
      currentPrice: currentPrice !== undefined && currentPrice !== '' ? parseFloat(currentPrice) : null,
      originalPrice: originalPrice !== undefined && originalPrice !== '' ? parseFloat(originalPrice) : null,
      discountPercent: discountPercent !== undefined && discountPercent !== '' ? parseInt(discountPercent, 10) : null,
      imageUrl: imageUrl?.trim() || null,
      features: [],
      url: url.trim(),
    };
  } else {
    // Fluxo automático: raspa os dados agora, sem etapa de revisão manual
    console.log(`[AMAZON:${userId}] Analisando automaticamente: ${url.trim()}`);
    product = await scrapeAmazonProduct(url.trim());
    if (!product.scraped) {
      return res.status(422).json({
        error: 'Não conseguimos identificar os dados desse produto automaticamente (a Amazon bloqueou a análise). Tente novamente em alguns instantes ou use outro link.',
      });
    }
  }

  try {
    console.log(`[AMAZON:${userId}] Processando: "${product.title}"`);
    const message = await generateSalesMessage(product, coupon?.trim().toUpperCase() || null);
    console.log(`[AMAZON:${userId}] Mensagem gerada`);

    let imageBuffer = null;
    if (product.imageUrl) {
      try { imageBuffer = await downloadImage(product.imageUrl); }
      catch (err) { console.warn(`[AMAZON:${userId}] Imagem não baixada:`, err.message); }
    }

    const { sent, failed } = await sendToGroups(userId, message, imageBuffer, product.imageUrl);
    console.log(`[AMAZON:${userId}] Enviado para ${sent.length}/${sent.length + failed.length} grupos`);

    res.json({ success: true, message, product, sent, failed });
  } catch (err) {
    console.error(`[AMAZON:${userId}] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`\n[SERVER] Acesse http://localhost:${PORT}\n`);
  console.log(`[SERVER] Admin: usuário "admin", senha definida em ADMIN_PASSWORD\n`);
});

// Encerramento gracioso: SIGTERM (enviado pelo Docker ao reiniciar/atualizar o
// container) e SIGINT (Ctrl+C) matavam o Chromium do Puppeteer de forma
// abrupta, deixando para trás arquivos de trava (SingletonLock) e processos
// zumbis. Aqui destruímos cada cliente WhatsApp explicitamente antes de sair,
// com um timeout de segurança para não estourar o período de graça do Docker
// (10s por padrão).
let shuttingDown = false;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('[SHUTDOWN] Encerramento gracioso iniciado...');

  const forceExitTimer = setTimeout(() => {
    console.error('[SHUTDOWN] Timeout de 8s atingido, forçando encerramento.');
    process.exit(0);
  }, 8000);
  forceExitTimer.unref();

  try {
    await Promise.all(getActiveUserIds().map((userId) => destroyClient(userId).catch(() => {})));
    console.log('[SHUTDOWN] Todos os clientes encerrados.');
  } catch (err) {
    console.error('[SHUTDOWN] Erro ao encerrar clientes:', err && err.stack ? err.stack : err);
  }

  clearTimeout(forceExitTimer);
  if (server) server.close();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
