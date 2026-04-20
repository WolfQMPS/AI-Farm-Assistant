import express from 'express'
import fetch from 'node-fetch'
import Anthropic from '@anthropic-ai/sdk'

const app = express()
app.use(express.json())

const VERIFY_TOKEN = process.env.VERIFY_TOKEN   // set in Meta dashboard
const WA_TOKEN    = process.env.WA_TOKEN   // WhatsApp API token
const PHONE_ID    = process.env.PHONE_ID   // WhatsApp phone number ID
const messageBuffer = new Map()


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

// ─── 3. Route messages ──────────────────────────────────
async function handleMessage(from, message, changes) {
  let imageBase64 = null
  let transcribedText = ''
  let userText = ''

  // Extract image
  if (message.type === 'image') {
    const mediaId = message.image.id
    imageBase64   = await downloadMedia(mediaId)

    // Store image and wait 30 seconds for a follow-up voice/text
    messageBuffer.set(from, { imageBase64, timestamp: Date.now() })
    await sendWhatsApp(from, 'Photo received! Now send a voice note or text describing the issue.')
    
    // Wait 30 seconds then process whatever we have
    setTimeout(async () => {
      const buffered = messageBuffer.get(from)
      if (buffered && buffered.imageBase64) {
        messageBuffer.delete(from)
        const feedback = await getFeedback(buffered.imageBase64, buffered.text || '')
        await sendWhatsApp(from, feedback)
        await logToAirtable({ 
          from, 
          userText: buffered.text || '(no description provided)', 
          feedback, 
          timestamp: new Date().toISOString(), 
          imageBase64: buffered.imageBase64 
        })
      }
    }, 30000)
    return
  }

  // If audio or text arrives and there's a buffered image for this person
  if (message.type === 'audio' || message.type === 'text') {
    const buffered = messageBuffer.get(from)

    if (message.type === 'audio') {
      const mediaId = message.audio.id
      const audioUrl = await getMediaUrl(mediaId)
      userText = await transcribeAudio(audioUrl)
    }

    if (message.type === 'text') {
      userText = message.text.body
    }

    if (buffered && buffered.imageBase64) {
      // We have both image + text/audio — process immediately
      clearTimeout(buffered.timeout)
      messageBuffer.delete(from)
      const feedback = await getFeedback(buffered.imageBase64, userText)
      await sendWhatsApp(from, feedback)
      await logToAirtable({ 
        from, 
        userText, 
        feedback, 
        timestamp: new Date().toISOString(), 
        imageBase64: buffered.imageBase64 
      })
    } else {
      // Text/audio with no image — ask for photo
      await sendWhatsApp(from, 'Please send a photo of the issue first, then follow up with a voice note or description.')
    }
    return
  }
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

  if (!imageBase64) {
    return 'Please always send a photo along with your message or voice note so we can assess the issue properly.'
  }

  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } })

  if (textInput) {
    content.push({ type: 'text', text: textInput })
  } else {
    return 'Please include a voice note or text description along with your photo.'
  }

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

// ─── 8. Log to Airtable ────────────────────────────────────────────────────
async function logToAirtable(data) {
  // First upload the image to Airtable if there is one
  let attachments = []
  if (data.imageBase64) {
    attachments = [{ 
      url: `data:image/jpeg;base64,${data.imageBase64}`,
      filename: `farm-${Date.now()}.jpg`
    }]
  }

  await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        Timestamp: data.timestamp,
        From: data.from,
        Message: data.userText,
        Feedback: data.feedback,
        Image: attachments
      }
    })
  })
}

app.listen(process.env.PORT || 3000, () => console.log('Farm Assistant running on port 3000'))
