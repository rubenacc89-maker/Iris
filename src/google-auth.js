/**
 * Flujo OAuth 2.0 + PKCE para Google en Electron.
 * No usa redirecciones web — levanta un servidor local temporal
 * que captura el callback de Google en el navegador nativo.
 */
const http   = require('http')
const crypto = require('crypto')
const { shell } = require('electron')

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function pkce() {
  const verifier  = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

const SUCCESS_HTML = `
<!doctype html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#060606;color:#e8e8e8;font-family:'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px}
svg{width:36px;height:36px;fill:#fff;opacity:.7}
h2{font-size:16px;font-weight:500;letter-spacing:1px}
p{font-size:12px;color:#666}</style></head>
<body>
<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>
<h2>SESIÓN INICIADA</h2>
<p>Podés cerrar esta pestaña y volver a Iris.</p>
<script>setTimeout(()=>window.close(),2000)</script>
</body></html>`

const ERROR_HTML = (msg) => `
<!doctype html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}body{background:#060606;color:#e8e8e8;font-family:'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:8px}
h2{font-size:14px;color:#f38ba8}p{font-size:11px;color:#666}</style></head>
<body><h2>Error al iniciar sesión</h2><p>${msg}</p></body></html>`

function startGoogleAuthFlow() {
  return new Promise((resolve, reject) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return reject(new Error('Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en .env'))
    }

    const server = http.createServer()

    server.listen(0, '127.0.0.1', () => {
      const port  = server.address().port
      const state = crypto.randomBytes(16).toString('hex')
      const { verifier, challenge } = pkce()

      const redirectUri = `http://127.0.0.1:${port}/callback`

      const params = new URLSearchParams({
        client_id:             CLIENT_ID,
        redirect_uri:          redirectUri,
        response_type:         'code',
        scope:                 'openid email profile',
        state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
        access_type:           'offline',
        prompt:                'select_account'
      })

      shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)

      const timeout = setTimeout(() => {
        server.close()
        reject(new Error('Timeout: el usuario no completó el login en 5 minutos'))
      }, 5 * 60 * 1000)

      server.on('request', async (req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${port}`)
          if (url.pathname !== '/callback') { res.end(); return }

          const code          = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const errorParam    = url.searchParams.get('error')

          clearTimeout(timeout)
          server.close()

          if (errorParam) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(ERROR_HTML(errorParam))
            return reject(new Error(`Google OAuth error: ${errorParam}`))
          }

          if (!code || returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(ERROR_HTML('Estado inválido — posible ataque CSRF'))
            return reject(new Error('Estado OAuth inválido'))
          }

          // Intercambiar código por tokens
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    new URLSearchParams({
              code,
              client_id:     CLIENT_ID,
              client_secret: CLIENT_SECRET,
              redirect_uri:  redirectUri,
              grant_type:    'authorization_code',
              code_verifier: verifier
            })
          })

          const tokens = await tokenRes.json()

          if (tokens.error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(ERROR_HTML(tokens.error_description || tokens.error))
            return reject(new Error(tokens.error_description || tokens.error))
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(SUCCESS_HTML)

          resolve(tokens.id_token)
        } catch (e) {
          server.close()
          res.writeHead(500)
          res.end()
          reject(e)
        }
      })

      server.on('error', (e) => {
        clearTimeout(timeout)
        reject(new Error('Error al iniciar servidor local: ' + e.message))
      })
    })
  })
}

module.exports = { startGoogleAuthFlow }
