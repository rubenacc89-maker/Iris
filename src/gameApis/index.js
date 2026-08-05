// Router lazy: solo carga el módulo del juego activo
// Agregar nuevos juegos acá cuando tengamos sus APIs

const GAME_API_MAP = {
  'albion online':      () => require('./albion'),
  'albion':             () => require('./albion'),
  'league of legends':  () => require('./lol'),
  'league':             () => require('./lol'),
  'lol':                () => require('./lol'),
}

function getGameApi(gameName) {
  if (!gameName) return null
  const key = gameName.toLowerCase().trim()
  const loader = GAME_API_MAP[key]
  if (!loader) return null
  try {
    return loader()
  } catch {
    return null
  }
}

module.exports = { getGameApi }
