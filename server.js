const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

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
    if (!apiKey) {
      console.error('GROQ_API_KEY is missing');
      return res.status(500).json({ error: 'API key not configured.' });
    }

    console.log('Calling Groq API...');

    const prompt = `You are an expert resume writer. Tailor this candidate's CV to match the job description exactly.

Return ONLY a valid JSON object with this exact structure. No markdown, no explanation, no code blocks:
{
  "score": <number 0-100>,
  "keywords": {
    "matched": ["keyword1", "keyword2"],
    "partial": ["keyword3"],
    "missing": ["keyword4"]
  },
  "tailored_cv": "full rewritten CV as plain text preserving all sections",
  "improvements": ["change 1", "change 2", "change 3"],
  "better_than": <number 50-95>
}

CV:
${cvText.slice(0, 3000)}

JD:
${jd.slice(0, 3000)}`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are an expert resume writer. Always respond with valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 4000
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 55000
      }
    );

    console.log('Groq responded successfully');

    let text = response.data.choices[0].message.content.trim();
    if (text.startsWith('```')) {
      text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch(e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('Could not parse response');
    }

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
