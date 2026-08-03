const WIKI_BASE = 'https://raw.githubusercontent.com/rubenacc89-maker/iris-gaming-wiki/main'

// Cache por juego: { [gameId]: { index, cachedAt } }
const _indexCache = {}
const CACHE_MS    = 5 * 60 * 1000  // 5 minutos

function gameToId(gameName) {
  return gameName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
}

async function fetchGameIndex(gameId) {
  const cached = _indexCache[gameId]
  if (cached && Date.now() - cached.cachedAt < CACHE_MS) return cached.index
  try {
    const res = await fetch(`${WIKI_BASE}/games/${gameId}/index.json`)
    if (!res.ok) return null
    const index = await res.json()
    _indexCache[gameId] = { index, cachedAt: Date.now() }
    return index
  } catch {
    return null
  }
}

async function searchWiki(game, question) {
  if (!game) return null
  const gameId = gameToId(game)
  const index  = await fetchGameIndex(gameId)
  if (!index?.length) return null

  const normQ = normalize(question)
  const words = normQ.split(/\s+/).filter(w => w.length >= 4)
  if (!words.length) return null

  let bestArticle = null
  let bestScore   = 0

  for (const article of index) {
    const normKeywords = article.keywords.map(normalize)
    const score = words.filter(w =>
      normKeywords.some(k => k.includes(w) || w.includes(k))
    ).length
    if (score > bestScore) { bestScore = score; bestArticle = article }
  }

  // Necesitamos al menos 2 keywords que coincidan para considerarlo relevante
  if (bestScore < 2 || !bestArticle) return null

  try {
    const res = await fetch(`${WIKI_BASE}/games/${gameId}/${bestArticle.file}`)
    if (!res.ok) return null
    const content = await res.text()
    console.log(`[WIKI] Match: "${bestArticle.title}" (score ${bestScore})`)
    return { title: bestArticle.title, content }
  } catch {
    return null
  }
}

module.exports = { searchWiki }
