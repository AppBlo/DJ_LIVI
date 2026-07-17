// dj.js
// Con Lavalink, la voz del DJ la genera el propio servidor de Lavalink
// (plugin Flowery TTS), así que este módulo ya no genera audio: solo arma
// el texto que el DJ va a decir.

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

/**
 * @param {{title: string, author: string}} track - info básica del track
 *   (viene de track.info de lavalink-client).
 */
function buildIntroText(track) {
  const title = track?.title || 'este tema';
  const author = track?.author || 'artista desconocido';
  return pick(INTRO_TEMPLATES)
    .replace('{title}', title)
    .replace('{author}', author);
}

function buildWelcomeText() {
  return pick(WELCOME_TEMPLATES);
}

module.exports = { buildIntroText, buildWelcomeText };
