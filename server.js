const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';

app.use(cors());
app.use(express.json({ limit: '100mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'Flashyyy Backend running',
    version: '4.0',
    assemblyai: ASSEMBLYAI_KEY ? 'configured' : 'MISSING',
    anthropic:  ANTHROPIC_KEY  ? 'configured' : 'MISSING',
  });
});

app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Backend is reachable!' });
});

app.post('/process-base64', async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  const {
    audioBase64,
    contactName = 'Contact',
    contactCompany = '',
    contactRole = '',
    duration = 0,
    preMeetingNotes = '',
    meetingType = 'business',
  } = req.body;

  if (!audioBase64) {
    return res.status(400).json({ success: false, error: 'No audio data received' });
  }

  console.log(`Processing: ${contactName}, base64 length: ${audioBase64.length}, duration: ${duration}s`);

  try {
    // STEP 1: Upload to AssemblyAI
    console.log('Converting base64 to buffer...');
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log(`Audio buffer: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/octet-stream',
      },
      body: audioBuffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error('Upload failed:', uploadRes.status, err);
      return res.status(500).json({ success: false, error: `Upload failed: ${err}` });
    }

    const { upload_url } = await uploadRes.json();
    console.log('Upload successful:', upload_url);

    // STEP 2: Start transcription
    const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: upload_url,
        speech_models: ['universal-3-pro', 'universal-2'],
        language_detection: true,
        punctuate: true,
        format_text: true,
        speaker_labels: true,
        speakers_expected: 2,
      }),
    });

    if (!transcriptRes.ok) {
      const err = await transcriptRes.text();
      console.error('Transcription start failed:', err);
      return res.status(500).json({ success: false, error: `Transcription failed: ${err}` });
    }

    const { id: transcriptId } = await transcriptRes.json();
    console.log('Transcription started, id:', transcriptId);

    // STEP 3: Poll until complete
    let transcript = '';
    let language = '';
    let attempts = 0;

    while (attempts < 100) {
      await new Promise(r => setTimeout(r, 3000));
      attempts++;

      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: ASSEMBLYAI_KEY },
      });

      if (!poll.ok) { console.warn('Poll failed, retrying...'); continue; }

      const pollData = await poll.json();
      console.log(`Poll ${attempts}: status=${pollData.status}`);

      if (pollData.status === 'completed') {
        language = pollData.language_code || 'en';
        if (pollData.utterances && pollData.utterances.length > 0) {
          transcript = pollData.utterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');
        } else {
          transcript = pollData.text || '';
        }
        console.log(`Transcription done! Language: ${language}, Length: ${transcript.length} chars`);
        break;
      }

      if (pollData.status === 'error') {
        console.error('Transcription error:', pollData.error);
        return res.status(500).json({ success: false, error: `Transcription error: ${pollData.error}` });
      }
    }

    if (!transcript) {
      return res.status(500).json({ success: false, error: 'Transcription timed out' });
    }

    // STEP 4: Generate summary with Claude
    console.log('Generating summary with Claude...');

    const role = [contactRole, contactCompany].filter(Boolean).join(' at ');
    const durStr = parseInt(duration) >= 60
      ? `${Math.floor(parseInt(duration) / 60)}m ${parseInt(duration) % 60}s`
      : `${duration}s`;
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const firstName = (contactName || 'Contact').split(' ')[0];

    const prompt = `You are an expert business meeting analyst for a ${meetingType} meeting. Return ONLY valid JSON — no markdown, no preamble.

Contact: ${contactName}${role ? ` (${role})` : ''}
Duration: ${durStr} | Date: ${today}
Context: ${preMeetingNotes || 'None'}
Language: ${language}

Transcript:
${transcript}

Return this EXACT JSON. For actionItems, extract every specific task, follow-up, or commitment mentioned.

{
  "sentiment": "Positive",
  "confidence": 85,
  "summary": "2-3 sentence executive summary",
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "actionItems": [
    {
      "text": "Specific action to be taken",
      "owner": "Us",
      "topic": "Other",
      "priority": "Medium",
      "status": "Pending",
      "notes": "context from transcript"
    }
  ],
  "nextSteps": ["next step 1", "next step 2"],
  "topics": ["topic 1", "topic 2"],
  "dealPotential": "Medium",
  "healthSignal": "Green",
  "negotiationInsights": "One sentence on leverage or dynamics",
  "suggestedFollowUpDate": "In 3 days",
  "churnRisk": "Low",
  "satisfactionSignals": ["signal 1"],
  "featureRequests": ["request 1"],
  "objections": ["objection 1"],
  "buyingSignals": ["signal 1"],
  "followUpEmail": "Professional follow-up email to ${firstName} referencing the meeting. Under 200 words.",
  "minutesOfMeeting": "Formal MOM. Date: ${today}. Attendees: You and ${contactName}. Duration: ${durStr}. Discussion: [summary]. Decisions: [key decisions]. Action Items: [list]. Next Steps: [list]. Outcome: [result]."
}

Rules:
- owner must be exactly: "Us" or "Client" or "Both"
- topic must be one of: "Product", "Pricing", "Integration", "Training", "Support", "Marketing", "Reporting", "Automation", "Technical", "Other"
- priority must be exactly: "High" or "Medium" or "Low"
- sentiment must be exactly: "Positive" or "Negative" or "Neutral"
- healthSignal must be exactly: "Green" or "Yellow" or "Red"`;

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
      console.error('Claude error:', claudeRes.status, err);
      return res.status(500).json({ success: false, error: `Claude API failed: ${err}` });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '';
    const clean = raw.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();

    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Failed to parse Claude response:', raw.substring(0, 500));
      return res.status(500).json({ success: false, error: 'Could not parse AI response' });
    }

    console.log(`Done! ${contactName}: ${analysis.sentiment}, ${analysis.actionItems?.length} actions`);

    res.json({ success: true, transcript, language, analysis });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Flashyyy backend v4.0 running on port ${PORT}`);
  console.log(`AssemblyAI: ${ASSEMBLYAI_KEY ? 'configured' : 'MISSING'}`);
  console.log(`Anthropic:  ${ANTHROPIC_KEY  ? 'configured' : 'MISSING'}`);
});
