import { serve } from "https://deno.land/std@0.208.0/http/server.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODELS = ['llama-3.1-8b-instant', 'llama3-8b-8192', 'gemma2-9b-it']
const GEMINI_MODELS_VISION = [
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
]

async function callGroq(messages: unknown[], max_tokens: number, single_model?: string): Promise<string> {
  const key = Deno.env.get('GROQ_API_KEY')
  if (!key) throw new Error('GROQ_API_KEY no configurada en Edge Function')

  const models = single_model ? [single_model] : GROQ_MODELS

  for (const model of models) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens, temperature: 0.3 }),
    })

    if (!res.ok) {
      const txt = await res.text()
      console.log(`[ai-chat] Error ${res.status} en ${model}, probando siguiente... ${txt.substring(0, 100)}`)
      continue
    }

    const data = await res.json()
    return data.choices[0].message.content.trim()
  }

  throw new Error('Todos los modelos Groq están ocupados, intentá en unos segundos.')
}

async function callGemini(systemPrompt: string, userText: string, screenshotBase64: string): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY no configurada en Edge Function')

  const body = JSON.stringify({
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: screenshotBase64 } },
        { text: systemPrompt + '\n\n' + userText },
      ]
    }],
    generationConfig: { temperature: 0.3, topK: 40, topP: 0.8, maxOutputTokens: 500 },
  })

  for (const model of GEMINI_MODELS_VISION) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

    if (res.status === 404) {
      console.log(`[ai-chat] Gemini modelo ${model} no encontrado, probando siguiente...`)
      continue
    }
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Gemini ${model} ${res.status}: ${txt.substring(0, 200)}`)
    }

    const data = await res.json()
    console.log(`[ai-chat] Gemini modelo usado: ${model}`)
    return data.candidates[0].content.parts[0].text.trim()
  }

  throw new Error('Ningún modelo Gemini disponible para visión con esta API key')
}

async function callGeminiEmbed(text: string, taskType: string): Promise<number[]> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY no configurada en Edge Function')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType,
    }),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Embed Gemini ${res.status}: ${txt.substring(0, 200)}`)
  }

  const data = await res.json()
  return data.embedding.values
}

async function callGeminiGrounded(systemPrompt: string, userText: string, chatHistory: {question: string, answer: string}[], max_tokens: number, groqMessages: unknown[]): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY no configurada en Edge Function')

  const contents: unknown[] = []
  for (const h of (chatHistory || [])) {
    contents.push({ role: 'user',  parts: [{ text: h.question }] })
    contents.push({ role: 'model', parts: [{ text: h.answer   }] })
  }
  contents.push({ role: 'user', parts: [{ text: userText }] })

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.3, maxOutputTokens: max_tokens },
  })

  for (const model of GEMINI_MODELS_VISION) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

    if (res.status === 404 || res.status === 429) {
      console.log(`[ai-chat] Gemini grounded ${model} ${res.status}, probando siguiente...`)
      continue
    }
    if (!res.ok) {
      const txt = await res.text()
      console.log(`[ai-chat] Gemini grounded ${model} error: ${txt.substring(0, 100)}`)
      continue
    }

    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) {
      console.log(`[ai-chat] Gemini grounded modelo usado: ${model}`)
      return text.trim()
    }
  }

  // Fallback a Groq si todos los modelos Gemini fallan
  console.log('[ai-chat] Gemini grounded sin resultado, usando Groq como fallback...')
  return await callGroq(groqMessages, max_tokens)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json()
    const { type, messages, max_tokens = 500, systemPrompt, userText, screenshotBase64 } = body

    // Clasificador visual — respuesta rápida
    if (type === 'classify') {
      const result = await callGroq(messages, 5, 'llama-3.1-8b-instant')
      return new Response(JSON.stringify({ result }), { headers: CORS })
    }

    // Gemini con visión
    if (type === 'vision' && screenshotBase64) {
      const text = await callGemini(systemPrompt ?? '', userText ?? '', screenshotBase64)
      return new Response(JSON.stringify({ text, vision: true }), { headers: CORS })
    }

    // Embeddings vectoriales
    if (type === 'embed') {
      const { text: embedText, taskType = 'RETRIEVAL_DOCUMENT' } = body
      const values = await callGeminiEmbed(embedText, taskType)
      return new Response(JSON.stringify({ values }), { headers: CORS })
    }

    // Chat con Gemini + Google Search grounding + historial
    if (type === 'grounded-chat') {
      const { chatHistory = [], messages: groqMessages } = body
      const text = await callGeminiGrounded(systemPrompt ?? '', userText ?? '', chatHistory, max_tokens, groqMessages)
      return new Response(JSON.stringify({ text, vision: false }), { headers: CORS })
    }

    // Groq texto con fallback de modelos
    const text = await callGroq(messages, max_tokens)
    return new Response(JSON.stringify({ text, vision: false }), { headers: CORS })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ai-chat] Error:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS })
  }
})
