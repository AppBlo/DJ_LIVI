// dj-ai.js
// Usa Claude (Anthropic) para que el DJ arme una frase acorde a la onda real
// de la canción (en vez de una plantilla fija), con una etiqueta de emoción
// para que ElevenLabs la locute con el tono correcto.

const EMOTION_TAGS = [
  '[entusiasmado]',
  '[energico]',
  '[tono calido]',
  '[tono suave]',
  '[melancolico]',
  '[misterioso]',
  '[alegre]',
];

/**
 * @param {{title: string, author: string}} track
 * @returns {Promise<string>} frase con etiqueta de emoción incluida, ej:
 *   "[entusiasmado] Preparate para saltar con este exitazo de reggaetón."
 */
async function generarFraseConIA(track) {
  const prompt = `Sos un DJ animando una fiesta de amigos en Chile, hablás en español informal y cercano (nada acartonado).
Te paso el título y artista de una canción. Escribí UNA sola frase corta (máximo 15 palabras) para anunciarla justo antes de que suene, transmitiendo la onda real de esa canción específica (si es reggaetón o algo fiestero, sonar con energía; si es una balada o algo triste/melancólico, sonar más calmo y sentido; usá tu conocimiento real de la canción si la conocés).

Empezá la frase con UNA sola etiqueta de emoción entre corchetes, eligiendo la que más calce entre estas opciones exactas: ${EMOTION_TAGS.join(', ')}.
Después de la etiqueta, escribí la frase en español (los nombres propios de la canción o el artista los podés dejar en su idioma original).
Devolvé SOLO la etiqueta seguida de la frase, nada más — sin comillas, sin explicaciones, sin texto extra.

Canción: "${track.title}"
Artista: ${track.author}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
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

module.exports = { generarFraseConIA };
