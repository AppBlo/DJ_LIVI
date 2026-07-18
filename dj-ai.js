// dj-ai.js
// Usa Claude (Anthropic) para que el DJ arme una frase acorde a la onda real
// de la canción (en vez de una plantilla fija), con una etiqueta de emoción
// para que ElevenLabs la locute con el tono correcto. También maneja los
// apodos del grupo, los chistes internos y las dedicatorias random.

const EMOTION_TAGS = [
  '[entusiasmado]',
  '[energico]',
  '[tono calido]',
  '[tono suave]',
  '[melancolico]',
  '[misterioso]',
  '[alegre]',
];

// Apodos: mapeamos el nombre que aparece en Discord (en minúscula) a las
// formas que el DJ puede usar para referirse a esa persona (varía random).
const APODOS = {
  'argamol (pablo i.)': ['Pablo', 'Pablito'],
  'alabaster1698': ['Emma', 'El Emma', 'Emmanuel', 'Emmanuel Alvaro José', 'Emazilia'],
  'despreet': ['Bastian', 'El Basty'],
};

function apodoDe(nombreDiscord) {
  const opciones = APODOS[nombreDiscord?.toLowerCase()];
  if (!opciones) return nombreDiscord;
  return opciones[Math.floor(Math.random() * opciones.length)];
}

// Chistes internos por artista. "base" siempre aplica; "conPablo" se suma
// solo si detectamos que Pablo está conectado al canal en ese momento.
const ARTIST_JOKES = {
  'sabrina carpenter': {
    base: 'Hay un chiste interno del grupo con esta cantante: es "la señora de Pablo" / "la mujer de Pablo". Es obligatorio tocar este chiste de alguna forma, pero variá cómo lo decís cada vez, no repitas siempre la misma frase — a veces decí directamente que es la señora del Pablo, otras veces tirale un piropo tipo "qué mujer" en relación a él, otras veces un comentario gracioso distinto sobre que a Pablo le encanta esta cantante. Elegí una forma distinta cada vez, variá las palabras.',
    conPablo: 'Pablo está conectado en el canal de voz ahora mismo, así que podés dirigirte directo a él con el chiste si querés.',
  },
};

function buscarChisteDeArtista(author) {
  if (!author) return null;
  const key = Object.keys(ARTIST_JOKES).find((k) => author.toLowerCase().includes(k));
  return key ? ARTIST_JOKES[key] : null;
}

// Probabilidad de que el DJ le dedique la canción/tanda a alguien random del canal.
const PROBABILIDAD_DEDICATORIA = 0.2; // 1 de cada 5, aprox.

function elegirDedicatoria(miembrosCanal) {
  if (!miembrosCanal?.length) return null;
  if (Math.random() > PROBABILIDAD_DEDICATORIA) return null;
  return miembrosCanal[Math.floor(Math.random() * miembrosCanal.length)];
}

async function llamarClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const texto = data?.content?.find((b) => b.type === 'text')?.text?.trim();
  if (!texto) throw new Error('Anthropic no devolvió texto utilizable');
  return texto;
}

/**
 * Frase para anunciar UNA canción puntual.
 * @param {{title: string, author: string, miembrosCanal?: string[], pabloPresente?: boolean}} datos
 */
async function generarFraseConIA({ title, author, miembrosCanal = [], pabloPresente = false }) {
  const chiste = buscarChisteDeArtista(author);
  const dedicatoria = elegirDedicatoria(miembrosCanal);

  let extra = '';
  if (chiste) {
    extra += `\n${chiste.base}`;
    if (pabloPresente && chiste.conPablo) extra += `\n${chiste.conPablo}`;
  }
  if (dedicatoria) {
    extra += `\nDedicale esta canción a "${dedicatoria}" de forma random y divertida (ej: "esta va para vos, ${dedicatoria}").`;
  }

  const prompt = `Sos un DJ animando una fiesta de amigos en Chile, hablás en español informal y cercano (nada acartonado).
Te paso el título y artista de una canción. Escribí UNA sola frase corta (máximo 15 palabras) para anunciarla justo antes de que suene, transmitiendo la onda real de esa canción específica (si es reggaetón o algo fiestero, sonar con energía; si es una balada o algo triste/melancólico, sonar más calmo y sentido; usá tu conocimiento real de la canción si la conocés).

Empezá la frase con UNA sola etiqueta de emoción entre corchetes, eligiendo la que más calce entre estas opciones exactas: ${EMOTION_TAGS.join(', ')}.
Después de la etiqueta, escribí la frase en español (los nombres propios de la canción o el artista los podés dejar en su idioma original).
Devolvé SOLO la etiqueta seguida de la frase, nada más — sin comillas, sin explicaciones, sin texto extra.
${extra}

Canción: "${title}"
Artista: ${author}`;

  return llamarClaude(prompt);
}

/**
 * Frase para presentar una tanda de varias canciones (playlist), sin
 * nombrarlas una por una — solo la onda general de lo que viene.
 * @param {{titulos: string[], miembrosCanal?: string[]}} datos
 */
async function generarIntroPlaylist({ titulos, miembrosCanal = [] }) {
  const dedicatoria = elegirDedicatoria(miembrosCanal);

  const prompt = `Sos un DJ animando una fiesta de amigos en Chile, hablás en español informal y cercano.
Te paso una lista de canciones que van a sonar en los próximos minutos. NO las nombres una por una — es solo para que sepas la onda general del grupo de temas. Escribí UNA frase corta (máximo 15 palabras) presentando la tanda que viene, transmitiendo el mood general (ej: "esto que viene es puro reggaetón para el bailongo" o "bajamos el ritmo con unas baladas para cerrar la noche").

Empezá con una etiqueta de emoción entre corchetes, eligiendo entre: ${EMOTION_TAGS.join(', ')}.
Devolvé SOLO la etiqueta + la frase, sin comillas ni explicaciones.
${dedicatoria ? `Dedicale esta tanda a "${dedicatoria}" de forma random y divertida.` : ''}

Próximas canciones:
${titulos.map((t) => `- ${t}`).join('\n')}`;

  return llamarClaude(prompt);
}

/**
 * Comentario cortito cuando alguien se une o se va del canal de voz.
 * @param {{persona: string, evento: 'entro'|'se_fue'}} datos
 */
async function generarReaccionCanal({ persona, evento }) {
  const accion = evento === 'entro' ? 'se acaba de conectar al canal de voz' : 'se acaba de ir del canal de voz';
  const prompt = `Sos un DJ animando una fiesta de amigos en Chile, español informal y cercano.
${persona} ${accion}. Hacé UN comentario bien cortito (máximo 12 palabras), gracioso o cálido, mencionando a esa persona por su nombre.
Empezá con una etiqueta de emoción entre corchetes elegida de: ${EMOTION_TAGS.join(', ')}.
Devolvé SOLO la etiqueta + el comentario, nada más.`;

  return llamarClaude(prompt);
}

/**
 * Respuesta del DJ a una pregunta directa de alguien del grupo.
 * @param {string} pregunta
 */
async function responderPregunta(pregunta) {
  const prompt = `Sos Livi, una asistente de voz presente en un canal de Discord. Hablás en español, con un tono amable, claro y moderadamente formal — cercano pero no coloquial, sin jerga de DJ ni expresiones de fiesta.
Alguien te hizo esta pregunta o comentario: "${pregunta}"
Respondé de forma breve y directa (máximo 30 palabras). Si la pregunta es sobre música, podés dar contexto útil (año, artista, género, dato interesante). Si es una pregunta general, respondé con precisión.
Empezá con una etiqueta de emoción entre corchetes elegida de: ${EMOTION_TAGS.join(', ')}.
Devolvé SOLO la etiqueta + la respuesta, nada más.`;

  return llamarClaude(prompt);
}

/**
 * Saludo inicial cuando Livi se conecta por primera vez al canal.
 * @param {string[]} miembros - nombres de la gente en el canal
 */
async function generarSaludo(miembros) {
  const lista = miembros.length ? miembros.join(', ') : 'todos';
  const prompt = `Sos Livi, DJ de una fiesta de amigos en Chile, español informal y cercano.
Acabás de conectarte al canal de voz. Saludá a la gente que está ahí: ${lista}.
Hacé UN saludo corto y con onda (máximo 15 palabras), mencionando a alguno o todos por nombre si son pocos.
Empezá con una etiqueta de emoción entre corchetes elegida de: ${EMOTION_TAGS.join(', ')}.
Devolvé SOLO la etiqueta + el saludo, nada más.`;

  return llamarClaude(prompt);
}

/**
 * @param {string} promptBase - instrucción base sobre qué comentar
 * @param {string} contextoGente - string con los nombres de quien está en el canal
 */
async function llamarClaudeEspontaneo(promptBase, contextoGente = '') {
  const prompt = `Sos Livi, DJ animando una fiesta de amigos en Chile. Hablás en español informal y cercano.
${contextoGente}
${promptBase}
Escribí UNA sola frase corta (máximo 15 palabras).
Empezá con una etiqueta de emoción entre corchetes elegida de: ${EMOTION_TAGS.join(', ')}.
Devolvé SOLO la etiqueta + la frase, nada más.`;

  return llamarClaude(prompt);
}

module.exports = { generarFraseConIA, generarIntroPlaylist, generarReaccionCanal, responderPregunta, llamarClaudeEspontaneo, generarSaludo, apodoDe };
