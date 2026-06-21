const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

async function resolveUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      maxRedirects: 10,
      timeout: 15000,
      validateStatus: (s) => s < 400,
    });
    return res.request?.res?.responseUrl || res.request?.responseURL || url;
  } catch (err) {
    if (err.response?.headers?.location) return err.response.headers.location;
    return url;
  }
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function extractJsonLd($) {
  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    try {
      const data = JSON.parse($(el).html() || '{}');
      if (data['@type'] === 'Product') product = data;
      else if (Array.isArray(data['@graph']))
        product = data['@graph'].find((n) => n['@type'] === 'Product') || null;
    } catch {}
  });
  return product;
}

async function scrapeProduct(originalUrl) {
  const url = await resolveUrl(originalUrl);
  console.log(`[SCRAPER] URL final: ${url}`);

  const res = await axios.get(url, { headers: HEADERS, timeout: 20000, validateStatus: (s) => s < 400 });
  const $ = cheerio.load(res.data);

  const title =
    $('h1.ui-pdp-title').text().trim() ||
    $('h1[class*="title"]').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().replace(/\s*\|.*$/, '').trim();

  const imageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('.ui-pdp-gallery__figure img').first().attr('data-zoom') ||
    $('.ui-pdp-gallery__figure img').first().attr('src') ||
    $('img.ui-pdp-image').first().attr('src') ||
    '';

  let currentPrice = null;
  let originalPrice = null;
  let discountPercent = null;

  // 1. Preço atual — aria-label="Agora: X reais..." (mais confiável)
  const $agoraEl = $('[aria-label^="Agora:"]').first();
  if ($agoraEl.length) {
    const f = $agoraEl.find('.andes-money-amount__fraction').text().trim();
    const c = $agoraEl.find('.andes-money-amount__cents').text().trim();
    if (f) currentPrice = parsePrice(f + (c ? `,${c}` : ''));
  }

  // 2. Fallback: classe --cents-superscript (elemento visual do preço atual)
  if (!currentPrice) {
    const $el = $('.andes-money-amount--cents-superscript').first();
    const f = $el.find('.andes-money-amount__fraction').text().trim();
    const c = $el.find('.andes-money-amount__cents').text().trim();
    if (f) currentPrice = parsePrice(f + (c ? `,${c}` : ''));
  }

  // 3. Fallback: JSON-LD (pode conter preço original em vez do atual)
  if (!currentPrice) {
    const jsonLd = extractJsonLd($);
    if (jsonLd?.offers) {
      const offers = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
      const rawLow = offers?.lowPrice ? parseFloat(offers.lowPrice) : null;
      const rawPrice = offers?.price ? parseFloat(offers.price) : null;
      currentPrice = rawLow || rawPrice || null;
    }
  }

  // Preço original — aria-label="Antes: X reais..." (dentro de <s>)
  const $antesEl = $('[aria-label^="Antes:"]').first();
  if ($antesEl.length) {
    const f = $antesEl.find('.andes-money-amount__fraction').text().trim();
    const c = $antesEl.find('.andes-money-amount__cents').text().trim();
    if (f) originalPrice = parsePrice(f + (c ? `,${c}` : ''));
  }

  // Fallback preço original: classe --previous (elemento visual riscado)
  if (!originalPrice) {
    const $el = $('.andes-money-amount--previous').first();
    const f = $el.find('.andes-money-amount__fraction').text().trim();
    const c = $el.find('.andes-money-amount__cents').text().trim();
    if (f) originalPrice = parsePrice(f + (c ? `,${c}` : ''));
  }

  const discountLabel = $('.ui-pdp-price__second-line__label,[data-testid="discount"],[class*="discount-label"]').first().text().trim();
  const discountMatch = discountLabel.match(/(\d+)\s*%/);
  if (discountMatch) {
    discountPercent = parseInt(discountMatch[1], 10);
  } else if (originalPrice && currentPrice && originalPrice > currentPrice) {
    discountPercent = Math.round((1 - currentPrice / originalPrice) * 100);
  }

  console.log(`[SCRAPER] Preço atual: ${currentPrice} | Preço original: ${originalPrice} | Desconto: ${discountPercent}%`);

  const features = [];
  $('.ui-pdp-features__item').each((_, el) => {
    const text = $(el).text().trim();
    if (text) features.push(text);
  });
  if (features.length === 0) {
    $('.andes-table__row,.ui-pdp-specs__table tr').each((_, el) => {
      const key = $(el).find('.andes-table__column--left,th').text().trim();
      const val = $(el).find('.andes-table__column--right,td').last().text().trim();
      if (key && val) features.push(`${key}: ${val}`);
    });
  }

  return { title, currentPrice, originalPrice, discountPercent, imageUrl, features: features.slice(0, 8), url: originalUrl };
}

// ── Shopee ───────────────────────────────────────────────────────────────────
// Shopee bloqueia requisições HTTP simples (axios/cheerio), por isso usamos um
// navegador headless real para renderizar a página antes de extrair os dados.

let shopeeBrowser = null;

async function getShopeeBrowser() {
  if (shopeeBrowser) return shopeeBrowser;
  shopeeBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  shopeeBrowser.on('disconnected', () => { shopeeBrowser = null; });
  return shopeeBrowser;
}

function parseShopeePriceText(text) {
  if (!text) return null;
  const match = text.replace(/\s/g, '').match(/R\$\s*([\d.,]+)/i);
  if (!match) return null;
  return parsePrice(match[1]);
}

async function scrapeShopeeProduct(originalUrl) {
  const url = await resolveUrl(originalUrl);
  console.log(`[SCRAPER:Shopee] URL final: ${url}`);

  const result = {
    title: null, currentPrice: null, originalPrice: null,
    discountPercent: null, imageUrl: null, features: [],
    url: originalUrl, scraped: false,
  };

  let page;
  try {
    const browser = await getShopeeBrowser();
    page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': HEADERS['Accept-Language'] });
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('h1, [class*="price"]', { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || null;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content || null;
      const h1Title = document.querySelector('h1')?.innerText?.trim() || null;

      const strikedEl = Array.from(document.querySelectorAll('*')).find((el) => {
        const style = window.getComputedStyle(el);
        return style.textDecorationLine?.includes('line-through') && /R\$/.test(el.innerText || '');
      });

      const bodyText = document.body.innerText || '';
      const priceMatches = bodyText.match(/R\$\s*[\d.,]+/g) || [];

      const discountMatch = bodyText.match(/-\s*(\d{1,3})\s*%/);
      const blocked = /página indisponível|page unavailable|verifique que você é humano|complete a verificação/i.test(bodyText);

      return {
        ogTitle,
        ogImage,
        h1Title,
        strikedText: strikedEl ? strikedEl.innerText : null,
        firstPriceText: priceMatches[0] || null,
        discountPercent: discountMatch ? parseInt(discountMatch[1], 10) : null,
        blocked,
      };
    });

    result.title = !data.blocked ? (data.h1Title || data.ogTitle || null) : null;
    result.imageUrl = !data.blocked ? (data.ogImage || null) : null;
    result.currentPrice = data.blocked ? null : parseShopeePriceText(data.firstPriceText);
    result.originalPrice = data.blocked ? null : parseShopeePriceText(data.strikedText);
    result.discountPercent = data.discountPercent
      || (result.originalPrice && result.currentPrice && result.originalPrice > result.currentPrice
        ? Math.round((1 - result.currentPrice / result.originalPrice) * 100)
        : null);
    result.scraped = !data.blocked && !!(result.title || result.currentPrice || result.imageUrl);
    if (data.blocked) console.warn('[SCRAPER:Shopee] Página de bloqueio/verificação detectada.');

    console.log(`[SCRAPER:Shopee] Título: "${result.title}" | Preço: ${result.currentPrice} | Imagem: ${result.imageUrl ? 'sim' : 'não'}`);
  } catch (err) {
    console.warn('[SCRAPER:Shopee] Falha ao extrair dados automaticamente:', err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return result;
}

async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': HEADERS['User-Agent'] },
  });
  return Buffer.from(res.data);
}

module.exports = { scrapeProduct, scrapeShopeeProduct, downloadImage };
