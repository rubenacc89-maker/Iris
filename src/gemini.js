const { searchWeb } = require('./search')

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
  // Fast path: mensajes sociales o muy cortos nunca necesitan visión
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

async function askGemini(message, screenshotBase64, memory, recentHistory, vectorContext = null, wikiContext = null, liveContext = null, userName = null, activeGame = null) {
  if (!EDGE_KEY) return { text: 'Error: no hay configuración de Supabase en .env', vision: false }

  const memoryContext = buildMemoryContext(memory)
  // game = solo el proceso detectado corriendo ahora. Si no hay juego activo, null.
  // La memoria histórica queda como contexto de notas, no determina el juego activo.
  const game = activeGame || null

  // Skip web search en visión (Gemini ya ve la pantalla) o mensajes cortos/sociales
  let searchContext = ''
  const shouldSearch = !screenshotBase64 && message.length > 20 && !SOCIAL_RE.test(message.trim())
  if (shouldSearch) {
    try {
      const query = game ? `${game} ${message} patch build guia` : `${message} videojuego guia`
      const results = await searchWeb(query, game)
      if (results && results.length > 60 && results !== 'Sin resultados.' && !results.startsWith('Error')) {
        searchContext = `\n\n[Información web actualizada]:\n${results}`
      }
    } catch (_) {}
  }

  const systemPrompt = buildSystemPrompt(game, memoryContext, vectorContext, wikiContext, userName)
  const userText = message + (liveContext ? `\n\n${liveContext}` : '') + searchContext

  // Visión con Gemini — inyecta historial reciente en el systemPrompt para mantener contexto
  if (screenshotBase64) {
    let visionSystemPrompt = systemPrompt
    if (recentHistory && recentHistory.length > 0) {
      const historyText = recentHistory.slice(-5).map(e =>
        `[user]: ${e.question}\n[iris]: ${e.answer}`
      ).join('\n\n')
      visionSystemPrompt += `\n\n[Conversación reciente — usar como contexto para entender referencias]:\n${historyText}`
    }
    try {
      const data = await edgeFetch({ type: 'vision', systemPrompt: visionSystemPrompt, userText, screenshotBase64 })
      return { text: data.text, vision: true }
    } catch (err) {
      console.log('[IRIS] Error Gemini via proxy:', err.message || String(err))
      return { text: 'No pude analizar la pantalla en este momento. Intentá sin visión.', vision: false }
    }
  }

  // Texto con Groq — historial completo como array de mensajes
  const messages = [{ role: 'system', content: systemPrompt }]
  if (recentHistory && recentHistory.length > 0) {
    for (const entry of recentHistory.slice(-10)) {
      messages.push({ role: 'user', content: entry.question })
      messages.push({ role: 'assistant', content: entry.answer })
    }
  }
  messages.push({ role: 'user', content: userText })

  // Modo libre: sin juego activo, sin wiki, sin vector → temperatura alta para respuesta más libre
  const temperature = (!activeGame && !wikiContext && !vectorContext) ? 0.7 : 0.45

  try {
    const data = await edgeFetch({
      type: 'grounded-chat',
      systemPrompt,
      userText,
      chatHistory: (recentHistory || []).map(e => ({ question: e.question, answer: e.answer })),
      messages,        // Groq fallback dentro del Edge Function si Gemini falla
      max_tokens: 500,
      temperature,
    })
    return { text: data.text, vision: false }
  } catch (err) {
    const msg = err.message || String(err)
    console.log('[IRIS] Error Groq via proxy:', msg)
    if (msg.includes('429') || msg.includes('ocupados')) {
      return { text: 'Iris está muy ocupada ahora mismo, esperá unos segundos e intentá de nuevo.', vision: false }
    }
    return { text: 'No se pudo conectar con Iris en este momento. Verificá tu conexión a internet.', vision: false }
  }
}

function buildSystemPrompt(game, memoryContext, vectorContext, wikiContext = null, userName = null) {
  const nombre = userName ? userName.split(' ')[0] : null
  return `${game ? `JUEGO DETECTADO EN SEGUNDO PLANO: ${game}\n- Si el usuario menciona explícitamente otro juego en su mensaje, respondé sobre ese juego. Ignorá el juego detectado.\n- Solo asumí que la pregunta es sobre ${game} si el usuario no especifica ningún juego.\n\n` : ''}${nombre ? `USUARIO: ${nombre}. Cuando uses un nombre al final de una respuesta o saludo, usá "${nombre}", NUNCA "Iris".\n\n` : ''}Sos Iris, copiloto táctico de gaming. Respondés rápido, preciso y con tono de compañero de equipo. Sin rodeos, sin formalidades.

REGLAS DE RESPUESTA:
- Social/confirmación ("ok", "dale", "gracias", "chao", "joya", "np"): respuesta corta y natural, máximo 1 oración. NUNCA repitas el consejo anterior.
- Pregunta táctica o conversacional: respondé directo al grano. Bullets y **negritas** solo en análisis complejos. Máximo 6 bullets, siempre terminá la respuesta completa. Para preguntas conversacionales podés extenderte hasta 4-5 oraciones si el tema lo requiere.
- JAMÁS: "Basándome en...", "Según la evidencia...", "Análisis:", "Conclusión:", "En primer lugar..."
- JAMÁS menciones "la captura", "la imagen", "el screenshot" — simplemente sabés lo que pasa.
- Si no sabés algo con certeza sobre el juego activo: "no lo tengo claro" y seguís.
- Si el usuario nombra un juego en su mensaje: respondé sobre ese juego sin pedir aclaración. Usá tu conocimiento y búsqueda web.
- Si ves una pantalla en visión y no reconocés el juego: ahí sí preguntá directamente.

CONOCIMIENTO E ITEMS:
- Para items del juego activo: usá los nombres exactos. NUNCA inventes stats numéricos, porcentajes ni efectos de habilidades específicos que no puedas verificar.
- Si el item o tema no está en el [Wiki Iris]: respondé con tu conocimiento general sin inventar datos concretos. No digas "no tengo datos".
- Para preguntas casuales, de la vida real o humor: respondé con naturalidad, sin forzar conexión con videojuegos.
- NUNCA traduzcas nombres de items sin estar seguro del nombre correcto en el idioma del juego.

LO QUE PODÉS VER:
- Personaje, armadura, posición en el mapa, inventario, ítems equipados, misiones activas, paneles abiertos.
- Si algo no está claro: "no lo veo bien".

DIAGNÓSTICO IRIS:
- Atajo de voz no funciona en juego competitivo → anti-cheat bloquea la tecla → usar Mouse4/Mouse5 desde ⚙ Config.
- Overlay no se ve → juego debe estar en modo Sin bordes (Windowed Borderless), no pantalla completa exclusiva.
${memoryContext}${vectorContext ? `\n\n[Recuerdo de sesión anterior — solo aplicar si es sobre ${game || 'este juego'}]:\n${vectorContext}` : ''}${wikiContext ? `\n\n[Wiki Iris — info verificada sobre ${game}]:\n## ${wikiContext.title}\n${wikiContext.content}` : ''}`
}

function buildMemoryContext(memory) {
  if (!memory || Object.keys(memory).length === 0) return ''

  const games = Object.entries(memory)
    .filter(([n]) => n && n.toLowerCase() !== 'null' && n.toLowerCase() !== 'unknown')
    .sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0))
  if (!games.length) return ''

  const [currentGame, data] = games[0]
  const lines = [`\n[Memoria de ${currentGame} — solo aplicar a preguntas sobre ${currentGame}]:`]

  if (data.notes?.length) {
    data.notes.slice(-5).forEach(n => lines.push(`- ${n}`))
  } else {
    lines.push('(sin notas guardadas aún)')
  }

  return lines.join('\n')
}

module.exports = { askGemini, detectarNecesidadVisual }
