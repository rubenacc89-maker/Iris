const { version } = require('../package.json')

const URL  = 'https://ptkfxanrkbbgthmmhevn.supabase.co/rest/v1'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a2Z4YW5ya2JiZ3RobW1oZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzkyNTksImV4cCI6MjA5OTgxNTI1OX0.b0b1FV5OC2wpwdI6ABZ3YR7kRXXcwtrIFpTn0Qa3Rrc'

const HEADERS = {
  'apikey':        ANON,
  'Authorization': `Bearer ${ANON}`,
  'Content-Type':  'application/json'
}

async function fetchAppKeys() {
  const res = await fetch(`${URL}/app_config?select=key_name,key_value`, { headers: HEADERS })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`)
  const rows = await res.json()
  for (const row of rows) process.env[row.key_name] = row.key_value
  console.log('[CONFIG] Keys cargadas:', rows.map(r => r.key_name).join(', '))
}

async function logTelemetry(event, userId = null, details = {}) {
  try {
    await fetch(`${URL}/telemetry`, {
      method:  'POST',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ event, user_id: userId, app_version: version, platform: process.platform, details })
    })
  } catch (_) {}
}

module.exports = { fetchAppKeys, logTelemetry }
