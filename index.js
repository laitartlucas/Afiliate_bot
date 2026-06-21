require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./src/database');
const { get: getSetting, set: setSetting } = require('./src/settings');
const { initWhatsApp, sendToGroup, isReady, getQR, isInitializing, setGroupName, destroyClient } = require('./src/whatsapp');
const { scrapeProduct, scrapeShopeeProduct, downloadImage } = require('./src/scraper');
const { generateSalesMessage } = require('./src/ai');

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
  const groupName = getSetting('DEST_GROUP_NAME', userId);

  // Auto-init WhatsApp on first status check
  if (!isInitializing(userId)) {
    initWhatsApp(userId, groupName).catch((err) =>
      console.error(`[WA:${userId}] Erro ao inicializar:`, err.message)
    );
  }

  res.json({
    ready: isReady(userId),
    hasQR: !!getQR(userId),
    groupName: groupName || '',
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

app.post('/api/settings', requireAuth, (req, res) => {
  if (req.session.isAdmin) return res.status(403).json({ error: 'Admin não usa o bot' });
  const userId = req.session.userId;
  const { groupName } = req.body;
  if (!groupName?.trim()) return res.status(400).json({ error: 'Nome do grupo é obrigatório' });
  setSetting('DEST_GROUP_NAME', groupName.trim(), userId);
  setGroupName(userId, groupName.trim());
  console.log(`[SETTINGS:${userId}] Grupo destino: "${groupName.trim()}"`);
  res.json({ success: true });
});

app.post('/api/process', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url, coupon } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });
  if (!isReady(userId)) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });
  if (!getSetting('DEST_GROUP_NAME', userId)) return res.status(400).json({ error: 'Configure o nome do grupo antes de enviar.' });

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

    await sendToGroup(userId, message, imageBuffer, product.imageUrl);
    console.log(`[PIPELINE:${userId}] Enviado!`);

    res.json({ success: true, message, product });
  } catch (err) {
    console.error(`[PIPELINE:${userId}] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shopee/analyze', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    console.log(`[SHOPEE:${userId}] Analisando: ${url.trim()}`);
    const product = await scrapeShopeeProduct(url.trim());
    res.json({ success: true, product });
  } catch (err) {
    console.error(`[SHOPEE:${userId}] Erro ao analisar:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shopee/process', requireAuth, requireActiveSubscription, async (req, res) => {
  const userId = req.session.userId;
  const { url, title, currentPrice, originalPrice, discountPercent, imageUrl, coupon } = req.body;

  if (!url?.trim()) return res.status(400).json({ error: 'URL é obrigatória' });
  if (!isReady(userId)) return res.status(503).json({ error: 'WhatsApp não está conectado ainda.' });
  if (!getSetting('DEST_GROUP_NAME', userId)) return res.status(400).json({ error: 'Configure o nome do grupo antes de enviar.' });

  const product = {
    title: title?.trim() || null,
    currentPrice: currentPrice !== undefined && currentPrice !== '' ? parseFloat(currentPrice) : null,
    originalPrice: originalPrice !== undefined && originalPrice !== '' ? parseFloat(originalPrice) : null,
    discountPercent: discountPercent !== undefined && discountPercent !== '' ? parseInt(discountPercent, 10) : null,
    imageUrl: imageUrl?.trim() || null,
    features: [],
    url: url.trim(),
  };

  try {
    console.log(`[SHOPEE:${userId}] Processando: "${product.title}"`);
    const message = await generateSalesMessage(product, coupon?.trim().toUpperCase() || null);
    console.log(`[SHOPEE:${userId}] Mensagem gerada`);

    let imageBuffer = null;
    if (product.imageUrl) {
      try { imageBuffer = await downloadImage(product.imageUrl); }
      catch (err) { console.warn(`[SHOPEE:${userId}] Imagem não baixada:`, err.message); }
    }

    await sendToGroup(userId, message, imageBuffer, product.imageUrl);
    console.log(`[SHOPEE:${userId}] Enviado!`);

    res.json({ success: true, message, product });
  } catch (err) {
    console.error(`[SHOPEE:${userId}] Erro:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n[SERVER] Acesse http://localhost:${PORT}\n`);
  console.log(`[SERVER] Admin: usuário "admin", senha definida em ADMIN_PASSWORD\n`);
});
