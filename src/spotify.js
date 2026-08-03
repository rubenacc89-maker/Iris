const http   = require('http')
const crypto = require('crypto')
const { shell } = require('electron')

const CLIENT_ID    = 'e608b6c0bc24431fa3411dd6a8ab63e4'
const REDIRECT_URI = 'http://127.0.0.1:8889/spotify-callback'
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ')

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function genVerifier()         { return crypto.randomBytes(32).toString('base64url') }
function genChallenge(v)       { return crypto.createHash('sha256').update(v).digest('base64url') }

// ─── OAuth PKCE flow ──────────────────────────────────────────────────────────
function startAuth(store, userId) {
  return new Promise((resolve, reject) => {
    const verifier  = genVerifier()
    const challenge = genChallenge(verifier)
    const state     = crypto.randomBytes(8).toString('hex')

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1:8889')
      if (url.pathname !== '/spotify-callback') return
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px"><h2 style="color:#1DB954">✓ Spotify conectado a Iris</h2><p style="color:#aaa">Podés cerrar esta ventana y volver al juego.</p></body></html>')
      server.close()

      const code          = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      if (returnedState !== state) { reject(new Error('State mismatch')); return }

      try {
        const tokens = await exchangeCode(code, verifier)
        store.set(`spotify_tokens_${userId}`, tokens)
        resolve(tokens)
      } catch (e) { reject(e) }
    })

    server.on('error', reject)
    server.listen(8889, '127.0.0.1', () => {
      const url = new URL('https://accounts.spotify.com/authorize')
      url.searchParams.set('client_id',             CLIENT_ID)
      url.searchParams.set('response_type',         'code')
      url.searchParams.set('redirect_uri',          REDIRECT_URI)
      url.searchParams.set('scope',                 SCOPES)
      url.searchParams.set('state',                 state)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('code_challenge',        challenge)
      shell.openExternal(url.toString())
    })

    setTimeout(() => { server.close(); reject(new Error('Timeout esperando autorización de Spotify')) }, 180_000)
  })
}

async function exchangeCode(code, verifier) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier,
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description || data.error)
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + data.expires_in * 1000,
  }
}

// ─── Token management ─────────────────────────────────────────────────────────
async function getValidToken(store, userId) {
  const tokens = store.get(`spotify_tokens_${userId}`)
  if (!tokens) return null
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID,
      }),
    })
    const data = await res.json()
    if (data.error) { store.delete(`spotify_tokens_${userId}`); return null }
    const updated = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    }
    store.set(`spotify_tokens_${userId}`, updated)
    return updated.access_token
  } catch { return null }
}

// ─── Spotify API helper ───────────────────────────────────────────────────────
async function spotifyApi(token, method, path, body) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || `Spotify ${res.status}`)
  return data
}

// ─── Intent detection & parsing ───────────────────────────────────────────────
const MUSIC_RE = /\b(m[uú]sica|canci[oó]n|playlist|spotify|pon[eé]?m?e?|reproduc\w*|siguiente|pr[oó]xim[ao]|anterior|atr[aá]s|pausar?|pausá|reanudar|continuar|volumen|[aá]lbum|escucha[r]?|toca[r]?|shuffle|aleatori|qu[eé]\s+(suena|canta|toca|est[aá]))\b/i

// Verbos de música que pueden ser mal escritos — mínimo 5 chars para evitar falsos positivos
const MUSIC_VERBS = ['reproduce', 'reproducir', 'reproduciendo', 'playlist', 'escuchar', 'escucha', 'siguiente', 'anterior', 'spotify', 'musica', 'cancion', 'volumen', 'pausa', 'aleatorio', 'shuffle']

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i])
  for (let j = 1; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[m][n]
}

function isMusicCommand(text) {
  if (MUSIC_RE.test(text)) return true
  // Fuzzy: cualquier palabra de 5+ chars con distancia ≤2 a un verbo musical conocido
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/)
  return words.some(w => w.length >= 5 && MUSIC_VERBS.some(v => levenshtein(w, v) <= 2))
}

function parseSimple(text) {
  const t = text.toLowerCase()
  if (/\b(siguiente|skip|next|pr[oó]xim)\b/.test(t))                                      return { action: 'next' }
  if (/\b(anterior|atr[aá]s|prev(ious)?|volver|retroceder)\b/.test(t))                    return { action: 'previous' }
  if (/\b(pausa[r]?|pausá|detener)\b/.test(t) && !/\bpon[eé]?m?\b/.test(t))              return { action: 'pause' }
  if (/\b(reanudar|continuar|resume|seguir)\b/.test(t) && !/\bpon[eé]?m?\b/.test(t))     return { action: 'resume' }
  if (/qu[eé]\s+(canci[oó]n|suena|est[aá]\s+sonando|toca|canta)/.test(t))                return { action: 'current' }
  if (/\b(shuffle|aleatori)\b/.test(t))                                                    return { action: 'shuffle' }
  return null
}

async function parseMusicIntent(text) {
  const simple = parseSimple(text)
  if (simple) return simple

  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return { action: 'unknown' }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 150,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Sos un extractor de entidades musicales. El texto viene de reconocimiento de voz (STT) en español con posibles errores fonéticos o de tipeo. SOLO respondé con JSON válido sin markdown:
{"action":"play_track|play_artist|play_genre|play_playlist|volume_up|volume_down|volume_set|shuffle|unknown","track_name":"nombre de la canción corregido","artist_name":"nombre del artista corregido","query":"para género o playlist","volume":0}

PATRÓN PRINCIPAL — español: "[verbo] [canción] de [artista]"
Cuando el usuario dice "[comando] X de Y", X es la CANCIÓN y Y es el ARTISTA → action:play_track con ambos campos.
Si solo dicen artista sin canción → action:play_artist.

CORRECCIÓN FONÉTICA (STT español pronunciando nombres en inglés):
"Bac Bunny", "Bac Boney", "Bacbonny", "Backbone", "Back Booney" → "Bad Bunny"
"Dadi Yanki", "Dady Yenqui", "Dady Yankee" → "Daddy Yankee"
"Arcangel", "Arc Ángel", "Arcángel" → "Arcángel"
"rakin y ke y", "rkm y ken y", "rakin y ke Y" → "RKM & Ken-Y"
"Rau Alejandro", "Raw Alejandro" → "Rauw Alejandro"
"Anuel a a", "Anuel AA" → "Anuel AA"
"Karol yi", "Carol G", "Carol Ji" → "Karol G"

CORRECCIÓN DE CANCIÓN (reconstruí el título aunque esté garbled):
"tu no vives asi", "tú no vívig así", "tú no vives así", "tu no vib así" → "Tú No Vives Así"
"tu novio así" → puede ser "Tú No Vives Así" si hay artista reggaeton/trap
Usá el contexto del artista para deducir la canción cuando el STT la distorsiona.

EJEMPLOS:
"reproduce tú no vives así de Bad Bunny" → {"action":"play_track","track_name":"Tú No Vives Así","artist_name":"Bad Bunny","query":"","volume":0}
"reproduce tu no vívig así de Bac Bunny" → {"action":"play_track","track_name":"Tú No Vives Así","artist_name":"Bad Bunny","query":"","volume":0}
"reproduce tu novio así de Bac Boney y Arcángel" → {"action":"play_track","track_name":"Tú No Vives Así","artist_name":"Bad Bunny","query":"","volume":0}
"Gasolina de Daddy Yankee" → {"action":"play_track","track_name":"Gasolina","artist_name":"Daddy Yankee","query":"","volume":0}
"down de rakin y ke y" → {"action":"play_track","track_name":"Down","artist_name":"RKM & Ken-Y","query":"","volume":0}
"reproduce Despacito de Luis Fonsi" → {"action":"play_track","track_name":"Despacito","artist_name":"Luis Fonsi","query":"","volume":0}
"reproduce Bad Bunny" → {"action":"play_artist","track_name":"","artist_name":"Bad Bunny","query":"","volume":0}
"poneme reggaeton" → {"action":"play_genre","track_name":"","artist_name":"","query":"reggaeton","volume":0}
"mi playlist de gaming" → {"action":"play_playlist","track_name":"","artist_name":"","query":"gaming","volume":0}
"volumen al 60" → {"action":"volume_set","track_name":"","artist_name":"","query":"","volume":60}`
          },
          { role: 'user', content: text }
        ]
      })
    })
    const data    = await res.json()
    const content = data.choices?.[0]?.message?.content?.trim() || '{}'
    return JSON.parse(content)
  } catch {
    return { action: 'unknown' }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleMusicCommand(message, store, userId) {
  const token = await getValidToken(store, userId)
  if (!token) {
    return { text: 'Primero conectá Spotify desde ⚙ Config → "Conectar Spotify" 🎵', silent: false }
  }

  const intent = await parseMusicIntent(message)
  console.log('[SPOTIFY] Intent:', JSON.stringify(intent))

  try {
    switch (intent.action) {
      case 'play_artist': {
        const artistName = intent.artist_name || intent.query
        const q1 = intent.artist_name ? `artist:"${intent.artist_name}"` : artistName
        let r = await spotifyApi(token, 'GET', `/search?q=${encodeURIComponent(q1)}&type=artist&limit=1`)
        let artist = r.artists?.items?.[0]
        if (!artist && intent.artist_name) {
          const r2 = await spotifyApi(token, 'GET', `/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`)
          artist = r2.artists?.items?.[0]
        }
        if (!artist) return { text: `No encontré al artista "${artistName}" en Spotify.`, silent: false }
        await spotifyApi(token, 'PUT', '/me/player/play', { context_uri: artist.uri })
        return { text: `Poniendo ${artist.name} 🎵`, silent: true }
      }
      case 'play_track': {
        const trackName = intent.track_name || intent.query
        let q
        if (intent.track_name && intent.artist_name) {
          q = `track:"${intent.track_name}" artist:"${intent.artist_name}"`
        } else if (intent.track_name) {
          q = `track:"${intent.track_name}"`
        } else {
          q = intent.query || ''
        }
        let r = await spotifyApi(token, 'GET', `/search?q=${encodeURIComponent(q)}&type=track&limit=1`)
        let track = r.tracks?.items?.[0]
        if (!track && (intent.track_name || intent.artist_name)) {
          const freeQ = [intent.track_name, intent.artist_name].filter(Boolean).join(' ')
          const r2    = await spotifyApi(token, 'GET', `/search?q=${encodeURIComponent(freeQ)}&type=track&limit=1`)
          track = r2.tracks?.items?.[0]
        }
        if (!track) return { text: `No encontré "${trackName}" en Spotify.`, silent: false }
        await spotifyApi(token, 'PUT', '/me/player/play', { uris: [track.uri] })
        return { text: `Sonando: "${track.name}" — ${track.artists.map(a => a.name).join(', ')} 🎵`, silent: true }
      }
      case 'play_genre': {
        const r  = await spotifyApi(token, 'GET', `/search?q=${encodeURIComponent(intent.query)}&type=playlist&limit=3`)
        const pl = r.playlists?.items?.[0]
        if (!pl) return { text: `No encontré playlists de ${intent.query}.`, silent: false }
        await spotifyApi(token, 'PUT', '/me/player/play', { context_uri: pl.uri })
        return { text: `Poniendo ${intent.query} 🎵`, silent: true }
      }
      case 'play_playlist': {
        const r     = await spotifyApi(token, 'GET', '/me/playlists?limit=50')
        const match = r.items?.find(p => p.name.toLowerCase().includes(intent.query.toLowerCase()))
        if (!match) return { text: `No encontré ninguna playlist tuya que diga "${intent.query}". ¿Cómo se llama exactamente?`, silent: false }
        await spotifyApi(token, 'PUT', '/me/player/play', { context_uri: match.uri })
        return { text: `Poniendo playlist "${match.name}" 🎵`, silent: true }
      }
      case 'next':
        await spotifyApi(token, 'POST', '/me/player/next')
        return { text: 'Siguiente ⏭', silent: true }
      case 'previous':
        await spotifyApi(token, 'POST', '/me/player/previous')
        return { text: 'Anterior ⏮', silent: true }
      case 'pause':
        await spotifyApi(token, 'PUT', '/me/player/pause')
        return { text: 'Pausado ⏸', silent: true }
      case 'resume':
        await spotifyApi(token, 'PUT', '/me/player/play')
        return { text: 'Reproduciendo ▶', silent: true }
      case 'volume_set': {
        const vol = Math.min(100, Math.max(0, intent.volume || 50))
        await spotifyApi(token, 'PUT', `/me/player/volume?volume_percent=${vol}`)
        return { text: `Volumen al ${vol}% 🔊`, silent: true }
      }
      case 'volume_up': {
        const pb  = await spotifyApi(token, 'GET', '/me/player').catch(() => null)
        const cur = pb?.device?.volume_percent ?? 50
        const nv  = Math.min(100, cur + 20)
        await spotifyApi(token, 'PUT', `/me/player/volume?volume_percent=${nv}`)
        return { text: `Volumen al ${nv}% 🔊`, silent: true }
      }
      case 'volume_down': {
        const pb  = await spotifyApi(token, 'GET', '/me/player').catch(() => null)
        const cur = pb?.device?.volume_percent ?? 50
        const nv  = Math.max(0, cur - 20)
        await spotifyApi(token, 'PUT', `/me/player/volume?volume_percent=${nv}`)
        return { text: `Volumen al ${nv}% 🔊`, silent: true }
      }
      case 'shuffle':
        await spotifyApi(token, 'PUT', '/me/player/shuffle?state=true')
        return { text: 'Modo aleatorio activado 🔀', silent: true }
      case 'current': {
        const r = await spotifyApi(token, 'GET', '/me/player/currently-playing')
        if (!r?.item) return { text: 'No hay nada reproduciendo en Spotify ahora.', silent: false }
        return { text: `Suena: "${r.item.name}" — ${r.item.artists.map(a => a.name).join(', ')} 🎵`, silent: false }
      }
      default:
        return null // no es un comando musical claro → dejar que lo maneje la IA de gaming
    }
  } catch (err) {
    const msg = err.message || ''
    if (msg.includes('PREMIUM_REQUIRED') || msg.toLowerCase().includes('premium')) {
      return { text: 'El control de Spotify requiere cuenta Premium.', silent: false }
    }
    if (msg.includes('NO_ACTIVE_DEVICE') || msg.includes('404')) {
      return { text: 'Abrí Spotify y reproducí algo primero para activar el dispositivo.', silent: false }
    }
    console.error('[SPOTIFY] Error:', msg)
    return { text: `Error con Spotify: ${msg}`, silent: false }
  }
}

module.exports = { startAuth, handleMusicCommand, isMusicCommand, getValidToken }
