const { createClient } = require('@supabase/supabase-js')
// Node.js 18 no tiene WebSocket nativo — lo proveemos con el paquete ws
if (typeof WebSocket === 'undefined') {
  global.WebSocket = require('ws')
}

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

let supabase = null

function getClient() {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
  return supabase
}

async function login(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password })
  if (error) return { error: translateError(error.message) }
  return { user: { id: data.user.id, email: data.user.email, username: data.user.user_metadata?.username || email } }
}

async function register(email, password, username) {
  const { data, error } = await getClient().auth.signUp({
    email,
    password,
    options: { data: { username } }
  })
  if (error) return { error: translateError(error.message) }
  return { user: { id: data.user.id, email: data.user.email, username } }
}

function translateError(msg) {
  if (msg.includes('Invalid login')) return 'Email o contraseña incorrectos.'
  if (msg.includes('already registered')) return 'Este email ya está registrado.'
  if (msg.includes('Password should')) return 'La contraseña debe tener al menos 6 caracteres.'
  if (msg.includes('Unable to validate')) return 'Email inválido.'
  return msg
}

module.exports = { login, register }
