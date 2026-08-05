const MARKET_API  = 'https://www.albion-online-data.com/api/v2/stats/prices'
const CITIES      = 'Caerleon,Bridgewatch,Fort%20Sterling,Lymhurst,Martlock,Thetford'

const CACHE_MS = 5 * 60 * 1000  // 5 minutos — precios no cambian tan rápido
const _cache = {}

// Mapeo de términos en español → item IDs de la API
const ITEM_MAP = {
  // Pieles / Cuero
  'piel t4': 'T4_HIDE', 'pieles t4': 'T4_HIDE',
  'piel t5': 'T5_HIDE', 'pieles t5': 'T5_HIDE',
  'piel t6': 'T6_HIDE', 'pieles t6': 'T6_HIDE',
  'piel t7': 'T7_HIDE', 'pieles t7': 'T7_HIDE',
  'piel t8': 'T8_HIDE', 'pieles t8': 'T8_HIDE',
  'cuero t4': 'T4_LEATHER', 'cuero t5': 'T5_LEATHER',
  'cuero t6': 'T6_LEATHER', 'cuero t7': 'T7_LEATHER',
  // Madera
  'madera t4': 'T4_WOOD', 'madera t5': 'T5_WOOD',
  'madera t6': 'T6_WOOD', 'madera t7': 'T7_WOOD',
  'tablón t4': 'T4_PLANKS', 'tablón t5': 'T5_PLANKS',
  // Mineral / Metal
  'mineral t4': 'T4_ORE', 'mineral t5': 'T5_ORE',
  'mineral t6': 'T6_ORE', 'mineral t7': 'T7_ORE',
  'metal t4': 'T4_METALBAR', 'metal t5': 'T5_METALBAR',
  // Piedra
  'piedra t4': 'T4_ROCK', 'piedra t5': 'T5_ROCK',
  'roca t4': 'T4_ROCK', 'roca t5': 'T5_ROCK',
  'bloque t4': 'T4_STONEBLOCK', 'bloque t5': 'T5_STONEBLOCK',
  // Fibra
  'fibra t4': 'T4_FIBER', 'fibra t5': 'T5_FIBER',
  'fibra t6': 'T6_FIBER', 'fibra t7': 'T7_FIBER',
  'tela t4': 'T4_CLOTH', 'tela t5': 'T5_CLOTH',
}

// Items más consultados para snapshot rápido
const POPULAR_ITEMS = [
  'T4_HIDE','T5_HIDE','T6_HIDE',
  'T4_LEATHER','T5_LEATHER','T6_LEATHER',
  'T4_WOOD','T5_WOOD','T6_WOOD',
  'T4_ORE','T5_ORE','T6_ORE',
  'T4_FIBER','T5_FIBER','T6_FIBER',
  'T4_ROCK','T5_ROCK','T6_ROCK',
]

async function fetchPrices(itemIds) {
  const key = itemIds.join(',')
  const cached = _cache[key]
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data

  try {
    const url = `${MARKET_API}/${key}?locations=${CITIES}&qualities=1`
    const res  = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    _cache[key] = { data, at: Date.now() }
    return data
  } catch {
    return null
  }
}

function formatPrices(data, itemIds) {
  if (!data?.length) return null

  const lines = []
  for (const id of itemIds) {
    const rows = data.filter(r => r.item_id === id && r.sell_price_min > 0)
    if (!rows.length) continue

    const best = rows.reduce((a, b) => a.sell_price_min < b.sell_price_min ? a : b)
    const label = id.replace(/_/g, ' ').toLowerCase()
    lines.push(`• ${label}: ${best.sell_price_min.toLocaleString()} plata (más barato en ${best.city})`)
  }
  return lines.length ? lines.join('\n') : null
}

// Detecta si la pregunta es sobre precios de mercado
function isPriceQuestion(text) {
  return /precio|vale|cuesta|cu[aá]nto|mercado|vender|comprar|plata|silver|market|pagan|cobran|cuestan|dan por/i.test(text)
}

// Extrae qué item está preguntando
function extractItemIds(text) {
  const lower = text.toLowerCase()

  // Buscar match exacto en el mapa
  for (const [term, id] of Object.entries(ITEM_MAP)) {
    if (lower.includes(term)) return [id]
  }

  // Detectar tier genérico + tipo de recurso
  const tierMatch = lower.match(/t(\d)/i)
  const tier = tierMatch ? tierMatch[1] : null

  const isHide   = /piel|piles|pieles|hide|cuero|leather/.test(lower)
  const isWood   = /madera|wood|tabl[oó]n|plank/.test(lower)
  const isOre    = /mineral|ore|metal/.test(lower)
  const isFiber  = /fibra|fiber|tela|cloth/.test(lower)
  const isStone  = /piedra|rock|bloque|stone/.test(lower)

  if (tier) {
    if (isHide)  return [`T${tier}_HIDE`, `T${tier}_LEATHER`]
    if (isWood)  return [`T${tier}_WOOD`, `T${tier}_PLANKS`]
    if (isOre)   return [`T${tier}_ORE`, `T${tier}_METALBAR`]
    if (isFiber) return [`T${tier}_FIBER`, `T${tier}_CLOTH`]
    if (isStone) return [`T${tier}_ROCK`, `T${tier}_STONEBLOCK`]
  }

  // Recurso detectado sin tier → mostrar todos los tiers disponibles
  if (isHide)  return ['T4_HIDE','T5_HIDE','T6_HIDE','T7_HIDE','T8_HIDE']
  if (isWood)  return ['T4_WOOD','T5_WOOD','T6_WOOD','T7_WOOD','T8_WOOD']
  if (isOre)   return ['T4_ORE','T5_ORE','T6_ORE','T7_ORE','T8_ORE']
  if (isFiber) return ['T4_FIBER','T5_FIBER','T6_FIBER','T7_FIBER','T8_FIBER']
  if (isStone) return ['T4_ROCK','T5_ROCK','T6_ROCK','T7_ROCK','T8_ROCK']

  // Sin item específico → snapshot general de los más populares
  if (/mercado|hoy|precio|recursos|cuanto/.test(lower)) return POPULAR_ITEMS.slice(0, 6)

  return null
}

async function fetchContext(question) {
  if (!isPriceQuestion(question)) return null

  const itemIds = extractItemIds(question)
  if (!itemIds) {
    return `[Precios Albion Online — cobertura limitada]
Solo tengo precios en tiempo real de recursos: pieles, cuero, madera, tablones, mineral, metal, fibra, tela, piedra y bloques (T4 a T8).
No tengo precios de armas, armaduras ni otros items. Para esos, el jugador debe consultar el mercado en el juego.`
  }

  const data = await fetchPrices(itemIds)
  const formatted = formatPrices(data, itemIds)
  if (!formatted) return null

  return `[Precios Albion Online — datos en tiempo real]\n${formatted}\n(Actualizado hace menos de 5 min)`
}

module.exports = { fetchContext }
