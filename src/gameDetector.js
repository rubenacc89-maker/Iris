const { execSync } = require('child_process')

// Mapa de ejecutable → nombre de juego
const GAME_PROCESSES = {
  // MMO / RPG Online
  'Albion-Online.exe':                    'Albion Online',
  'Albion.exe':                           'Albion Online',
  'LOSTARK.exe':                          'Lost Ark',
  'BlackDesert64.exe':                    'Black Desert Online',
  'NewWorld.exe':                         'New World',
  'ffxiv_dx11.exe':                       'Final Fantasy XIV',
  'ffxiv.exe':                            'Final Fantasy XIV',
  'Wow.exe':                              'World of Warcraft',
  'WowClassic.exe':                       'World of Warcraft Classic',
  'GenshinImpact.exe':                    'Genshin Impact',
  'StarRail.exe':                         'Honkai: Star Rail',
  'ZenlessZoneZero.exe':                  'Zenless Zone Zero',
  'WutheringWaves.exe':                   'Wuthering Waves',

  // FPS / Battle Royale
  'VALORANT.exe':                         'Valorant',
  'VALORANT-Win64-Shipping.exe':          'Valorant',
  'cs2.exe':                              'Counter-Strike 2',
  'csgo.exe':                             'CS:GO',
  'r5apex.exe':                           'Apex Legends',
  'FortniteClient-Win64-Shipping.exe':    'Fortnite',
  'TslGame.exe':                          'PUBG',
  'RainbowSix.exe':                       'Rainbow Six Siege',
  'RainbowSix_BE.exe':                    'Rainbow Six Siege',
  'cod.exe':                              'Call of Duty',
  'ModernWarfare.exe':                    'Call of Duty: Modern Warfare',
  'Warzone.exe':                          'Warzone',
  'BF2042.exe':                           'Battlefield 2042',
  'bf2042.exe':                           'Battlefield 2042',
  'EscapeFromTarkov.exe':                 'Escape from Tarkov',
  'RustClient.exe':                       'Rust',
  'DeadByDaylight-Win64-Shipping.exe':    'Dead by Daylight',
  'Phasmophobia.exe':                     'Phasmophobia',

  // MOBA / Estrategia
  'League of Legends.exe':               'League of Legends',
  'dota2.exe':                            'Dota 2',
  'SC2.exe':                              'StarCraft II',
  'Warcraft III.exe':                     'Warcraft III',
  'HeroesOfTheStorm.exe':                 'Heroes of the Storm',
  'LoR.exe':                              'Legends of Runeterra',
  'Hearthstone.exe':                      'Hearthstone',

  // Deportes / Carreras
  'RocketLeague.exe':                     'Rocket League',
  'FIFA24.exe':                           'EA FC 24',
  'FC24.exe':                             'EA FC 24',
  'FC25.exe':                             'EA FC 25',
  'FIFA23.exe':                           'FIFA 23',
  'eFootball.exe':                        'eFootball',

  // Acción / Aventura / RPG
  'Overwatch.exe':                        'Overwatch 2',
  'destiny2.exe':                         'Destiny 2',
  'eldenring.exe':                        'Elden Ring',
  'DarkSoulsIII.exe':                     'Dark Souls III',
  'Cyberpunk2077.exe':                    'Cyberpunk 2077',
  'GTA5.exe':                             'GTA V',
  'RDR2.exe':                             'Red Dead Redemption 2',
  'witcher3.exe':                         'The Witcher 3',
  'Diablo IV.exe':                        'Diablo IV',
  'Diablo III.exe':                       'Diablo III',
  'PathOfExile.exe':                      'Path of Exile',
  'PathOfExile_x64.exe':                  'Path of Exile',
  'PathOfExile2.exe':                     'Path of Exile 2',
  'Hades.exe':                            'Hades',
  'Hades2.exe':                           'Hades II',
  'hollow_knight.exe':                    'Hollow Knight',
  'HollowKnight.exe':                     'Hollow Knight',
  'Brawlhalla.exe':                       'Brawlhalla',

  // Extraction Shooters
  'ArcRaiders.exe':                       'Arc Raiders',
  'Arc Raiders.exe':                      'Arc Raiders',

  // Survival / Sandbox
  'ShooterGame.exe':                      'ARK: Survival Evolved',
  'Valheim.exe':                          'Valheim',
  'DayZ_x64.exe':                        'DayZ',
  'Among Us.exe':                         'Among Us',

  // Indie / Casual
  'Stardew Valley.exe':                   'Stardew Valley',
  'Terraria.exe':                         'Terraria',
  'Minecraft.exe':                        'Minecraft',
}

// Cache para no llamar tasklist en cada mensaje
let _lastDetected = null
let _lastCheck    = 0
const CACHE_MS    = 15_000

function detectRunningGame() {
  const now = Date.now()
  if (now - _lastCheck < CACHE_MS) return _lastDetected
  _lastCheck = now

  try {
    const output = execSync('tasklist /FO CSV /NH', {
      encoding:    'utf8',
      timeout:     3000,
      windowsHide: true,
    })
    for (const line of output.split('\n')) {
      const match = line.match(/^"([^"]+)"/)
      if (!match) continue
      const game = GAME_PROCESSES[match[1]]
      if (game) {
        console.log('[GAME] Proceso detectado:', match[1], '→', game)
        _lastDetected = game
        return game
      }
    }
    _lastDetected = null
    return null
  } catch {
    // Si tasklist falla (raro), devolvemos el último conocido
    return _lastDetected
  }
}

module.exports = { detectRunningGame }
