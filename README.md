# DJ Discord Bot

Bot de música para Discord (YouTube + Spotify) con un locutor DJ tipo TTS
que anuncia cada canción antes de que suene, al estilo del AI DJ de Spotify.

## 1. Requisitos

- Node.js 18 o superior.
- FFmpeg instalado en el sistema (o dejá que `ffmpeg-static` lo resuelva solo,
  ya está en las dependencias).
- Una app de Discord creada en https://discord.com/developers/applications
  con el bot invitado a tu servidor con permisos de **Conectar** y **Hablar**
  en canales de voz, y **Enviar mensajes** / **Leer historial** en texto.
- Habilitar el intent **Message Content Intent** en el portal de desarrolladores
  (Bot > Privileged Gateway Intents).

## 2. Instalación

```bash
npm install
cp .env.example .env
```

Editá `.env` y pegá tu token del bot:

```
DISCORD_TOKEN=tu_token_real
PREFIX=!
TTS_LANG=es
```

## 3. Correrlo

```bash
npm start
```

## 4. Comandos

| Comando | Qué hace |
|---|---|
| `!play <canción o link>` | Reproduce o encola una canción (YouTube o Spotify). |
| `!skip` | Salta a la siguiente canción. |
| `!stop` | Corta todo y vacía la cola. |
| `!pause` / `!resume` | Pausa / reanuda. |
| `!volume 50` | Cambia el volumen (0-100). |
| `!queue` | Muestra la cola actual. |
| `!dj on` / `!dj off` | Prende o apaga el locutor DJ. |

## 5. Sobre la voz del DJ

Por defecto usa **Google TTS gratuito** (vía `node-gtts`), que suena parecido
a la voz de Google Traductor: entendible pero robótica, no una voz de radio
pulida. Es gratis y no necesita API key, ideal para probar.

Si más adelante querés una voz mucho más natural (más parecida a un DJ real),
en `dj.js` dejé comentada una implementación con **ElevenLabs** (voces neuronales,
tiene plan gratuito limitado y planes pagos). Solo hay que:

1. `npm i node-fetch`
2. Sacar una API key en https://elevenlabs.io
3. Descomentar `generateTTS_ElevenLabs` en `dj.js` y usarla en vez de
   `generateTTS` en `index.js`.

## 6. Cómo funciona el anuncio (por si querés tocarlo)

Cuando arranca una canción nueva (evento `playSong` de DisTube):
1. Se pausa la cola.
2. Se genera un audio TTS con una frase random tipo "Y seguimos con todo,
   esto que viene es *{título}*, de *{autor}*".
3. Se reproduce ese audio interrumpiendo momentáneamente la conexión de voz.
4. Se le devuelve la conexión a DisTube y se reanuda la canción.

Las frases están en `dj.js`, en el array `INTRO_TEMPLATES` — sumá las que
quieras para que no se sienta repetitivo.

## 7. Problemas comunes

- **"FFMPEG not found"**: asegurate que `ffmpeg-static` se instaló bien, o
  instalá ffmpeg manualmente (`sudo apt install ffmpeg` en Linux).
- **No reproduce Spotify**: el plugin de Spotify busca el equivalente en
  YouTube automáticamente, no necesita credenciales de Spotify. Si un tema
  específico no lo encuentra, probá pasándole el nombre en vez del link.
- **El DJ no habla / corta la canción de golpe sin voz**: revisá la consola,
  puede ser un límite de uso del TTS gratuito de Google (si abusás mucho,
  a veces devuelve error). En ese caso conviene migrar a ElevenLabs.
