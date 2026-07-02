const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

const MAX_HOOK_CHARS = 60;

function formatBRL(value) {
  return value.toFixed(2).replace('.', ',');
}

// Gera apenas o texto de gancho/descrição (a única parte que varia de
// produto para produto). Posicionamento, espaçamento, preço, CTA e link
// são sempre montados pelo template fixo em generateSalesMessage.
async function generateHook(product) {
  const { title, currentPrice, originalPrice, discountPercent, features } = product;

  const priceInfo = currentPrice
    ? `Por: R$ ${formatBRL(currentPrice)}${originalPrice ? `\nDe: R$ ${formatBRL(originalPrice)}` : ''}${discountPercent ? `\nDesconto: ${discountPercent}% OFF` : ''}`
    : '';

  const featuresText = features?.length
    ? `\nCaracterísticas:\n${features.map((f) => `- ${f}`).join('\n')}`
    : '';

  const prompt = `Você é especialista em marketing de afiliados brasileiro. Escreva só o texto de gancho/descrição de uma mensagem de oferta para grupo de WhatsApp (o título, o preço, o CTA e o link são adicionados depois por um template fixo — não os inclua).

Produto: ${title || 'Produto'}
${priceInfo}${featuresText}

Regras OBRIGATÓRIAS:
- Responda APENAS com o texto do gancho, tipo um slogan/chamada curta — nada de título, preço, link, CTA, aspas ou comentários extras
- Extremamente curto: no máximo ${MAX_HOOK_CHARS} caracteres, tipo 5-8 palavras. Pense em slogan de propaganda, não em frase explicativa
- Destaque só UM benefício/diferencial, sem emendar vários com "e"
- Pode usar 1 emoji no final, se combinar bem
- Português brasileiro informal
- NÃO repita o nome do produto (ele já aparece no título da mensagem)`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });

  let hook = response.content[0].text.trim().replace(/\n+/g, ' ');
  if (hook.length > MAX_HOOK_CHARS) hook = `${hook.slice(0, MAX_HOOK_CHARS - 1).trimEnd()}…`;
  return hook;
}

async function generateSalesMessage(product, coupon = null) {
  const { title, currentPrice, originalPrice, discountPercent, url } = product;

  const hook = await generateHook(product);

  const priceLine = currentPrice
    ? (originalPrice && originalPrice > currentPrice
        ? `~R$ ${formatBRL(originalPrice)}~ *R$ ${formatBRL(currentPrice)}*${discountPercent ? ` (-${discountPercent}% OFF)` : ''}`
        : `*R$ ${formatBRL(currentPrice)}*`)
    : null;

  const lines = [
    `🔥 *${title || 'Oferta imperdível'}* 🔥`,
    '',
    hook,
    '',
  ];

  if (priceLine) lines.push(priceLine, '');

  lines.push(`👉 Corre que é por tempo limitado! ${url}`);

  if (coupon) lines.push('', `CUPOM: ${coupon}`);

  return lines.join('\n');
}

module.exports = { generateSalesMessage };
