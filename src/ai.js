const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

async function generateSalesMessage(product, coupon = null) {
  const { title, currentPrice, originalPrice, discountPercent, features, url } = product;

  const priceInfo = currentPrice
    ? `Por: R$ ${currentPrice.toFixed(2)}${originalPrice ? `\nDe: R$ ${originalPrice.toFixed(2)}` : ''}${discountPercent ? `\nDesconto: ${discountPercent}% OFF` : ''}`
    : '';

  const featuresText = features?.length
    ? `\nCaracterísticas:\n${features.map((f) => `- ${f}`).join('\n')}`
    : '';

  const prompt = `Você é especialista em marketing de afiliados brasileiro. Crie uma mensagem de oferta impactante para grupo de WhatsApp.

Produto: ${title || 'Produto Mercado Livre'}
${priceInfo}${featuresText}
Link: ${url}

Regras OBRIGATÓRIAS:
- Responda APENAS com a mensagem final, sem título, sem cabeçalho, sem "Mensagem de Oferta", sem traços (---), sem dicas, sem comentários extras
- Máximo 5 linhas
- Use emojis estrategicamente (não exagere)
- SEMPRE inclua o preço na mensagem no formato: *Por: R$ XX,XX* (com asteriscos para negrito)
- Se tiver preço "De:", use o formato ~R$ XX,XX~ logo antes do preço final para mostrar riscado
- Termine com CTA urgente + link (use o link exatamente como fornecido, sem alterar)
- Português brasileiro informal
- NÃO adicione nada após o link`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const message = response.content[0].text.trim();
  return coupon ? `${message}\n\nCUPOM: ${coupon}` : message;
}

module.exports = { generateSalesMessage };
