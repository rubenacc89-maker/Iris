const fs   = require('fs')
const path = require('path')
const os   = require('os')
const Groq = require('groq-sdk')

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
      response_format: 'json'
    })
    const text = result.text?.trim() || ''
    console.log('[VOZ] Transcripción Whisper:', text)
    return text
  } finally {
    try { fs.unlinkSync(tmpPath) } catch (_) {}
  }
}

module.exports = { transcribeAudio }
