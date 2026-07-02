// Integração com a Shopee Affiliate Open Platform (API oficial de afiliados).
// Documentação: https://www.affiliateshopee.com.br/documentacao
//
// Credenciais (SHOPEE_APP_ID / SHOPEE_APP_SECRET) são solicitadas em
// https://affiliate.shopee.com.br/open_api → Central de Ajuda → E-mail.
// Enquanto não configuradas, `isConfigured()` retorna false e o chamador
// deve cair no scraping via navegador headless (src/scraper.js).

const axios = require('axios');
const crypto = require('crypto');

const GRAPHQL_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
};

function isConfigured() {
  return !!(process.env.SHOPEE_APP_ID && process.env.SHOPEE_APP_SECRET);
}

// Segue apenas os redirecionamentos HTTP do link curto (sem renderizar a
// página em navegador), o que não aciona a verificação anti-bot da Shopee.
async function resolveShopeeUrl(url) {
  const res = await axios.get(url, {
    headers: HEADERS,
    maxRedirects: 10,
    timeout: 15000,
    validateStatus: (s) => s < 400,
  });
  return res.request?.res?.responseUrl || res.request?.responseURL || url;
}

function extractShopeeIds(resolvedUrl) {
  const pathMatch = resolvedUrl.match(/\/(\d{5,})\/(\d{5,})(?:[/?]|$)/);
  if (pathMatch) return { shopId: pathMatch[1], itemId: pathMatch[2] };

  const legacyMatch = resolvedUrl.match(/i\.(\d+)\.(\d+)/);
  if (legacyMatch) return { shopId: legacyMatch[1], itemId: legacyMatch[2] };

  return null;
}

function signRequest(payload) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_APP_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha256')
    .update(`${appId}${timestamp}${payload}${secret}`)
    .digest('hex');

  return {
    Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

async function fetchProductOffer(shopId, itemId) {
  const query = `{
    productOfferV2(shopId: ${shopId}, itemId: ${itemId}) {
      nodes {
        itemId
        shopId
        productName
        offerLink
        imageUrl
        priceMin
        priceMax
        priceDiscountRate
      }
    }
  }`;

  const payload = JSON.stringify({ query });
  const authHeaders = signRequest(payload);

  const res = await axios.post(GRAPHQL_ENDPOINT, payload, {
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    timeout: 15000,
  });

  if (res.data?.errors?.length) {
    throw new Error(res.data.errors.map((e) => e.message).join('; '));
  }

  const node = res.data?.data?.productOfferV2?.nodes?.[0];
  if (!node) return null;

  const currentPrice = node.priceMin != null ? parseFloat(node.priceMin) : null;
  const discountPercent = node.priceDiscountRate != null ? parseInt(node.priceDiscountRate, 10) : null;
  const originalPrice = currentPrice && discountPercent
    ? Math.round((currentPrice / (1 - discountPercent / 100)) * 100) / 100
    : null;

  return {
    title: node.productName || null,
    currentPrice,
    originalPrice,
    discountPercent: discountPercent || null,
    imageUrl: node.imageUrl || null,
  };
}

// Retorna o mesmo formato usado por scrapeShopeeProduct (src/scraper.js),
// para poder ser usado como substituto direto quando configurado.
async function getShopeeProductViaApi(originalUrl) {
  const result = {
    title: null, currentPrice: null, originalPrice: null,
    discountPercent: null, imageUrl: null, features: [],
    url: originalUrl, scraped: false,
  };

  const resolvedUrl = await resolveShopeeUrl(originalUrl);
  const ids = extractShopeeIds(resolvedUrl);
  if (!ids) {
    console.warn(`[SHOPEE-API] Não foi possível extrair shopId/itemId de: ${resolvedUrl}`);
    return result;
  }

  console.log(`[SHOPEE-API] shopId=${ids.shopId} itemId=${ids.itemId}`);
  const offer = await fetchProductOffer(ids.shopId, ids.itemId);
  if (!offer) {
    console.warn(`[SHOPEE-API] Produto não encontrado na API para shopId=${ids.shopId} itemId=${ids.itemId}`);
    return result;
  }

  Object.assign(result, offer);
  result.scraped = !!(result.title || result.currentPrice || result.imageUrl);
  return result;
}

module.exports = { isConfigured, getShopeeProductViaApi };
