const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');

let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch(e) {}
try { mammoth = require('mammoth'); } catch(e) {}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

async function extractText(buffer, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (ext === 'txt') return buffer.toString('utf-8');
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  throw new Error('Please upload a PDF, Word (.docx), or text file.');
}

async function callGroq(messages, maxTokens = 4000) {
  const apiKey = process.env.GROQ_API_KEY;
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 55000
    }
  );
  return response.data.choices[0].message.content.trim();
}

function cleanAndParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }
  // Remove bad control characters except newlines and tabs
  cleaned = cleaned.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  try {
    return JSON.parse(cleaned);
  } catch(e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI response');
  }
}

app.post('/api/tailor', upload.single('cv'), async (req, res) => {
  try {
    const { jd, email } = req.body;

    if (!req.file) return res.status(400).json({ error: 'Please upload your CV.' });
    if (!jd || jd.trim().length < 50) return res.status(400).json({ error: 'Please paste the full job description.' });

    let cvText;
    try {
      cvText = await extractText(req.file.buffer, req.file.originalname);
    } catch(e) {
      return res.status(400).json({ error: e.message });
    }

    if (!cvText || cvText.trim().length < 50) {
      return res.status(400).json({ error: 'Could not read your CV. Please make sure it contains text.' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

    const cvSlice = cvText.slice(0, 8000);
    const jdSlice = jd.slice(0, 4000);

    // ── CALL 1: Rewrite the full CV ───────────────────────────────────
    console.log('Call 1: Rewriting CV...');

    const rewritePrompt = `You are the hiring manager at the company in this JD. You know exactly what skills and experience would get a resume shortlisted.

Rewrite the candidate's CV to match this JD with these strict rules:
1. NEVER remove any bullet points — every single bullet from the original must appear in the output.
2. NEVER remove quantified achievements — all revenue numbers, percentages, and metrics must be preserved exactly.
3. Do not add skills, tools, or experience not present in the CV. Only reframe and reorder what exists.
4. Use exact JD terminology where the candidate's experience maps to it — weave it naturally, never append phrases at the end.
5. Maintain the same section order as the original CV.
6. Reorder bullets within each role so the most JD-relevant achievements appear first.
7. Surface implicit skills naturally — B.Tech background = technical fluency, AI tools usage = AI native, etc.

Return ONLY the rewritten CV as plain text. No JSON, no explanation, no markdown.

ORIGINAL CV:
${cvSlice}

JOB DESCRIPTION:
${jdSlice}`;

    const tailoredCV = await callGroq([
      { role: 'system', content: 'You are an expert resume writer. Return only the rewritten CV as plain text. No JSON, no markdown, no explanation.' },
      { role: 'user', content: rewritePrompt }
    ], 4000);

    console.log('Call 1 complete. CV length:', tailoredCV.length);

    // ── CALL 2: Generate score + keywords + improvements ──────────────
    console.log('Call 2: Generating analysis...');

    const analysisPrompt = `Compare this candidate's CV against the job description and return a JSON analysis.

Return ONLY a valid JSON object. No markdown, no explanation:
{
  "score": <0-100, based on keyword overlap, skills alignment and experience relevance>,
  "keywords": {
    "matched": ["keyword1", "keyword2"],
    "partial": ["keyword3"],
    "missing": ["only significant gaps that would hurt shortlisting"]
  },
  "improvements": ["specific change made 1", "specific change made 2", "specific change made 3"],
  "better_than": <50-95, estimated percentile vs typical applicant>
}

CV:
${cvSlice.slice(0, 2000)}

JD:
${jdSlice.slice(0, 2000)}`;

    const analysisRaw = await callGroq([
      { role: 'system', content: 'You are a resume analyst. Always respond with valid JSON only.' },
      { role: 'user', content: analysisPrompt }
    ], 1000);

    console.log('Call 2 complete.');

    const analysis = cleanAndParse(analysisRaw);

    // Combine both calls into final result
    const result = {
      score: analysis.score,
      keywords: analysis.keywords,
      tailored_cv: tailoredCV,
      improvements: analysis.improvements,
      better_than: analysis.better_than
    };

    // Brevo (non-blocking)
    if (email && email.includes('@') && process.env.BREVO_API_KEY) {
      axios.post(
        'https://api.brevo.com/v3/contacts',
        { email, listIds: [2], updateEnabled: true },
        { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
      ).catch(e => console.log('Brevo:', e.message));
    }

    res.json({ success: true, data: result });

  } catch(error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Body:', JSON.stringify(error.response.data));
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', hasKey: !!process.env.GROQ_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
module.exports = app;
