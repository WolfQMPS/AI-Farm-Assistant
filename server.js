import express from 'express'
import fetch from 'node-fetch'
import Anthropic from '@anthropic-ai/sdk'

const app = express()
app.use(express.json())

const VERIFY_TOKEN = 'your_verify_token'   // set in Meta dashboard
const WA_TOKEN    = process.env.WA_TOKEN   // WhatsApp API token
const PHONE_ID    = process.env.PHONE_ID   // WhatsApp phone number ID
const SHEET_URL   = process.env.SHEET_URL  // Google Apps Script webhook URL

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── 1. Meta webhook verification ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

// ─── 2. Receive incoming WhatsApp messages ──────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // always respond to Meta immediately

  const entry   = req.body.entry?.[0]
  const changes = entry?.changes?.[0]?.value
  const message = changes?.messages?.[0]
  if (!message) return

  const from = message.from  // worker's phone number
  const type = message.type  // 'image', 'audio', 'text', 'document'

  try {
    await handleMessage(from, message, changes)
  } catch (err) {
    console.error('Error handling message:', err)
  }
})

// ─── 3. Route by message type ───────────────────────────────────────────────
async function handleMessage(from, message, changes) {
  let imageBase64 = null
  let transcribedText = ''
  let userText = ''

  // Extract image
  if (message.type === 'image') {
    const mediaId = message.image.id
    imageBase64   = await downloadMedia(mediaId)
  }

  // Extract & transcribe audio
  if (message.type === 'audio') {
    const mediaId   = message.audio.id
    const audioUrl  = await getMediaUrl(mediaId)
    transcribedText = await transcribeAudio(audioUrl)
  }

  // Extract text
  if (message.type === 'text') {
    userText = message.text.body
  }

  const combinedInput = [transcribedText, userText].filter(Boolean).join('\n')

  // Get AI feedback
  const feedback = await getFeedback(imageBase64, combinedInput)

  // Reply on WhatsApp
  await sendWhatsApp(from, feedback)

  // Log to Google Sheets
  await logToSheets({ from, userText: combinedInput, feedback, timestamp: new Date().toISOString() })
}

// ─── 4. Download media from Meta ────────────────────────────────────────────
async function getMediaUrl(mediaId) {
  const res  = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` }
  })
  const data = await res.json()
  return data.url
}

async function downloadMedia(mediaId) {
  const url    = await getMediaUrl(mediaId)
  const res    = await fetch(url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } })
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

// ─── 5. Transcribe audio (OpenAI Whisper) ───────────────────────────────────
async function transcribeAudio(audioUrl) {
  // Download audio then send to Whisper
  const audioRes    = await fetch(audioUrl, { headers: { Authorization: `Bearer ${WA_TOKEN}` } })
  const audioBuffer = await audioRes.arrayBuffer()
  const formData    = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg')
  formData.append('model', 'whisper-1')

  const whisperRes  = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData
  })
  const whisperData = await whisperRes.json()
  return whisperData.text || ''
}

// ─── 6. Get AI feedback from Claude ─────────────────────────────────────────
async function getFeedback(imageBase64, textInput) {
  const content = []

  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } })
  }
  if (textInput) {
    content.push({ type: 'text', text: textInput })
  }
  if (content.length === 0) return 'No image or audio received.'

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: `You are a dairy farm quality control assistant. 
When given an image and/or description of a problem, respond with:
- Issue: (1 sentence, what you see)
- Severity: Low / Medium / High
- Cause: (1 sentence)
- Action: (1-2 sentences, what the milker should do now)
Keep the response short and clear. Write in plain English.`,
    messages: [{ role: 'user', content }]
  })

  return response.content[0].text
}

// ─── 7. Send WhatsApp reply ──────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  await fetch(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  })
}

// ─── 8. Log to Google Sheets ────────────────────────────────────────────────
// (Set up a Google Apps Script on your sheet that accepts POST requests)
async function logToSheets(data) {
  await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
}

app.listen(3000, () => console.log('Farm Assistant running on port 3000'))
