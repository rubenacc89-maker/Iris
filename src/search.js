const https = require('https')

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function searchWeb(query, game) {
  const gameNorm = (game || '').toLowerCase()
  const isAlbion = gameNorm.includes('albion')

  const searches = []

  if (isAlbion) {
    // Para Albion Online: buscar en la wiki oficial + fextralife
    searches.push(searchDDG(`site:wiki.albiononline.com ${query}`))
    searches.push(searchDDG(`albion online ${query} guide wiki`))
  } else {
    searches.push(searchDDG(query))
    searches.push(searchDDG(query + ' guide wiki'))
  }

  const results = await Promise.allSettled(searches)
  const snippets = []

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      r.value.forEach(s => {
        if (!snippets.some(e => e.slice(0, 40) === s.slice(0, 40))) snippets.push(s)
      })
    }
  }

  return snippets.slice(0, 5).join('\n\n') || 'Sin resultados.'
}

async function searchDDG(query) {
  try {
    // Primero intentar la API de respuestas instantáneas
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const apiData = await fetchUrl(apiUrl)
    const json = JSON.parse(apiData)
    const snippets = []

    if (json.Answer && json.Answer.length > 20) snippets.push(json.Answer)
    if (json.AbstractText && json.AbstractText.length > 50) snippets.push(json.AbstractText)
    json.RelatedTopics?.slice(0, 3).forEach(t => {
      if (t.Text && t.Text.length > 40) snippets.push(t.Text)
    })

    if (snippets.length >= 2) return snippets

    // Fallback: scraping de DuckDuckGo Lite (más resultados)
    return await searchDDGLite(query)
  } catch (e) {
    return []
  }
}

async function searchDDGLite(query) {
  try {
    const html = await fetchUrl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`)
    const snippets = []

    // Extraer títulos de resultados
    const titleRe = /<a[^>]+class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
    // Extraer snippets
    const snippetRe = /<td class="result-snippet">([\s\S]*?)<\/td>/gi

    let m
    while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (text.length > 40) snippets.push(text)
    }

    return snippets
  } catch (e) {
    return []
  }
}

module.exports = { searchWeb }
