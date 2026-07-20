const Groq = require('groq-sdk')
const { GoogleGenAI } = require('@google/genai')
const { searchWeb } = require('./search')

const GROQ_KEY   = process.env.GROQ_API_KEY || ''
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''

let groq   = null
let gemini = null

function getGroq() {
  if (!groq) groq = new Groq({ apiKey: GROQ_KEY })
  return groq
}

function getGemini() {
  if (!gemini) gemini = new GoogleGenAI({ apiKey: GEMINI_KEY })
  return gemini
}

async function detectarNecesidadVisual(pregunta) {
  try {
    const completion = await getGroq().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: "Eres el módulo de decisión visual de un asistente virtual integrado en el sistema del usuario. Tu única tarea es decidir si el usuario te está pidiendo analizar lo que hay actualmente en su pantalla o no.\nResponde estrictamente con la palabra 'SI' (en mayúsculas) si la pregunta del usuario requiere obligatoriamente ver la pantalla actual para ser respondida (ej: '¿qué es esto?', 'mira mi inventario', 'evalúa mi build', '¿qué dice este error?', '¿cómo voy?', o cualquier referencia al juego/programa que esté abierto en primer plano).\nResponde 'NO' si es una pregunta teórica, de conocimiento general, programación, charla casual o consultas que se resuelven solo con texto (ej: 'tengo hambre', '¿cómo se craftea X?', 'escribe un código', 'cuéntame un chiste').\nNo agregues puntuación, ni explicaciones, ni más palabras. Solo 'SI' o 'NO'."
        },
        { role: 'user', content: pregunta }
      ],
      max_tokens: 5,
      temperature: 0
    })
    const resultado = completion.choices[0].message.content.trim().toUpperCase()
    console.log(`[CLASIFICADOR] "${pregunta.slice(0, 60)}" → ${resultado}`)
    return resultado.includes('SI')
  } catch (err) {
    console.log('[CLASIFICADOR] Error en clasificador, asumiendo NO visión:', err.message)
    return false
  }
}

async function askGemini(message, screenshotBase64, memory, recentHistory, vectorContext = null) {
  if (!GROQ_KEY && !GEMINI_KEY) return { text: 'Error: no hay API keys configuradas en .env', vision: false }

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

  const systemPrompt = `${game ? `JUEGO ACTIVO: ${game}\nRespondé SIEMPRE sobre ${game}. No uses información ni ítems de otros juegos aunque los tengas en memoria.\n\n` : ''}Sos un amigo gamer que sabe mucho de videojuegos. Hablás de forma natural y directa, como en una conversación entre amigos jugando.

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

  // Build conversation messages with history for context
  const messages = [{ role: 'system', content: systemPrompt }]

  if (recentHistory && recentHistory.length > 0) {
    for (const entry of recentHistory.slice(-6)) {
      messages.push({ role: 'user', content: entry.question })
      messages.push({ role: 'assistant', content: entry.answer })
    }
  }

  const userText = message + searchContext

  if (screenshotBase64 && GEMINI_KEY) {
    try {
      const contents = [
        { inlineData: { data: screenshotBase64, mimeType: 'image/jpeg' } },
        systemPrompt + '\n\n' + userText
      ]
      const r = await getGemini().models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents,
        config: { temperature: 0.5 }
      })
      return { text: r.text.trim(), vision: true }
    } catch (err) {
      const msg = err.message || String(err)
      return { text: 'Error Gemini: ' + msg.substring(0, 200), vision: false }
    }
  }

  messages.push({ role: 'user', content: userText })

  const GROQ_MODELS = [
    'llama-3.1-8b-instant',
    'llama-3.2-1b-preview',
    'gemma2-9b-it',
  ]

  for (const model of GROQ_MODELS) {
    try {
      const completion = await getGroq().chat.completions.create({ model, messages, max_tokens: 500 })
      if (model !== GROQ_MODELS[0]) console.log(`[IRIS] Usando modelo fallback: ${model}`)
      return { text: completion.choices[0].message.content.trim(), vision: false }
    } catch (err) {
      const msg = err.message || String(err)
      if (msg.includes('401')) return { text: 'Error: API Key de Groq inválida.', vision: false }
      if (msg.includes('429')) { console.log(`[IRIS] 429 en ${model}, probando siguiente...`); continue }
      return { text: 'Error: ' + msg.substring(0, 120), vision: false }
    }
  }

  return { text: 'Todos los modelos están ocupados en este momento, intentá en unos segundos.', vision: false }
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
