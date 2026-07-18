const Store = require('electron-store')
const Groq = require('groq-sdk')

const store = new Store()

function getMemory(userId) {
  return store.get(`memory2_${userId}`, {})
}

function getRawMemory(userId) {
  return store.get(`memory2_${userId}`, {})
}

async function saveMemory(userId, question, answer, existingMemory) {
  const API_KEY = process.env.GROQ_API_KEY || ''
  if (!API_KEY) return

  try {
    const groq = new Groq({ apiKey: API_KEY })

    const prompt = `Analizá esta conversación de videojuego y extraé información útil para recordar.

Pregunta del jugador: "${question}"
Respuesta del asistente: "${answer}"

Respondé SOLO con JSON válido con esta estructura:
{
  "game": "nombre exacto del juego (null si no se menciona ni se puede inferir)",
  "note": "una sola frase corta y específica que valga la pena recordar (null si no hay nada nuevo útil)"
}

Ejemplos de notas útiles: "Misión Revuelta de Guardianes: matar 4 tipos de Keepers en zona forestal", "Usa espada + escudo T4 placa"
Ejemplos de notas inútiles: "el jugador preguntó algo", "se habló del juego", "está jugando"
Si no hay nada nuevo o concreto que recordar, note debe ser null.`

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150
    })

    const text = completion.choices[0].message.content.trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return

    const extracted = JSON.parse(jsonMatch[0])
    if (!extracted?.game) return

    const gameName = extracted.game.trim()
    if (!gameName || gameName.toLowerCase() === 'null' || gameName.toLowerCase() === 'unknown') return
    const memory = store.get(`memory2_${userId}`, {})

    if (!memory[gameName]) {
      memory[gameName] = { notes: [], lastPlayed: Date.now() }
    }

    memory[gameName].lastPlayed = Date.now()

    if (extracted.note && extracted.note.length > 5) {
      const notes = memory[gameName].notes
      // evitar duplicados similares
      const alreadyExists = notes.some(n =>
        n.toLowerCase().includes(extracted.note.toLowerCase().slice(0, 20))
      )
      if (!alreadyExists) {
        notes.push(extracted.note)
        if (notes.length > 25) notes.splice(0, notes.length - 25)
      }
    }

    store.set(`memory2_${userId}`, memory)
  } catch (e) {
    // silencioso — la memoria es opcional
  }
}

function clearMemory(userId) {
  store.delete(`memory2_${userId}`)
}

module.exports = { getMemory, getRawMemory, saveMemory, clearMemory }
