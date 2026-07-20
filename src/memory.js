const Store = require('electron-store')
const Groq = require('groq-sdk')

const store = new Store()

const GAME_ALIASES = {
  'lol':               'League of Legends',
  'league':            'League of Legends',
  'league of legends': 'League of Legends',
  'valo':              'Valorant',
  'valorant':          'Valorant',
  'csgo':              'CS2',
  'cs2':               'CS2',
  'counter-strike':    'CS2',
  'fortnite':          'Fortnite',
  'apex':              'Apex Legends',
  'apex legends':      'Apex Legends',
  'ow2':               'Overwatch 2',
  'overwatch':         'Overwatch 2',
  'r6':                'Rainbow Six Siege',
  'rainbow six':       'Rainbow Six Siege',
  'warzone':           'Warzone',
  'albion':            'Albion Online',
  'albion online':     'Albion Online',
  'pubg':              'PUBG',
  'minecraft':         'Minecraft',
  'dota':              'Dota 2',
  'dota 2':            'Dota 2',
  'tf2':               'Team Fortress 2',
  'hearthstone':       'Hearthstone',
  'rust':              'Rust',
  'tarkov':            'Escape from Tarkov',
  'eft':               'Escape from Tarkov',
  'gta':               'GTA',
  'gta5':              'GTA V',
  'gta v':             'GTA V',
  'roblox':            'Roblox',
}

// Ordenadas por largo desc para que "league of legends" matchee antes que "league"
const _ALIAS_ENTRIES = Object.entries(GAME_ALIASES).sort((a, b) => b[0].length - a[0].length)

function detectGameFromText(text) {
  if (!text) return null
  const lower = text.toLowerCase()
  for (const [alias, game] of _ALIAS_ENTRIES) {
    if (new RegExp(`\\b${alias.replace(/[-]/g, '\\-')}\\b`, 'i').test(lower)) return game
  }
  return null
}

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

ALIASES COMUNES DE JUEGOS (usá el nombre completo):
- "lol" = "League of Legends"
- "valo" = "Valorant"
- "csgo" / "cs2" = "CS2"
- "apex" = "Apex Legends"
- "ow2" / "overwatch" = "Overwatch 2"
- "r6" = "Rainbow Six Siege"
- "albion" = "Albion Online"
- "fortnite" = "Fortnite"

Respondé SOLO con JSON válido con esta estructura:
{
  "game": "nombre completo del juego (null si no se menciona ni se puede inferir)",
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

    // Si el clasificador no detectó juego, buscar por alias conocidos en la pregunta
    let gameName = extracted?.game?.trim() || ''
    if (!gameName || gameName.toLowerCase() === 'null' || gameName.toLowerCase() === 'unknown') {
      gameName = detectGameFromText(question) || ''
    }
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

module.exports = { getMemory, getRawMemory, saveMemory, clearMemory, detectGameFromText }
