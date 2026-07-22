const Store = require('electron-store')

const store   = new Store()
const MAX_VEC = 200

const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-chat'
const EDGE_KEY = process.env.SUPABASE_ANON_KEY || ''

async function generarVector(texto, taskType = 'RETRIEVAL_DOCUMENT') {
  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${EDGE_KEY}`,
      'apikey': EDGE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'embed', text: texto, taskType }),
  })
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(`Embed HTTP ${res.status}: ${JSON.stringify(errData.error || errData)}`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.values
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

async function guardarRecuerdoVectorial(userId, juegoActivo, texto) {
  if (!EDGE_KEY) return { ok: false, error: 'Sin configuración de Supabase' }

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

async function buscarRecuerdoVectorial(userId, juegoActivo, pregunta) {
  if (!EDGE_KEY) return null

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

function contarRecuerdos(userId, juegoActivo) {
  const key   = `vector_memory_${userId}`
  const mem   = store.get(key, {})
  const juego = (juegoActivo || 'general').toLowerCase()
  return { count: (mem[juego] || []).length, max: MAX_VEC }
}

module.exports = { guardarRecuerdoVectorial, buscarRecuerdoVectorial, contarRecuerdos }
