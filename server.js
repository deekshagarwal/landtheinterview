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

async function extractTextFromFile(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();
  if (ext === '.pdf' || mimetype === 'application/pdf') {
    if (!pdfParse) throw new Error('PDF parsing not available');
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (ext === '.docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if (!mammoth) throw new Error('Word parsing not available');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === '.txt' || mimetype === 'text/plain') {
    return buffer.toString('utf-8');
  }
  throw new Error('Unsupported file type. Please upload PDF, Word (.docx), or text file.');
}

app.post('/api/tailor', upload.single('cv'), async (req, res) => {
  try {
    const { jd, email } = req.body;

    if (!req.file) return res.status(400).json({ error: 'Please upload your CV.' });
    if (!jd || jd.trim().length < 50) return res.status(400).json({ error: 'Please paste a job description (minimum 50 characters).' });

    let cvText;
    try {
      cvText = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!cvText || cvText.trim().length < 100) {
      return res.status(400).json({ error: 'Could not read your CV. Please make sure it contains text (not just images).' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API configuration error.' });

    const prompt = `You are an expert resume writer and career coach. Your job is to tailor a candidate's resume to match a specific job description perfectly.

INSTRUCTIONS:
1. Analyze the job description to identify: key skills, required experience, important keywords, tone, and priorities
2. Rewrite the candidate's CV to match the JD language exactly
3. Keep all factual information accurate - do not invent experience or skills
4. Restructure bullet points to lead with the most relevant achievements for THIS specific role
5. Return a JSON response with this exact structure:

{
  "score": <number 0-100 representing JD match percentage>,
  "keywords": {
    "matched": [<array of keywords from JD found in CV>],
    "partial": [<array of keywords partially matching or implied>],
    "missing": [<array of important JD keywords not in CV>]
  },
  "tailored_cv": "<the full rewritten CV as plain text>",
  "improvements": [<array of 3 key changes made>],
  "better_than": <number 50-95>
}

CANDIDATE CV:
${cvText}

JOB DESCRIPTION:
${jd}

Return ONLY the JSON. No preamble, no markdown.`;

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 60000
      }
    );

    const rawText = claudeResponse.data.content[0].text;
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch(e) {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse AI response');
      }
    }

    if (email && email.includes('@')) {
      try {
        await axios.post(
          'https://api.brevo.com/v3/contacts',
          { email, listIds: [2], updateEnabled: true },
          { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
        );
      } catch(e) {
        console.log('Brevo error:', e.message);
      }
    }

    res.json({ success: true, data: result });

  } catch (error) {
    console.error('Tailor error:', error.message);
    if (error.response?.data) console.error('API error full:', JSON.stringify(error.response.data)); console.error('API status:', error.response?.status); console.error('API headers:', JSON.stringify(error.response?.headers));
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
