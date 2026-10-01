export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    const texts = Array.isArray(payload.texts) ? payload.texts : [];
    const target = String(payload.target || 'en').trim() || 'en';
    const source = String(payload.source || 'en').trim() || 'en';

    const response = await fetch('https://translation-app-nine-pied.vercel.app/translate-batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ texts, source, target }),
    });

    const contentType = response.headers.get('content-type') || 'application/json';
    res.status(response.status).setHeader('Content-Type', contentType);
    res.send(await response.text());
  } catch (error) {
    res.status(500).json({
      error: 'Translation proxy failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}