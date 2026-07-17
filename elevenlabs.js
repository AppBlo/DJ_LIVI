// elevenlabs.js
// Genera el audio de la voz del DJ usando ElevenLabs (mucho más natural que
// Flowery TTS), respetando las etiquetas de emoción del modelo v3.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'tts_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * @param {string} texto - puede incluir una etiqueta de emoción al principio,
 *   ej: "[entusiasmado] Che, prepárense para esto..."
 * @returns {Promise<string>} ruta absoluta al archivo .mp3 generado
 */
async function generarAudioElevenLabs(texto) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: texto,
      model_id: 'eleven_v3',
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs error: ${response.status} ${await response.text()}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filepath = path.join(CACHE_DIR, `dj_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function limpiarArchivosViejos() {
  const files = fs.readdirSync(CACHE_DIR);
  const now = Date.now();
  for (const f of files) {
    const full = path.join(CACHE_DIR, f);
    const stat = fs.statSync(full);
    if (now - stat.mtimeMs > 1000 * 60 * 30) fs.unlinkSync(full); // 30 min
  }
}

module.exports = { generarAudioElevenLabs, limpiarArchivosViejos };
