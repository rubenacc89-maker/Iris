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

async function detectarNecesidadVisual(pregunta) {
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

async function askGemini(message, screenshotBase64, memory, recentHistory, vectorContext = null) {
  if (!EDGE_KEY) return { text: 'Error: no hay configuración de Supabase en .env', vision: false }

  const memoryContext = buildMemoryContext(memory)
  const gameEntries = Object.entries(memory || {}).filter(([n]) => n && n.toLowerCase() !== 'null').sort((a, b) => (b[1].lastPlayed || 0) - (a[1].lastPlayed || 0))
  const game = gameEntries[0]?.[0] || ''

  let searchContext = ''
  try {
    const query = game ? `${game} ${message} guia` : `${message} videojuego guia`
    const results = await searchWeb(query, game)
    if (results && results.length > 60 && results !== 'Sin resultados.' && !results.startsWith('Error')) {
      searchContext = `\n\n[Información de internet]:\n${results}`
    }
  } catch (_) {}

  const systemPrompt = `${game ? `JUEGO ACTIVO: ${game}\nSi la pregunta es sobre videojuegos, respondé sobre ${game}. Si la pregunta es sobre otra cosa, ayudá igual como lo haría cualquier asistente inteligente.\n\n` : ''}Sos un asistente inteligente con personalidad de amigo gamer. Ayudás con videojuegos, pero también con cualquier otra consulta: trabajo, estudio, tecnología, lo que sea. Hablás de forma natural y directa, como en una conversación entre amigos.

TONO Y ESTILO — MUY IMPORTANTE:
- JAMÁS uses frases formales como "Basándome en...", "Según la evidencia...", "Conclusión:", "Posibles juegos:", "Análisis del juego". Eso es robótico y aburrido.
- No uses palabras como "proporcionado", "en cuestión", "asemeja", "cabe destacar". Hablá normal.
- NUNCA menciones "la captura", "la imagen", "la pantalla", "el screenshot". Simplemente sabés lo que está pasando.
- Empezá directo al punto. Sin introducciones. Sin contexto innecesario.

CUÁNDO SER CORTO vs DETALLADO:
- Mensajes sociales ("ok", "dale", "gracias", "chao", "bueno", "entendido", "joya", "re", "np", "genial"): respondé SOLO con 2-5 palabras naturales. Ejemplos: "ok" → "dale, cualquier cosa avisás", "gracias" → "de nada, suerte!", "chao" → "¡hasta la próxima!". JAMÁS repitas el consejo anterior en estos casos.
- Pregunta simple ("¿dónde estoy?", "¿qué hago?"): 1-3 oraciones, directo.
- Análisis de build/equipo: podés usar bullets y **negritas** en markdown, pero con tono de amigo, no de informe.
- Si no sabés algo con certeza, decí "no lo tengo muy claro eso" y seguís.
- Si ves un juego que no reconocés o que parece diferente al que venían jugando, preguntá directamente: "¿Qué juego es este?" o "¿Cambiaste de juego? ¿Cuál es?". No intentes adivinar ni inventar.

LO QUE SÍ PODÉS VER:
- El personaje, su armadura, su posición en el mapa
- Paneles abiertos: inventario, misiones, mapa, chat
- Ítems equipados y en el inventario
- Misiones activas con sus nombres exactos
- Si no ves algo claramente, decí "no lo veo bien" sin más explicación

CONOCIMIENTO TÉCNICO DE IRIS (para responder si el usuario pregunta):
- Si el atajo de voz no funciona en un juego competitivo: puede ser que el anti-cheat bloquee la tecla. La solución es usar los botones laterales del ratón (Mouse4/Mouse5) — se cambia desde el panel → ⚙ Config.
- Si el overlay no se ve encima del juego: el juego tiene que estar en modo Sin bordes (Windowed Borderless), no pantalla completa exclusiva.
- Si pregunta cómo configurar algo: panel de historial → ⚙ Config.
${memoryContext}${vectorContext ? `\n\n[Recuerdo de sesión anterior relevante a esta pregunta — solo usarlo si es de ${game || 'este juego'}]:\n${vectorContext}` : ''}`

  const messages = [{ role: 'system', content: systemPrompt }]

  if (recentHistory && recentHistory.length > 0) {
    for (const entry of recentHistory.slice(-6)) {
      messages.push({ role: 'user', content: entry.question })
      messages.push({ role: 'assistant', content: entry.answer })
    }
  }

  const userText = message + searchContext

  // Visión con Gemini
  if (screenshotBase64) {
    try {
      const data = await edgeFetch({ type: 'vision', systemPrompt, userText, screenshotBase64 })
      return { text: data.text, vision: true }
    } catch (err) {
      console.log('[IRIS] Error Gemini via proxy:', err.message || String(err))
      return { text: 'No pude analizar la pantalla en este momento. Intentá sin visión.', vision: false }
    }
  }

  // Texto con Groq
  messages.push({ role: 'user', content: userText })

  try {
    const data = await edgeFetch({ type: 'chat', messages, max_tokens: 500 })
    return { text: data.text, vision: false }
  } catch (err) {
    const msg = err.message || String(err)
    console.log('[IRIS] Error Groq via proxy:', msg)
    // Mensaje amigable para el usuario
    if (msg.includes('429') || msg.includes('ocupados')) {
      return { text: 'Iris está muy ocupada ahora mismo, esperá unos segundos e intentá de nuevo.', vision: false }
    }
    return { text: 'No se pudo conectar con Iris en este momento. Verificá tu conexión a internet.', vision: false }
  }
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
