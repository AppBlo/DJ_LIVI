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
    const target = isUrl ? query : `ytsearch1:${query}`;

    execFile(
      'yt-dlp',
      [
        target,
        '-f', 'bestaudio',
        '--no-playlist',
        '--cookies', require('path').join(__dirname, 'cookies.txt'),
        '--print', '%(url)s|||%(title)s|||%(uploader)s',
      ],
      { timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout?.trim()) {
          console.error('[yt-dlp] Error:', err?.message || 'sin stdout');
          if (stderr) console.error('[yt-dlp] stderr:', stderr);
          return resolve(null);
        }
        const [url, title, author] = stdout.trim().split('|||');
        if (!url) return resolve(null);
        resolve({ url, title: title || query, author: author || 'YouTube' });
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
    defaultSearchPlatform: 'ytsearch',
    onEmptyQueue: {
      destroyAfterMs: 5 * 60 * 1000, // se va del canal si queda solo 5 min
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

/**
 * Arma y encola el anuncio del DJ para el track dado.
 *
 * Camino principal: Claude arma una frase acorde a la onda real de la
 * canción (con una etiqueta de emoción), y ElevenLabs la locuta con una voz
 * natural. Si cualquiera de los dos pasos falla (créditos agotados, error de
 * red, etc.), caemos en silencio al camino de respaldo: una frase fija de
 * plantilla, locutada con Flowery TTS (gratis, siempre disponible).
 */
async function queueDjIntro(player, track, requester) {
  try {
    const frase = await djAI.generarFraseConIA({ title: cleanTitle(track.title), author: track.author });
    const filepath = await elevenlabs.generarAudioElevenLabs(frase);
    const result = await player.search({ query: filepath, source: 'local' }, requester);
    if (result?.tracks?.length) {
      player.queue.add(result.tracks[0]);
      return;
    }
    console.error('DJ con IA/ElevenLabs: Lavalink no devolvió tracks para el archivo local', filepath, JSON.stringify(result));
  } catch (err) {
    console.error('DJ con IA/ElevenLabs falló, uso el respaldo (Flowery):', err.message);
  }

  try {
    const textoRespaldo = dj.buildIntroText({ title: cleanTitle(track.title), author: track.author });
    const url = `https://api.flowery.pw/v1/tts?${new URLSearchParams({
      text: textoRespaldo,
      voice: FLOWERY_VOICE,
    })}`;
    const result = await player.search({ query: url }, requester);
    if (result?.tracks?.length) {
      player.queue.add(result.tracks[0]);
    }
  } catch (err) {
    console.error('El respaldo del DJ (Flowery) también falló:', err);
  }
}

client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
  elevenlabs.limpiarArchivosViejos();
  client.lavalink.init({ id: client.user.id, username: client.user.username });
});

client.lavalink.nodeManager.on('connect', (node) => {
  console.log(`🎧 Conectado al nodo de Lavalink "${node.id}"`);
});

client.lavalink.nodeManager.on('error', (node, error) => {
  console.error(`❌ Error en el nodo de Lavalink "${node.id}":`, error.message);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

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

      if (isDjEnabled(guildId)) {
        await queueDjIntro(player, tracksToQueue[0].info, message.author);
      }

      player.queue.add(tracksToQueue);
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
  const yaProbadoSoundcloud = track?.userData?.intento === 'soundcloud';

  // Nivel 1.5: otra fuente dentro de YouTube (YouTube Music), por si el
  // video puntual que encontró está bloqueado pero el mismo tema en YT Music no.
  if (!yaProbadoYtMusic && !yaProbadoYtDlp && !yaProbadoSoundcloud) {
    try {
      const ytMusicResult = await player.search(
        { query: `ytmsearch:${track.info.title} ${track.info.author}` },
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

  // Nivel 2: yt-dlp + cookies (silencioso, sin avisar en el chat).
  if (!yaProbadoYtDlp && !yaProbadoSoundcloud) {
    try {
      const resolved = await resolveWithYtDlp(`${track.info.title} ${track.info.author}`);
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

  // Nivel 3, último recurso: SoundCloud (silencioso también).
  if (!yaProbadoSoundcloud) {
    try {
      const fallbackResult = await player.search(
        { query: `scsearch:${track.info.title} ${track.info.author}` },
        track.requester,
      );
      if (fallbackResult?.tracks?.length) {
        const fallbackTrack = fallbackResult.tracks[0];
        fallbackTrack.userData = { ...fallbackTrack.userData, intento: 'soundcloud' };
        player.queue.add(fallbackTrack, 0);
        if (!player.playing) await player.play();
        terminarReintento();
        return;
      }
    } catch (err) {
      console.error('Error en el respaldo de SoundCloud:', err);
    }
  }

  terminarReintento();
  channel?.send(`❌ No pude reproducir **${cleanTitle(track?.info?.title) || 'ese tema'}** por ningún medio. Probá con otra búsqueda.`);
});

client.lavalink.on('trackStuck', (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send(`⚠️ **${track?.info?.title || 'El tema'}** se trabó, lo salteo.`);
});

client.lavalink.on('queueEnd', (player) => {
  if (guildsReintentando.has(player.guildId)) return; // falso positivo, hay un reintento en curso
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('🏁 Se terminó la cola.');
});

client.lavalink.on('playerDisconnect', (player) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('👋 Me desconecté del canal de voz.');
});

client.login(process.env.DISCORD_TOKEN);
