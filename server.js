const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── YOUR API KEYS (set these in Railway environment variables) ───────────────
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '200mb' }));

// Multer stores uploaded audio in memory (max 200MB for long recordings)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Flashyyy Backend running',
    assemblyai: ASSEMBLYAI_KEY ? 'configured' : 'MISSING',
    anthropic:  ANTHROPIC_KEY  ? 'configured' : 'MISSING',
  });
});

// ─── STEP 1: Upload audio → get AssemblyAI upload URL ────────────────────────
// App sends audio file here. We forward it to AssemblyAI and return upload_url.
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received' });
    }

    console.log(`Received audio: ${req.file.originalname}, size: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`);

    // Forward the raw bytes to AssemblyAI
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
      },
      body: req.file.buffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error('AssemblyAI upload error:', err);
      return res.status(500).json({ error: 'Upload to AssemblyAI failed', detail: err });
    }

    const data = await uploadRes.json();
    console.log('Upload success, url:', data.upload_url);
    res.json({ upload_url: data.upload_url });

  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── STEP 2: Start transcription ──────────────────────────────────────────────
// App sends { upload_url }. We submit to AssemblyAI and return transcript_id.
app.post('/transcribe', async (req, res) => {
  try {
    const { upload_url } = req.body;
    if (!upload_url) {
      return res.status(400).json({ error: 'upload_url is required' });
    }

    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: upload_url,
        language_detection: true,   // auto-detects Hindi, English, Hinglish, etc.
        punctuate: true,
        format_text: true,
        speaker_labels: true,
        speakers_expected: 2,
      }),
    });

    if (!transcriptRes.ok) {
      const err = await transcriptRes.text();
      console.error('AssemblyAI transcribe error:', err);
      return res.status(500).json({ error: 'Transcription request failed', detail: err });
    }

    const data = await transcriptRes.json();
    console.log('Transcription started, id:', data.id);
    res.json({ transcript_id: data.id });

  } catch (e) {
    console.error('Transcribe error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── STEP 3: Poll transcription status ────────────────────────────────────────
// App polls this with transcript_id until status = completed.
app.get('/transcript/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: ASSEMBLYAI_KEY },
    });

    if (!pollRes.ok) {
      const err = await pollRes.text();
      return res.status(500).json({ error: 'Poll failed', detail: err });
    }

    const data = await pollRes.json();

    if (data.status === 'completed') {
      // Format transcript with speaker labels if available
      let transcript = data.text || '';
      if (data.utterances && data.utterances.length > 0) {
        transcript = data.utterances
          .map(u => `Speaker ${u.speaker}: ${u.text}`)
          .join('\n');
      }
      console.log(`Transcript complete for ${id}, language: ${data.language_code}, words: ${data.words?.length}`);
      return res.json({
        status: 'completed',
        transcript,
        language: data.language_code,
        words: data.words?.length || 0,
      });
    }

    if (data.status === 'error') {
      console.error('AssemblyAI error for', id, ':', data.error);
      return res.json({ status: 'error', error: data.error });
    }

    // Still processing
    return res.json({ status: data.status });

  } catch (e) {
    console.error('Poll error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── STEP 4: Generate AI summary with Claude ──────────────────────────────────
// App sends { transcript, contactName, contactCompany, contactRole, duration, preMeetingNotes }.
// We call Claude and return the full structured analysis.
app.post('/summarise', async (req, res) => {
  try {
    const {
      transcript = '',
      contactName = 'Contact',
      contactCompany = '',
      contactRole = '',
      duration = 0,
      preMeetingNotes = '',
      meetingType = 'business',
    } = req.body;

    const role = [contactRole, contactCompany].filter(Boolean).join(' at ');
    const durStr = duration >= 60
      ? `${Math.floor(duration / 60)}m ${duration % 60}s`
      : `${duration}s`;
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = `You are an expert business meeting analyst. Analyze this meeting and return ONLY valid JSON — no markdown, no explanation.

Meeting details:
- Contact: ${contactName}${role ? ` (${role})` : ''}
- Type: ${meetingType}
- Duration: ${durStr}
- Date: ${today}
- Pre-meeting context: ${preMeetingNotes || 'None'}

Transcript:
${transcript || 'No transcript available — generate from context.'}

Return EXACTLY this JSON structure:
{
  "sentiment": "Positive" or "Negative" or "Neutral",
  "confidence": number 0-100,
  "summary": "2-3 sentence executive summary of what was discussed and decided",
  "keyPoints": ["key point 1", "key point 2", "key point 3", "key point 4"],
  "actionItems": ["action 1", "action 2", "action 3"],
  "nextSteps": ["next step 1", "next step 2"],
  "topics": ["topic 1", "topic 2", "topic 3", "topic 4"],
  "dealPotential": "High" or "Medium" or "Low",
  "negotiationInsights": "One sentence on leverage and negotiation dynamics",
  "suggestedFollowUpDate": "e.g. Tomorrow, In 3 days, Next Monday",
  "followUpEmail": "Complete professional follow-up email. Address ${contactName.split(' ')[0]} by first name. Reference specifics from the meeting. Keep under 200 words.",
  "minutesOfMeeting": "Formal Minutes of Meeting with sections: Date, Attendees, Duration, Agenda, Discussion Points, Key Decisions, Action Items, Next Steps, Outcome"
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude error:', err);
      return res.status(500).json({ error: 'Claude API failed', detail: err });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '';

    // Clean and parse JSON
    const clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse failed, raw:', raw.substring(0, 500));
      return res.status(500).json({ error: 'Could not parse Claude response' });
    }

    console.log(`Summary generated for ${contactName}, sentiment: ${analysis.sentiment}`);
    res.json({ success: true, analysis });

  } catch (e) {
    console.error('Summarise error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── COMBINED ENDPOINT: Upload + Transcribe + Summarise in one call ───────────
// For simplicity — app uploads file here and waits for everything.
// This is a long-running request (30-120 seconds for transcription).
// The app shows a progress screen while waiting.
app.post('/process', upload.single('audio'), async (req, res) => {
  // Set a long timeout for this endpoint
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);

  try {
    const {
      contactName, contactCompany, contactRole,
      duration, preMeetingNotes, meetingType,
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file' });
    }

    console.log(`Processing: ${contactName}, ${(req.file.size/1024/1024).toFixed(1)}MB, ${duration}s`);

    // ── Upload to AssemblyAI ───────────────────────────────────────────────
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/octet-stream',
      },
      body: req.file.buffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(500).json({ error: 'Upload failed', detail: err });
    }

    const { upload_url } = await uploadRes.json();

    // ── Start transcription ────────────────────────────────────────────────
    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: upload_url,
        language_detection: true,
        punctuate: true,
        format_text: true,
        speaker_labels: true,
        speakers_expected: 2,
      }),
    });

    if (!transcriptRes.ok) {
      const err = await transcriptRes.text();
      return res.status(500).json({ error: 'Transcription start failed', detail: err });
    }

    const { id: transcriptId } = await transcriptRes.json();

    // ── Poll until complete ────────────────────────────────────────────────
    let transcript = '';
    let language = '';
    let attempts = 0;
    const maxAttempts = 100; // ~5 minutes

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 3000));
      attempts++;

      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: ASSEMBLYAI_KEY },
      });

      if (!poll.ok) continue;
      const pollData = await poll.json();

      if (pollData.status === 'completed') {
        language = pollData.language_code || '';
        if (pollData.utterances && pollData.utterances.length > 0) {
          transcript = pollData.utterances
            .map(u => `Speaker ${u.speaker}: ${u.text}`)
            .join('\n');
        } else {
          transcript = pollData.text || '';
        }
        break;
      }

      if (pollData.status === 'error') {
        return res.status(500).json({ error: 'Transcription failed', detail: pollData.error });
      }
    }

    if (!transcript) {
      return res.status(500).json({ error: 'Transcription timed out' });
    }

    console.log(`Transcript done: ${transcript.length} chars, language: ${language}`);

    // ── Generate summary with Claude ───────────────────────────────────────
    const role = [contactRole, contactCompany].filter(Boolean).join(' at ');
    const durStr = duration >= 60
      ? `${Math.floor(duration / 60)}m ${parseInt(duration) % 60}s`
      : `${duration}s`;
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const prompt = `You are an expert business meeting analyst. Analyze this ${meetingType || 'business'} meeting. Return ONLY valid JSON — no markdown.

Contact: ${contactName}${role ? ` (${role})` : ''}
Duration: ${durStr} | Date: ${today}
Context: ${preMeetingNotes || 'None'}

Transcript:
${transcript}

Return EXACTLY this JSON:
{
  "sentiment": "Positive" or "Negative" or "Neutral",
  "confidence": 0-100,
  "summary": "2-3 sentence executive summary",
  "keyPoints": ["point 1","point 2","point 3","point 4"],
  "actionItems": ["action 1","action 2","action 3"],
  "nextSteps": ["step 1","step 2"],
  "topics": ["topic 1","topic 2","topic 3","topic 4"],
  "dealPotential": "High" or "Medium" or "Low",
  "negotiationInsights": "one sentence on leverage/dynamics",
  "suggestedFollowUpDate": "e.g. Tomorrow, In 3 days",
  "followUpEmail": "Professional follow-up email to ${(contactName || 'Contact').split(' ')[0]}, under 200 words",
  "minutesOfMeeting": "Formal MOM: Date, Attendees, Duration, Discussion, Action Items, Next Steps, Outcome"
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ error: 'Claude failed', detail: err });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '';
    const clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();

    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Could not parse AI response' });
    }

    console.log(`Complete! ${contactName}: ${analysis.sentiment}, ${analysis.actionItems?.length} actions`);

    res.json({
      success: true,
      transcript,
      language,
      analysis,
    });

  } catch (e) {
    console.error('Process error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Flashyyy backend running on port ${PORT}`);
  console.log(`AssemblyAI: ${ASSEMBLYAI_KEY ? 'configured' : 'MISSING - set ASSEMBLYAI_KEY env var'}`);
  console.log(`Anthropic:  ${ANTHROPIC_KEY  ? 'configured' : 'MISSING - set ANTHROPIC_KEY env var'}`);
});
