const https = require('https')

const LOL_API = 'https://127.0.0.1:2999/liveclientdata'
const CACHE_MS = 10 * 1000  // 10s — datos cambian rápido en partida

let _cache = { data: null, at: 0 }

function fetchLiveData() {
  return new Promise((resolve, reject) => {
    const req = https.get(`${LOL_API}/allgamedata`, {
      rejectUnauthorized: false,  // certificado self-signed de Riot
      timeout: 3000
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function secondsToMinutes(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatContext(data) {
  try {
    const player  = data.activePlayer
    const stats   = player?.championStats || {}
    const gold    = Math.round(player?.currentGold || 0)
    const level   = player?.level || 1
    const gameTime = secondsToMinutes(data.gameData?.gameTime || 0)
    const gameMode = data.gameData?.gameMode || 'CLASSIC'

    // Encontrar al jugador activo en allPlayers
    const me = data.allPlayers?.find(p => p.summonerName === player?.summonerName || p.riotIdGameName === player?.summonerName)

    const champion = me?.championName || 'Desconocido'
    const kills    = me?.scores?.kills ?? 0
    const deaths   = me?.scores?.deaths ?? 0
    const assists  = me?.scores?.assists ?? 0
    const cs       = me?.scores?.creepScore ?? 0
    const team     = me?.team || ''

    // Items actuales
    const items = (me?.items || [])
      .filter(i => i.displayName)
      .map(i => i.displayName)
      .join(', ') || 'Sin items'

    // Habilidades con nivel
    const abilities = player?.abilities
    const spells = abilities
      ? ['Q','W','E','R'].map(k => {
          const ab = abilities[k]
          return ab ? `${k}: ${ab.displayName} (niv ${ab.abilityLevel})` : null
        }).filter(Boolean).join(' | ')
      : ''

    // Stats relevantes
    const statLines = [
      stats.abilityPower > 0   ? `AP: ${Math.round(stats.abilityPower)}` : null,
      stats.attackDamage > 0   ? `AD: ${Math.round(stats.attackDamage)}` : null,
      stats.armor > 0          ? `Armadura: ${Math.round(stats.armor)}` : null,
      stats.magicResist > 0    ? `Res. Mágica: ${Math.round(stats.magicResist)}` : null,
      stats.maxHealth > 0      ? `Vida máx: ${Math.round(stats.maxHealth)}` : null,
      stats.currentHealth > 0  ? `Vida actual: ${Math.round(stats.currentHealth)}` : null,
    ].filter(Boolean).join(' | ')

    return `[League of Legends — Datos en vivo de tu partida]
Campeón: ${champion} | Nivel: ${level} | Tiempo: ${gameTime} | Modo: ${gameMode}
KDA: ${kills}/${deaths}/${assists} | CS: ${cs} | Oro disponible: ${gold}
Items: ${items}
${spells ? `Habilidades: ${spells}` : ''}
${statLines ? `Stats: ${statLines}` : ''}
Equipo: ${team}`
  } catch {
    return null
  }
}

function isGameQuestion(text) {
  return /item|compro|compr[oaé]|oro|gold|build|qu[eé] llevo|qu[eé] tengo|kda|kills|muertes|asistencia|nivel|level|partida|minuto|tiempo|cs|súbdito|farm|stats|habilidad|spell|poder|daño|armadura|resistencia|vida|hp|campeón|champion|cómo voy|como voy/i.test(text)
}

async function fetchContext(question) {
  if (!isGameQuestion(question)) return null

  if (_cache.data && Date.now() - _cache.at < CACHE_MS) {
    return formatContext(_cache.data)
  }

  try {
    const data = await fetchLiveData()
    _cache = { data, at: Date.now() }
    return formatContext(data)
  } catch {
    // LoL no está corriendo o no hay partida activa — silencio
    return null
  }
}

module.exports = { fetchContext }
