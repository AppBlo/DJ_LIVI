// index.js
// Bot de música para Discord usando Lavalink (en vez de DisTube) + locutor DJ
// con Flowery TTS (integrado en Lavalink vía el plugin LavaSrc).

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { execFile } = require('child_process');
const dj = require('./dj');
const djAI = require('./dj-ai');
const elevenlabs = require('./elevenlabs');

const PREFIX = process.env.PREFIX || '!';
const FLOWERY_VOICE = process.env.FLOWERY_VOICE || 'Sabela';

// ID del bot de Betty — Livi escucha sus embeds para comentar canciones ajenas.
// Podés encontrarlo activando el modo desarrollador en Discord (clic derecho → Copiar ID).
const BETTY_BOT_ID = process.env.BETTY_BOT_ID || '';

// Cada cuánto tiempo Livi tira un comentario espontáneo (rango random).
const COMENTARIO_ESPONTANEO_MIN_MS = 1 * 60 * 1000;  // 1 min mínimo
const COMENTARIO_ESPONTANEO_MAX_MS = 14 * 60 * 1000; // 14 min máximo

/**
 * Limpia los agregados típicos de los títulos de YouTube ("Video Oficial",
 * "Official Music Video", "Lyrics", etc.) para que el DJ y los mensajes del
 * chat digan solo el nombre real de la canción.
 */
function cleanTitle(title) {
  if (!title) return title;
  return title
    .replace(
      /[([]?\s*((official|oficial)\s*(music\s*)?video|video\s*(official|oficial)|official\s*audio|audio\s*(official|oficial)|lyric[s]?\s*video|letra\/?\s*lyrics?|official\s*lyric\s*video|visualizer)\s*[)\]]?/gi,
      '',
    )
    .replace(/\s*[|\-–]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Usa yt-dlp (instalado en el sistema) para resolver una búsqueda o link de
 * YouTube a una URL de audio directa reproducible. Evitamos así el
 * youtube-source de Lavalink, que puede quedar roto cuando YouTube cambia
 * su reproductor (yt-dlp se actualiza mucho más seguido contra esto).
 *
 * Devuelve { url, title, author } o null si no encontró nada.
 */
function resolveWithYtDlp(query) {
  return new Promise((resolve) => {
    const isUrl = /^https?:\/\//i.test(query);
    const target = isUrl ? query : `ytsearch5:${query}`;

    const args = [
      target,
      '-f', 'bestaudio',
      '--cookies', require('path').join(__dirname, 'cookies.txt'),
      '--print', '%(url)s|||%(title)s|||%(uploader)s|||%(duration)s',
    ];
    if (isUrl) args.splice(1, 0, '--no-playlist');

    execFile(
      'yt-dlp',
      args,
      { timeout: 25000, maxBuffer: 1024 * 1024 * 4 },
      (err, stdout, stderr) => {
        if (err || !stdout?.trim()) {
          console.error('[yt-dlp] Error:', err?.message || 'sin stdout');
          if (stderr) console.error('[yt-dlp] stderr:', stderr);
          return resolve(null);
        }

        const candidatos = stdout
          .trim()
          .split('\n')
          .map((linea) => {
            const [url, title, author, duration] = linea.split('|||');
            return { url, title, author, duracion: parseFloat(duration) || Infinity };
          })
          .filter((c) => c.url);

        if (!candidatos.length) return resolve(null);

        // Si fue una búsqueda de texto, preferimos el candidato de duración
        // "normal" (1-10 min) para evitar videos extendidos con intros
        // largas (tipo "short films" de los 90) o clips demasiado cortos.
        let elegido = candidatos[0];
        if (!isUrl) {
          const normales = candidatos.filter((c) => c.duracion >= 60 && c.duracion <= 600);
          elegido = normales.length
            ? normales.reduce((a, b) => (a.duracion <= b.duracion ? a : b))
            : candidatos.reduce((a, b) => (a.duracion <= b.duracion ? a : b));
        }

        resolve({ url: elegido.url, title: elegido.title || query, author: elegido.author || 'YouTube' });
      },
    );
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.lavalink = new LavalinkManager({
  nodes: [
    {
      authorization: process.env.LAVALINK_PASSWORD,
      host: process.env.LAVALINK_HOST || 'localhost',
      port: Number(process.env.LAVALINK_PORT) || 2333,
      id: 'main-node',
      secure: false,
    },
  ],
  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  },
  autoSkip: true,
  client: {
    id: process.env.CLIENT_ID,
    username: 'DJ LIVI',
  },
  playerOptions: {
    defaultSearchPlatform: 'ytmsearch',
    onEmptyQueue: {
      destroyAfterMs: 2 * 60 * 60 * 1000, // se va del canal si queda 2 horas sin cola
    },
  },
});

// Reenviamos los eventos crudos del gateway a Lavalink (necesario para que
// sepa cuándo el bot se conectó/movió de canal de voz).
client.on('raw', (d) => client.lavalink.sendRawData(d));

// Guardamos, por servidor (guildId), si el DJ está activo o no.
const djEnabledByGuild = new Map();
function isDjEnabled(guildId) {
  return djEnabledByGuild.get(guildId) ?? true; // por defecto: activado
}

// Cuántas canciones le quedan de "silencio" al DJ en cada servidor antes de
// volver a hablar (variamos entre 2 y 4 para que no sea siempre igual).
const djSilencioRestante = new Map();

function debeHablarElDJ(guildId) {
  const restante = djSilencioRestante.get(guildId) ?? 0;
  if (restante <= 0) {
    djSilencioRestante.set(guildId, Math.floor(Math.random() * 3) + 2); // 2 a 4
    return true;
  }
  djSilencioRestante.set(guildId, restante - 1);
  return false;
}

/**
 * Arma el clip de audio del DJ (para una canción puntual o para presentar
 * una tanda/playlist) y devuelve el Track de Lavalink listo para encolar
 * (o null si ni el camino principal ni el de respaldo funcionaron).
 *
 * Camino principal: Claude arma la frase (con chistes internos y
 * dedicatorias si corresponde) + ElevenLabs la locuta con voz natural.
 * Respaldo silencioso: frase de plantilla fija + Flowery TTS (gratis).
 */
async function armarTrackDelDJ(player, requester, { tipo, datos }) {
  try {
    const frase =
      tipo === 'playlist' ? await djAI.generarIntroPlaylist(datos) : await djAI.generarFraseConIA(datos);
    const filepath = await elevenlabs.generarAudioElevenLabs(frase);
    const result = await player.search({ query: filepath, source: 'local' }, requester);
    if (result?.tracks?.length) return result.tracks[0];
    console.error('DJ con IA/ElevenLabs: Lavalink no devolvió tracks para el archivo local', filepath);
  } catch (err) {
    console.error('DJ con IA/ElevenLabs falló, uso el respaldo (Flowery):', err.message);
  }

  try {
    const textoRespaldo =
      tipo === 'playlist' ? dj.buildWelcomeText() : dj.buildIntroText({ title: datos.title, author: datos.author });
    const url = `https://api.flowery.pw/v1/tts?${new URLSearchParams({
      text: textoRespaldo,
      voice: FLOWERY_VOICE,
    })}`;
    const result = await player.search({ query: url }, requester);
    if (result?.tracks?.length) return result.tracks[0];
  } catch (err) {
    console.error('El respaldo del DJ (Flowery) también falló:', err);
  }
  return null;
}

// Prompts para comentarios espontáneos de Livi (sin canción específica).
const PROMPTS_ESPONTANEOS = [
  'Comentá brevemente el ambiente de la fiesta, algo sobre lo que viene, o tirá un dato curioso de música.',
  'Hacé un comentario corto sobre la noche, la energía del momento, o algo que se venga.',
  'Tirá un dato musical interesante o un comentario random sobre el ambiente.',
  'Decí algo breve sobre cómo va la noche o sobre los que están escuchando.',
];

/**
 * Genera y encola un comentario espontáneo de Livi en el canal de voz activo
 * de un servidor. Solo actúa si hay gente en el canal.
 */
async function comentarioEspontaneo(guildId) {
  if (!isDjEnabled(guildId)) return;
  const player = client.lavalink.getPlayer(guildId);
  if (!player?.connected) return;

  const canal = client.channels.cache.get(player.voiceChannelId);
  const hayGente = canal?.members?.filter((m) => !m.user.bot).size > 0;
  if (!hayGente) return;

  try {
    const promptBase = PROMPTS_ESPONTANEOS[Math.floor(Math.random() * PROMPTS_ESPONTANEOS.length)];
    const miembros = canal.members.filter((m) => !m.user.bot).map((m) => djAI.apodoDe(m.displayName));
    const mencionGente = miembros.length ? `Hay gente en el canal: ${miembros.join(', ')}.` : '';

    const frase = await djAI.llamarClaudeEspontaneo(promptBase, mencionGente);
    const filepath = await elevenlabs.generarAudioElevenLabs(frase);
    const result = await player.search({ query: filepath, source: 'local' }, client.user);
    if (result?.tracks?.length) {
      player.queue.add(result.tracks[0]);
    }
  } catch (err) {
    console.error('Error en comentario espontáneo:', err.message);
  }
}

/** Programa el próximo comentario espontáneo con un intervalo random. */
function programarComentarioEspontaneo(guildId) {
  const delay = COMENTARIO_ESPONTANEO_MIN_MS +
    Math.random() * (COMENTARIO_ESPONTANEO_MAX_MS - COMENTARIO_ESPONTANEO_MIN_MS);
  setTimeout(async () => {
    await comentarioEspontaneo(guildId);
    programarComentarioEspontaneo(guildId); // re-agenda para la próxima
  }, delay);
}

client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
  elevenlabs.limpiarArchivosViejos();
  client.lavalink.init({ id: client.user.id, username: client.user.username });
});

let lavalinkListo = false;

client.lavalink.nodeManager.on('connect', (node) => {
  console.log(`🎧 Conectado al nodo de Lavalink "${node.id}"`);
  lavalinkListo = true;
});

client.lavalink.nodeManager.on('error', (node, error) => {
  console.error(`❌ Error en el nodo de Lavalink "${node.id}":`, error.message);
});

client.on('messageCreate', async (message) => {
  // ── Detección de Betty Bot ──────────────────────────────────────────────────
  // Cuando Betty anuncia una canción nueva, Livi la detecta y comenta.
  if (
    message.author.bot &&
    BETTY_BOT_ID &&
    message.author.id === BETTY_BOT_ID &&
    message.embeds?.length > 0
  ) {
    const embed = message.embeds[0];
    const title = embed.title || embed.description;
    // Betty muestra artista en el campo "description" del embed cuando hay título separado,
    // o como segunda línea. Probamos ambas formas.
    const author = embed.description || embed.fields?.[0]?.value;

    if (title && isDjEnabled(message.guildId)) {
      // Sacamos quién pidió la canción del footer ("Requested by Nombre")
      const footerText = embed.footer?.text || '';
      const requesterMatch = footerText.match(/Requested by (.+)/i);
      const requesterRaw = requesterMatch?.[1] || null;

      const player = client.lavalink.getPlayer(message.guildId);
      const voiceChannel = player?.voiceChannelId
        ? client.channels.cache.get(player.voiceChannelId)
        : null;
      const miembrosRaw = voiceChannel?.members?.filter((m) => !m.user.bot).map((m) => m.displayName) || [];
      const miembrosCanal = miembrosRaw.map((n) => djAI.apodoDe(n));
      const pabloPresente = miembrosRaw.some((n) => n.toLowerCase() === 'argamol (pablo i.)');

      // Solo comenta de vez en cuando (no cada canción, para no saturar)
      if (debeHablarElDJ(message.guildId)) {
        try {
          // Si Livi no está en un canal de voz todavía, se une al canal donde está la gente
          let liviPlayer = player;
          if (!liviPlayer?.connected) {
            // Busca el canal de voz donde hay miembros
            const guild = message.guild;
            const canalVoz = guild.channels.cache.find(
              (c) => c.isVoiceBased?.() && c.members?.filter((m) => !m.user.bot).size > 0
            );
            if (canalVoz) {
              liviPlayer = client.lavalink.createPlayer({
                guildId: message.guildId,
                voiceChannelId: canalVoz.id,
                textChannelId: message.channel.id,
                selfDeaf: true,
              });
              await liviPlayer.connect();

              // Saludo inicial al conectarse
              try {
                const miembrosCanal = canalVoz.members
                  .filter((m) => !m.user.bot)
                  .map((m) => djAI.apodoDe(m.displayName));
                const saludoFrase = await djAI.generarSaludo(miembrosCanal);
                const saludoFile = await elevenlabs.generarAudioElevenLabs(saludoFrase);
                const saludoResult = await liviPlayer.search({ query: saludoFile, source: 'local' }, client.user);
                if (saludoResult?.tracks?.length) {
                  liviPlayer.queue.add(saludoResult.tracks[0]);
                  if (!liviPlayer.playing && !liviPlayer.paused) await liviPlayer.play();
                }
              } catch (err) {
                console.error('Error en saludo inicial:', err.message);
              }

              // Arrancar timer de comentarios espontáneos para este servidor
              programarComentarioEspontaneo(message.guildId);
            }
          }

          if (liviPlayer?.connected) {
            const djTrack = await armarTrackDelDJ(liviPlayer, client.user, {
              tipo: 'cancion',
              datos: { title: cleanTitle(title), author, miembrosCanal, pabloPresente },
            });
            if (djTrack) {
              liviPlayer.queue.add(djTrack);
              if (!liviPlayer.playing && !liviPlayer.paused) await liviPlayer.play();
            }
          }
        } catch (err) {
          console.error('Error comentando canción de Betty:', err.message);
        }
      }
    }
    return; // no procesar como comando
  }

  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  if (!lavalinkListo) {
    return message.reply('⏳ Dame un segundo, me estoy terminando de conectar. Probá de nuevo en unos segundos.');
  }

  try {
    if (command === 'play' || command === 'p') {
      const query = args.join(' ');
      if (!query) return message.reply('Decime qué querés escuchar. Ej: `!play nombre de la canción`, un link de YouTube, o un link de Spotify.');
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) return message.reply('Primero conectate a un canal de voz.');

      let player = client.lavalink.getPlayer(guildId);
      if (!player) {
        player = client.lavalink.createPlayer({
          guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: message.channel.id,
          selfDeaf: true,
        });
      }
      if (!player.connected) await player.connect();

      const isUrl = /^https?:\/\//i.test(query);

      // Con OAuth + remoteCipher configurados en Lavalink, ya no necesitamos
      // pasar por yt-dlp/cookies: dejamos que Lavalink resuelva todo directo,
      // tanto búsquedas de texto y links de YouTube como links de Spotify
      // (LavaSrc se encarga del espejo a YouTube por atrás).
      const result = await player.search({ query }, message.author);
      if (!result || !result.tracks?.length) {
        return message.reply('No encontré ningún resultado para eso.');
      }

      const isPlaylist = !!result.playlist;
      const tracksToQueue = isPlaylist ? result.tracks.slice(0, 25) : [result.tracks[0]];

      // Si fue una búsqueda de texto (no un link), usamos lo que el usuario
      // escribió como título — es más prolijo que el título crudo del video
      // que encontramos, que puede traer basura tipo "(Video Oficial)".
      if (!isPlaylist && !isUrl) {
        tracksToQueue[0].info.title = query.replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const miembrosRaw = voiceChannel.members
        .filter((m) => !m.user.bot)
        .map((m) => m.displayName);
      const miembrosCanal = miembrosRaw.map((n) => djAI.apodoDe(n));
      const pabloPresente = miembrosRaw.some((n) => n.toLowerCase() === 'argamol (pablo i.)');

      const itemsParaEncolar = [];
      for (let i = 0; i < tracksToQueue.length; i++) {
        const track = tracksToQueue[i];
        if (isDjEnabled(guildId) && debeHablarElDJ(guildId)) {
          const esInicioDePlaylist = isPlaylist && i === 0;
          const djTrack = await armarTrackDelDJ(player, message.author, {
            tipo: esInicioDePlaylist ? 'playlist' : 'cancion',
            datos: esInicioDePlaylist
              ? {
                  titulos: tracksToQueue.slice(0, 8).map((t) => `${cleanTitle(t.info.title)} - ${t.info.author}`),
                  miembrosCanal,
                }
              : {
                  title: cleanTitle(track.info.title),
                  author: track.info.author,
                  miembrosCanal,
                  pabloPresente,
                },
          });
          if (djTrack) itemsParaEncolar.push(djTrack);
        }
        itemsParaEncolar.push(track);
      }

      player.queue.add(itemsParaEncolar);
      message.reply(
        tracksToQueue.length > 1
          ? `✅ Agregados **${tracksToQueue.length}** temas a la cola.`
          : `✅ Agregado a la cola: **${cleanTitle(tracksToQueue[0].info.title)}**`,
      );

      if (!player.playing && !player.paused) await player.play();
    }

    else if (command === 'skip') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player) return message.reply('No hay nada sonando.');
      await player.skip();
      message.reply('⏭️ Siguiente tema.');
    }

    else if (command === 'stop') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player) return message.reply('No hay nada sonando.');
      await player.destroy();
      message.reply('⏹️ Corté la música y me fui del canal.');
    }

    else if (command === 'pause') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player) return message.reply('No hay nada sonando.');
      await player.pause();
      message.reply('⏸️ Pausado.');
    }

    else if (command === 'resume') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player) return message.reply('No hay nada sonando.');
      await player.resume();
      message.reply('▶️ Reanudado.');
    }

    else if (command === 'volume' || command === 'vol') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player) return message.reply('No hay nada sonando.');
      const vol = parseInt(args[0], 10);
      if (isNaN(vol)) return message.reply('Usá `!volume 50` (0-100).');
      await player.setVolume(vol);
      message.reply(`🔊 Volumen: ${vol}%`);
    }

    else if (command === 'queue' || command === 'q') {
      const player = client.lavalink.getPlayer(guildId);
      if (!player || (!player.queue.current && !player.queue.tracks.length)) {
        return message.reply('No hay nada en la cola.');
      }
      const lines = [];
      if (player.queue.current) lines.push(`▶️ ${player.queue.current.info.title}`);
      player.queue.tracks.slice(0, 14).forEach((t, i) => lines.push(`${i + 1}. ${t.info.title}`));
      const embed = new EmbedBuilder()
        .setTitle('Cola de reproducción')
        .setDescription(lines.join('\n'))
        .setColor(0x1db954);
      message.reply({ embeds: [embed] });
    }

    else if (command === 'pregunta' || command === 'preguntar') {
      const texto = args.join(' ');
      if (!texto) return message.reply('Preguntame algo, ej: `!pregunta qué onda con esta fiesta`');

      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) return message.reply('Primero conectate a un canal de voz.');

      let player = client.lavalink.getPlayer(guildId);
      if (!player) {
        player = client.lavalink.createPlayer({
          guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: message.channel.id,
          selfDeaf: true,
        });
      }
      if (!player.connected) await player.connect();

      try {
        const respuesta = await djAI.responderPregunta(texto);
        const filepath = await elevenlabs.generarAudioElevenLabs(respuesta);
        const result = await player.search({ query: filepath, source: 'local' }, message.author);
        if (result?.tracks?.length) {
          player.queue.add(result.tracks[0], 0);
          message.reply('🎙️ Ahí te contesto, apenas termine lo que está sonando.');
          if (!player.playing && !player.paused) await player.play();
        } else {
          message.reply('❌ No pude generar la respuesta.');
        }
      } catch (err) {
        console.error('Error respondiendo la pregunta:', err);
        message.reply('❌ Algo falló al responder.');
      }
    }

    else if (command === 'dj') {
      const mode = args[0]?.toLowerCase();
      if (mode === 'on') {
        djEnabledByGuild.set(guildId, true);
        message.reply('🎙️ DJ activado: voy a anunciar cada canción.');
      } else if (mode === 'off') {
        djEnabledByGuild.set(guildId, false);
        message.reply('🔇 DJ desactivado.');
      } else {
        message.reply(`El DJ está ${isDjEnabled(guildId) ? 'activado' : 'desactivado'}. Usá \`!dj on\` o \`!dj off\`.`);
      }
    }
  } catch (err) {
    console.error(err);
    message.reply('❌ Algo falló. Revisá la consola del bot.');
  }
});

// Guardamos qué servidores están en medio de un reintento silencioso, para
// no mandar el aviso de "se terminó la cola" en falso durante ese proceso.
const guildsReintentando = new Set();

client.lavalink.on('trackStart', (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  // No anunciamos los clips del propio DJ, ni los reintentos silenciosos
  // (solo el primer intento de cada canción real).
  if (track.info.sourceName === 'flowerytts' || track.info.sourceName === 'local') return;
  if (track.userData?.intento) return;
  channel?.send(`🎶 Sonando ahora: **${cleanTitle(track.info.title)}** — ${track.info.author}`);
});

client.lavalink.on('trackError', async (player, track, payload) => {
  const channel = client.channels.cache.get(player.textChannelId);
  console.error('Error de reproducción:', track?.info?.title, payload?.exception?.message || payload);

  guildsReintentando.add(player.guildId);
  const terminarReintento = () => guildsReintentando.delete(player.guildId);

  const yaProbadoYtMusic = track?.userData?.intento === 'ytmusic';
  const yaProbadoYtDlp = track?.userData?.intento === 'ytdlp';

  // Nivel 1.5: otra fuente dentro de YouTube (YouTube Music) buscando la
  // versión "lyrics" — suele ser un upload de fan (no del sello), full
  // length y sin las restricciones del video oficial.
  if (!yaProbadoYtMusic && !yaProbadoYtDlp) {
    try {
      const ytMusicResult = await player.search(
        { query: `ytmsearch:${track.info.title} ${track.info.author} lyrics` },
        track.requester,
      );
      if (ytMusicResult?.tracks?.length) {
        const fallbackTrack = ytMusicResult.tracks[0];
        fallbackTrack.userData = { ...fallbackTrack.userData, intento: 'ytmusic' };
        player.queue.add(fallbackTrack, 0);
        if (!player.playing) await player.play();
        terminarReintento();
        return;
      }
    } catch (err) {
      console.error('Error en el respaldo de YouTube Music:', err);
    }
  }

  // Nivel 2, último recurso: yt-dlp + cookies, también con "lyrics" sumado
  // a la búsqueda (silencioso, sin avisar en el chat).
  if (!yaProbadoYtDlp) {
    try {
      const resolved = await resolveWithYtDlp(`${track.info.title} ${track.info.author} lyrics`);
      if (resolved) {
        const ytDlpResult = await player.search({ query: resolved.url }, track.requester);
        if (ytDlpResult?.tracks?.length) {
          const fallbackTrack = ytDlpResult.tracks[0];
          fallbackTrack.info.title = resolved.title;
          fallbackTrack.info.author = resolved.author;
          fallbackTrack.userData = { ...fallbackTrack.userData, intento: 'ytdlp' };
          player.queue.add(fallbackTrack, 0);
          if (!player.playing) await player.play();
          terminarReintento();
          return;
        }
      }
    } catch (err) {
      console.error('Error en el respaldo de yt-dlp:', err);
    }
  }

  terminarReintento();
  channel?.send(`❌ No pude reproducir **${cleanTitle(track?.info?.title) || 'ese tema'}** por ningún medio. Probá con otra búsqueda.`);
});

client.lavalink.on('trackStuck', (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send(`⚠️ **${track?.info?.title || 'El tema'}** se trabó, lo salteo.`);
});

const ultimoQueueEndEnviado = new Map(); // guildId -> timestamp

client.lavalink.on('queueEnd', (player) => {
  if (guildsReintentando.has(player.guildId)) return; // falso positivo, hay un reintento en curso
  const ahora = Date.now();
  const ultimo = ultimoQueueEndEnviado.get(player.guildId) ?? 0;
  if (ahora - ultimo < 5000) return; // evita avisos duplicados muy seguidos
  ultimoQueueEndEnviado.set(player.guildId, ahora);

  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('🏁 Se terminó la cola.');
});

client.lavalink.on('playerDisconnect', (player) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('👋 Me desconecté del canal de voz.');
});

// Reaccionamos, a veces (no siempre), cuando alguien entra o sale del canal
// de voz donde está tocando el bot. Se encola para sonar apenas termine el
// tema actual, sin interrumpir nada.
const PROBABILIDAD_REACCION_CANAL = 0.35;
const ultimaReaccionCanal = new Map(); // guildId -> timestamp, para no saturar

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId || !isDjEnabled(guildId)) return;

  const player = client.lavalink.getPlayer(guildId);
  if (!player) return; // el bot no está conectado a nada en este server

  const canalDelBot = player.voiceChannelId;
  const seUnio = !oldState.channelId && newState.channelId === canalDelBot;
  const seFue = oldState.channelId === canalDelBot && newState.channelId !== canalDelBot;
  if (!seUnio && !seFue) return;

  const miembro = seUnio ? newState.member : oldState.member;
  if (!miembro || miembro.user.bot) return;

  const ultima = ultimaReaccionCanal.get(guildId) ?? 0;
  if (Date.now() - ultima < 60_000) return; // no más de una reacción por minuto
  if (Math.random() > PROBABILIDAD_REACCION_CANAL) return; // no siempre reacciona

  ultimaReaccionCanal.set(guildId, Date.now());

  try {
    const persona = djAI.apodoDe(miembro.displayName);
    const frase = await djAI.generarReaccionCanal({ persona, evento: seUnio ? 'entro' : 'se_fue' });
    const filepath = await elevenlabs.generarAudioElevenLabs(frase);
    const result = await player.search({ query: filepath, source: 'local' }, client.user);
    if (result?.tracks?.length) {
      player.queue.add(result.tracks[0], 0);
    }
  } catch (err) {
    console.error('Error generando la reacción de canal:', err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
