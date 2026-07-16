// dj.js
// Módulo encargado de la "personalidad" del DJ: arma frases de intro
// y las convierte a audio (TTS) para reproducirlas antes de cada canción.

const fs = require('fs');
const path = require('path');
const gTTS = require('node-gtts')(process.env.TTS_LANG || 'es');

const CACHE_DIR = path.join(__dirname, 'tts_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Plantillas de frases. {title} y {author} se reemplazan por los datos reales
// de la canción. Sumá las que quieras para que no suene repetitivo.
const INTRO_TEMPLATES = [
  'Y seguimos con todo. Esto que viene es {title}, de {author}.',
  'Subiendo la energía en la sala con {title}, por {author}.',
  'Para los que están conectados ahora mismo: suena {title}, de {author}.',
  'No se muevan de ahí, que llega {title}, cortesía de {author}.',
  'Directo desde la cabina: {title}, de {author}. Disfrútenlo.',
];

const WELCOME_TEMPLATES = [
  '¡Buenas! El DJ está en la cabina, arranquemos la sesión.',
  'Encendiendo el sistema de sonido. Vamos con la música.',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildIntroText(song) {
  const title = song?.name || 'este tema';
  const author = song?.uploader?.name || 'artista desconocido';
  return pick(INTRO_TEMPLATES)
    .replace('{title}', title)
    .replace('{author}', author);
}

function buildWelcomeText() {
  return pick(WELCOME_TEMPLATES);
}

/**
 * Genera un archivo mp3 con el texto dado usando Google TTS (gratis, calidad
 * "voz de traductor"). Devuelve la ruta al archivo generado.
 *
 * Si más adelante querés una voz más "profesional" tipo DJ de radio real,
 * mirá la función generateTTS_ElevenLabs() más abajo (comentada) y cambiá
 * la exportación.
 */
function generateTTS(text) {
  return new Promise((resolve, reject) => {
    const filename = `tts_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
    const filepath = path.join(CACHE_DIR, filename);
    gTTS.save(filepath, text, (err) => {
      if (err) return reject(err);
      resolve(filepath);
    });
  });
}

/*
// --- OPCIÓN PREMIUM (voz mucho más natural, requiere API key paga) ---
// npm i node-fetch
// const fetch = require('node-fetch');
// async function generateTTS_ElevenLabs(text) {
//   const voiceId = 'TU_VOICE_ID'; // elegís la voz en elevenlabs.io
//   const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
//     method: 'POST',
//     headers: {
//       'xi-api-key': process.env.ELEVENLABS_API_KEY,
//       'Content-Type': 'application/json',
//       'Accept': 'audio/mpeg',
//     },
//     body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
//   });
//   const buffer = await res.arrayBuffer();
//   const filepath = path.join(CACHE_DIR, `tts_${Date.now()}.mp3`);
//   fs.writeFileSync(filepath, Buffer.from(buffer));
//   return filepath;
// }
*/

function cleanupOldFiles() {
  const files = fs.readdirSync(CACHE_DIR);
  const now = Date.now();
  for (const f of files) {
    const full = path.join(CACHE_DIR, f);
    const stat = fs.statSync(full);
    if (now - stat.mtimeMs > 1000 * 60 * 30) fs.unlinkSync(full); // 30 min
  }
}

module.exports = {
  buildIntroText,
  buildWelcomeText,
  generateTTS,
  cleanupOldFiles,
};
