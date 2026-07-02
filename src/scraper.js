const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

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

// ── Navegador headless compartilhado ────────────────────────────────────────
// Shopee e Amazon bloqueiam requisições HTTP simples (axios/cheerio) com
// páginas de verificação/captcha, por isso usamos um navegador headless real
// para renderizar a página antes de extrair os dados.

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

// ── Shopee ───────────────────────────────────────────────────────────────────

function parseShopeePriceText(text) {
  if (!text) return null;
  const match = text.replace(/\s/g, '').match(/R\$\s*([\d.,]+)/i);
  if (!match) return null;
  return parsePrice(match[1]);
}

async function scrapeShopeeProductOnce(originalUrl) {
  const result = {
    title: null, currentPrice: null, originalPrice: null,
    discountPercent: null, imageUrl: null, features: [],
    url: originalUrl, scraped: false,
  };

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': HEADERS['Accept-Language'] });
    await page.setViewport({ width: 1280, height: 900 });

    // Navega direto no link curto original — deixa o próprio Chrome seguir toda
    // a cadeia de redirecionamento (HTTP + JS), igual um navegador de verdade.
    // Resolver via axios antes quebra o fingerprint que o redirecionador da
    // Shopee (AppsFlyer/OneLink) espera e derruba a página em /verify/traffic/error.
    await page.goto(originalUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('h1, [class*="price"]', { timeout: 8000 }).catch(() => {});
    console.log(`[SCRAPER:Shopee] URL final após redirecionamentos: ${page.url()}`);

    const data = await page.evaluate(() => {
      // Seletores específicos da página de produto da Shopee
      const titleEl = document.querySelector('h1.vR6K3w');
      const currentPriceEl = document.querySelector('.jRlVo0 .IZPeQz, .IZPeQz');
      const originalPriceEl = document.querySelector('.jRlVo0 .ZA5sW5, .ZA5sW5');
      const discountEl = document.querySelector('.jRlVo0 .vms4_3, .vms4_3');

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
        titleText: titleEl ? titleEl.innerText.trim() : null,
        currentPriceText: currentPriceEl ? currentPriceEl.innerText.trim() : null,
        originalPriceText: originalPriceEl ? originalPriceEl.innerText.trim() : null,
        discountText: discountEl ? discountEl.innerText.trim() : null,
        strikedText: strikedEl ? strikedEl.innerText : null,
        firstPriceText: priceMatches[0] || null,
        discountPercent: discountMatch ? parseInt(discountMatch[1], 10) : null,
        blocked,
      };
    });

    result.title = data.blocked ? null : (data.titleText || data.h1Title || data.ogTitle || null);
    result.imageUrl = !data.blocked ? (data.ogImage || null) : null;
    result.currentPrice = data.blocked ? null : (parseShopeePriceText(data.currentPriceText) || parseShopeePriceText(data.firstPriceText));
    result.originalPrice = data.blocked ? null : (parseShopeePriceText(data.originalPriceText) || parseShopeePriceText(data.strikedText));

    const discountMatch = (data.discountText || '').match(/(\d{1,3})/);
    result.discountPercent = (discountMatch ? parseInt(discountMatch[1], 10) : null)
      || data.discountPercent
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

async function scrapeShopeeProduct(originalUrl, attempts = 3) {
  console.log(`[SCRAPER:Shopee] URL original: ${originalUrl}`);

  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await scrapeShopeeProductOnce(originalUrl);
    if (last.scraped) return last;
    console.warn(`[SCRAPER:Shopee] Tentativa ${i}/${attempts} sem sucesso.`);
    if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
  }
  return last;
}

// ── Amazon ───────────────────────────────────────────────────────────────────
// Amazon bloqueia requisições HTTP simples com uma página de validação
// (opfcaptcha), por isso também usamos o navegador headless compartilhado.

function parseAmazonPriceText(text) {
  if (!text) return null;
  const match = text.match(/([\d.,]+)/);
  return match ? parsePrice(match[1]) : null;
}

async function scrapeAmazonProductOnce(originalUrl) {
  const result = {
    title: null, currentPrice: null, originalPrice: null,
    discountPercent: null, imageUrl: null, features: [],
    url: originalUrl, scraped: false,
  };

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': HEADERS['Accept-Language'] });
    await page.setViewport({ width: 1280, height: 900 });

    // Navega direto no link original (funciona também para encurtadores como
    // amzn.to) — deixa o Chrome seguir toda a cadeia de redirecionamento.
    await page.goto(originalUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#productTitle, .apex-pricetopay-value', { timeout: 8000 }).catch(() => {});
    console.log(`[SCRAPER:Amazon] URL final após redirecionamentos: ${page.url()}`);

    const data = await page.evaluate(() => {
      // Título
      const titleEl = document.querySelector('#productTitle');

      // Preço atual — bloco "priceToPay" (whole + fraction)
      const priceToPayEl = document.querySelector('.priceToPay, .apex-pricetopay-value');
      const wholeEl = priceToPayEl?.querySelector('.a-price-whole');
      const fractionEl = priceToPayEl?.querySelector('.a-price-fraction');

      // Desconto — "apex-savings-percentage" (ex.: -61%)
      const discountEl = document.querySelector('.apex-savings-percentage, .savingsPercentage');

      // Preço original/riscado — tentativa via seletores comuns de "preço de lista"
      // (exclui o bloco de preço por unidade, ex.: "R$ X / l", que também usa a classe a-text-price)
      const basisEl = document.querySelector(
        '.basisPrice .a-offscreen, span[data-a-strike="true"] .a-offscreen, .a-text-price:not(.apex-priceperunit-value):not([class*="priceperunit"]) .a-offscreen'
      );

      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || null;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content || null;
      const landingImg = document.querySelector('#landingImage');

      const bodyText = document.body.innerText || '';
      const blocked = /digite os caracteres|enter the characters|continuar comprando|automated access/i.test(bodyText) && !titleEl;

      const features = Array.from(document.querySelectorAll('#feature-bullets li span.a-list-item'))
        .map((el) => el.innerText.trim())
        .filter(Boolean)
        .slice(0, 8);

      return {
        titleText: titleEl ? titleEl.innerText.trim() : null,
        ogTitle,
        ogImage,
        wholeText: wholeEl ? wholeEl.innerText.trim() : null,
        fractionText: fractionEl ? fractionEl.innerText.trim() : null,
        discountText: discountEl ? discountEl.innerText.trim() : null,
        basisText: basisEl ? basisEl.innerText.trim() : null,
        imageUrl: landingImg?.getAttribute('data-old-hires') || landingImg?.getAttribute('src') || null,
        features,
        blocked,
      };
    });

    result.title = data.blocked ? null : (data.titleText || data.ogTitle || null);
    result.imageUrl = !data.blocked ? (data.imageUrl || data.ogImage || null) : null;
    result.features = data.blocked ? [] : data.features;

    if (!data.blocked) {
      const whole = (data.wholeText || '').replace(/[^\d]/g, '');
      const fraction = (data.fractionText || '').replace(/[^\d]/g, '');
      result.currentPrice = whole ? parseFloat(`${whole}.${fraction || '00'}`) : null;

      const discountMatch = (data.discountText || '').match(/(\d{1,3})/);
      result.discountPercent = discountMatch ? parseInt(discountMatch[1], 10) : null;

      result.originalPrice = parseAmazonPriceText(data.basisText);
      if (!result.originalPrice && result.currentPrice && result.discountPercent) {
        result.originalPrice = Math.round((result.currentPrice / (1 - result.discountPercent / 100)) * 100) / 100;
      }
    }

    result.scraped = !data.blocked && !!(result.title || result.currentPrice || result.imageUrl);
    if (data.blocked) console.warn('[SCRAPER:Amazon] Página de verificação/bloqueio detectada.');

    console.log(`[SCRAPER:Amazon] Título: "${result.title}" | Preço: ${result.currentPrice} | Imagem: ${result.imageUrl ? 'sim' : 'não'}`);
  } catch (err) {
    console.warn('[SCRAPER:Amazon] Falha ao extrair dados automaticamente:', err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return result;
}

async function scrapeAmazonProduct(originalUrl, attempts = 3) {
  console.log(`[SCRAPER:Amazon] URL original: ${originalUrl}`);

  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await scrapeAmazonProductOnce(originalUrl);
    if (last.scraped) return last;
    console.warn(`[SCRAPER:Amazon] Tentativa ${i}/${attempts} sem sucesso.`);
    if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
  }
  return last;
}

async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': HEADERS['User-Agent'] },
  });
  return Buffer.from(res.data);
}

module.exports = { scrapeProduct, scrapeShopeeProduct, scrapeAmazonProduct, downloadImage };
