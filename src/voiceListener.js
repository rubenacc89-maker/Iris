const fs   = require('fs')
const path = require('path')
const os   = require('os')
const Groq = require('groq-sdk')

// Groq SDK requiere File global (disponible en Node 20+, no en versiones anteriores)
if (!globalThis.File) {
  const { File } = require('buffer')
  globalThis.File = File
}

const GROQ_KEY = process.env.GROQ_API_KEY || ''
let groq = null

function getGroq() {
  if (!groq) groq = new Groq({ apiKey: GROQ_KEY })
  return groq
}

// Recibe audio en base64 (webm/opus), retorna el texto transcripto
async function transcribeAudio(audioBase64) {
  if (!GROQ_KEY) throw new Error('Sin GROQ_API_KEY')

  const buffer = Buffer.from(audioBase64, 'base64')
  if (buffer.length < 500) throw new Error('Audio demasiado corto')

  const tmpPath = path.join(os.tmpdir(), `iris_cmd_${Date.now()}.webm`)
  fs.writeFileSync(tmpPath, buffer)

  try {
    const result = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      language: 'es',
      // Sesga la transcripción hacia nombres de artistas y canciones comunes
      // para evitar errores fonéticos como "Bakboni" en lugar de "Bad Bunny"
      prompt: 'Bad Bunny, Daddy Yankee, J Balvin, Maluma, Ozuna, Anuel AA, Karol G, RKM & Ken-Y, Don Omar, Nicky Jam, Farruko, Rauw Alejandro, Myke Towers, Jhay Cortez, Sech, Bizarrap, Shakira, Marc Anthony, Romeo Santos, Aventura, Drake, Eminem, Taylor Swift, The Weeknd, Post Malone, Imagine Dragons, Coldplay, Spotify, playlist, reggaeton, trap, salsa, bachata, cumbia'
    })
    const text = result.text?.trim() || ''
    console.log('[VOZ] Transcripción Whisper:', text)
    return text
  } finally {
    try { fs.unlinkSync(tmpPath) } catch (_) {}
  }
}

module.exports = { transcribeAudio }
