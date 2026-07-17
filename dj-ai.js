// dj-ai.js
// Usa Claude (Anthropic) para que el DJ arme una frase acorde a la onda real
// de la canción (en vez de una plantilla fija), con una etiqueta de emoción
// para que ElevenLabs la locute con el tono correcto. También maneja los
// "chistes internos" del grupo y las dedicatorias random a gente del canal.

const EMOTION_TAGS = [
  '[entusiasmado]',
  '[energico]',
  '[tono calido]',
  '[tono suave]',
  '[melancolico]',
  '[misterioso]',
  '[alegre]',
];

// Chistes internos del grupo: si el autor de la canción matchea (case
// insensitive, "incluye"), el DJ va a mencionar esa frase siempre.
// Para agregar más, sumá una línea acá: 'nombre del artista en minúscula': 'frase'.
const ARTIST_JOKES = {
  'sabrina carpenter': 'la señora del Pablo',
};

// Probabilidad de que el DJ le dedique la canción/tanda a alguien random del canal.
const PROBABILIDAD_DEDICATORIA = 0.2; // 1 de cada 5, aprox.

function buscarChisteDeArtista(author) {
  if (!author) return null;
  const key = Object.keys(ARTIST_JOKES).find((k) => author.toLowerCase().includes(k));
  return key ? ARTIST_JOKES[key] : null;
}

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
 * @param {{title: string, author: string, miembrosCanal?: string[]}} datos
 */
async function generarFraseConIA({ title, author, miembrosCanal = [] }) {
  const chiste = buscarChisteDeArtista(author);
  const dedicatoria = elegirDedicatoria(miembrosCanal);

  let extra = '';
  if (chiste) {
    extra += `\nDato importante y obligatorio: en esta frase tenés que mencionar, tal cual, este chiste interno del grupo: "${chiste}".`;
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

module.exports = { generarFraseConIA, generarIntroPlaylist };
