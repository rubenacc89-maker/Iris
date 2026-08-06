const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-chat'
const EDGE_KEY = process.env.SUPABASE_ANON_KEY || ''

async function edgeFetch(body) {
  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${EDGE_KEY}`,
      'apikey': EDGE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

const SOCIAL_RE = /^(ok|dale|gracias|chao|bueno|entendido|joya|re|np|genial|listo|sí|si|no|bien|mal|hola|hey|perfecto|claro|obvio|ya|nop|nope|gg|wp|xd|ajá|aja|mhm|uh|ah|oh|wow|nice|cool|okok|mm|hmm|oki|okie)\.?[!?]?$/i

async function detectarNecesidadVisual(pregunta) {
  if (pregunta.trim().length < 4 || SOCIAL_RE.test(pregunta.trim())) {
    console.log(`[CLASIFICADOR] Fast-path NO visión: "${pregunta.slice(0, 40)}"`)
    return false
  }
  try {
    const data = await edgeFetch({
      type: 'classify',
      messages: [
        {
          role: 'system',
          content: "Eres el módulo de decisión visual de un asistente virtual integrado en el sistema del usuario. Tu única tarea es decidir si el usuario te está pidiendo analizar lo que hay actualmente en su pantalla o no.\nResponde estrictamente con la palabra 'SI' (en mayúsculas) si la pregunta del usuario requiere obligatoriamente ver la pantalla actual para ser respondida (ej: '¿qué es esto?', 'mira mi inventario', 'evalúa mi build', '¿qué dice este error?', '¿cómo voy?', o cualquier referencia al juego/programa que esté abierto en primer plano).\nResponde 'NO' si es una pregunta teórica, de conocimiento general, programación, charla casual o consultas que se resuelven solo con texto (ej: 'tengo hambre', '¿cómo se craftea X?', 'escribe un código', 'cuéntame un chiste').\nNo agregues puntuación, ni explicaciones, ni más palabras. Solo 'SI' o 'NO'."
        },
        { role: 'user', content: pregunta }
      ],
    })
    const resultado = (data.result || '').trim().toUpperCase()
    console.log(`[CLASIFICADOR] "${pregunta.slice(0, 60)}" → ${resultado}`)
    return resultado.includes('SI')
  } catch (err) {
    console.log('[CLASIFICADOR] Error, asumiendo NO visión:', err.message)
    return false
  }
}

// Flujo simplificado: prompt → Gemini (con Google Search). Sin capas intermedias.
// wikiContext = validador/dato verificado (opcional, cuando hay juego detectado)
// liveContext = datos en tiempo real de APIs del juego (precios Albion, etc.)
async function askGemini(message, screenshotBase64, recentHistory, wikiContext = null, liveContext = null, userName = null) {
  if (!EDGE_KEY) return { text: 'Error: no hay configuración de Supabase en .env', vision: false }

  const systemPrompt = buildSystemPrompt(wikiContext, userName)
  const userText = message + (liveContext ? `\n\n[Datos en tiempo real del juego]:\n${liveContext}` : '')

  console.log(`[IRIS:CTX] wiki=${wikiContext ? `"${wikiContext.title}"` : 'null'} | live=${liveContext ? 'sí' : 'null'} | vision=${!!screenshotBase64}`)
  console.log(`[IRIS:CTX] systemPrompt (${systemPrompt.length} chars):\n${systemPrompt.slice(0, 200)}…`)

  if (screenshotBase64) {
    let visionSystemPrompt = systemPrompt
    if (recentHistory && recentHistory.length > 0) {
      const historyText = recentHistory.slice(-5).map(e =>
        `[user]: ${e.question}\n[iris]: ${e.answer}`
      ).join('\n\n')
      visionSystemPrompt += `\n\n[Conversación reciente]:\n${historyText}`
    }
    try {
      const data = await edgeFetch({ type: 'vision', systemPrompt: visionSystemPrompt, userText, screenshotBase64 })
      return { text: data.text, vision: true }
    } catch (err) {
      console.log('[IRIS] Error Gemini vision via proxy:', err.message || String(err))
      return { text: 'No pude analizar la pantalla en este momento. Intentá sin visión.', vision: false }
    }
  }

  const chatHistory = (recentHistory || []).map(e => ({ question: e.question, answer: e.answer }))

  try {
    const data = await edgeFetch({
      type: 'grounded-chat',
      systemPrompt,
      userText,
      chatHistory,
      max_tokens: 500,
      temperature: 0.7,
    })
    return { text: data.text, vision: false }
  } catch (err) {
    const msg = err.message || String(err)
    console.log('[IRIS] Error Gemini via proxy:', msg)
    if (msg.includes('429') || msg.includes('ocupados')) {
      return { text: 'Iris está muy ocupada ahora mismo, esperá unos segundos e intentá de nuevo.', vision: false }
    }
    return { text: 'No se pudo conectar con Iris en este momento. Verificá tu conexión a internet.', vision: false }
  }
}

function buildSystemPrompt(wikiContext = null, userName = null) {
  const nombre = userName ? userName.split(' ')[0] : null
  let prompt = `${nombre ? `USUARIO: ${nombre}. Al usar nombre, usá "${nombre}", nunca "Iris".\n\n` : ''}Sos Iris, copiloto de gaming integrado en el escritorio. Tono de compañero de equipo: directo, sin rodeos.

NUNCA uses: "Basándome en...", "Según la evidencia...", "Análisis:", "Conclusión:".
NUNCA menciones "la captura", "la imagen" o "el screenshot" — describís lo que ves directamente.`

  if (wikiContext) {
    prompt += `\n\n[Wiki Iris — dato verificado, priorizá si es relevante]:\n## ${wikiContext.title}\n${wikiContext.content}`
  }

  return prompt
}

module.exports = { askGemini, detectarNecesidadVisual }
