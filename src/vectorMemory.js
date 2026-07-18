const Store = require('electron-store')
const { GoogleGenAI } = require('@google/genai')

const store    = new Store()
const MAX_VEC  = 200
const GEM_KEY  = process.env.GEMINI_API_KEY || ''

let genai = null
function getGenAI() {
  if (!genai) genai = new GoogleGenAI({ apiKey: GEM_KEY })
  return genai
}

async function generarVector(texto, taskType = 'RETRIEVAL_DOCUMENT') {
  const res = await getGenAI().models.embedContent({
    model: 'text-embedding-004',
    content: texto,
    taskType
  })
  return res.embedding.values
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Guarda un recuerdo vectorial para un juego/userId.
// Retorna { ok: true } | { ok: false, full: true, juego } | { ok: false, error }
async function guardarRecuerdoVectorial(userId, juegoActivo, texto) {
  if (!GEM_KEY) return { ok: false, error: 'Sin API key de Gemini' }

  const key   = `vector_memory_${userId}`
  const mem   = store.get(key, {})
  const juego = (juegoActivo || 'general').toLowerCase()

  if (!mem[juego]) mem[juego] = []

  if (mem[juego].length >= MAX_VEC) {
    console.log(`[VECTOR] Memoria llena para "${juego}" (${MAX_VEC}/${MAX_VEC})`)
    return { ok: false, full: true, juego }
  }

  try {
    const vector = await generarVector(texto, 'RETRIEVAL_DOCUMENT')
    mem[juego].push({ texto, vector, timestamp: Date.now() })
    store.set(key, mem)
    console.log(`[VECTOR] Recuerdo guardado en "${juego}" (${mem[juego].length}/${MAX_VEC})`)
    return { ok: true }
  } catch (e) {
    console.log('[VECTOR] Error guardando recuerdo:', e.message)
    return { ok: false, error: e.message }
  }
}

// Busca el recuerdo más relevante para la pregunta del usuario.
// Retorna el texto del recuerdo más similar, o null si no hay nada útil.
async function buscarRecuerdoVectorial(userId, juegoActivo, pregunta) {
  if (!GEM_KEY) return null

  const key      = `vector_memory_${userId}`
  const mem      = store.get(key, {})
  const juego    = (juegoActivo || 'general').toLowerCase()
  const recuerdos = mem[juego] || []

  if (recuerdos.length === 0) return null

  try {
    const queryVec = await generarVector(pregunta, 'RETRIEVAL_QUERY')

    let mejorSim   = -1
    let mejorTexto = null

    for (const r of recuerdos) {
      if (!r.vector?.length) continue
      const sim = cosineSim(queryVec, r.vector)
      if (sim > mejorSim) { mejorSim = sim; mejorTexto = r.texto }
    }

    const UMBRAL = 0.65
    if (mejorSim < UMBRAL) {
      console.log(`[VECTOR] Mejor similitud ${mejorSim.toFixed(3)} < umbral ${UMBRAL} → sin contexto vectorial`)
      return null
    }

    console.log(`[VECTOR] Recuerdo encontrado (similitud ${mejorSim.toFixed(3)}): "${mejorTexto.slice(0, 60)}..."`)
    return mejorTexto
  } catch (e) {
    console.log('[VECTOR] Error buscando recuerdo:', e.message)
    return null
  }
}

// Devuelve cuántos recuerdos tiene un juego y el límite.
function contarRecuerdos(userId, juegoActivo) {
  const key   = `vector_memory_${userId}`
  const mem   = store.get(key, {})
  const juego = (juegoActivo || 'general').toLowerCase()
  return { count: (mem[juego] || []).length, max: MAX_VEC }
}

module.exports = { guardarRecuerdoVectorial, buscarRecuerdoVectorial, contarRecuerdos }
