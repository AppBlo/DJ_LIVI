// index.js
// Bot de música para Discord usando Lavalink (en vez de DisTube) + locutor DJ
// con Flowery TTS (integrado en Lavalink vía el plugin LavaSrc).

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { execFile } = require('child_process');
const dj = require('./dj');

const PREFIX = process.env.PREFIX || '!';
const FLOWERY_VOICE = process.env.FLOWERY_VOICE || 'Sabela';

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
        '--print', '%(webpage_url)s|||%(title)s|||%(uploader)s',
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
 * Pide a Lavalink (vía Flowery TTS) el audio del texto dado, y lo agrega
 * a la cola justo antes del track real.
 *
 * Usamos el link HTTP directo de la API de Flowery (en vez del atajo
 * "ftts://") porque ese atajo rompe con texto que tiene espacios, comas o
 * paréntesis (bug conocido de cómo LavaSrc arma la URI internamente).
 */
async function queueDjIntro(player, text, requester) {
  const url = `https://api.flowery.pw/v1/tts?${new URLSearchParams({
    text,
    voice: FLOWERY_VOICE,
  })}`;

  const result = await player.search({ query: url }, requester);
  if (result?.tracks?.length) {
    player.queue.add(result.tracks[0]);
  }
}

client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
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
      if (!query) return message.reply('Decime qué querés escuchar. Ej: `!play nombre de la canción` o un link de YouTube.');
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

      const resolved = await resolveWithYtDlp(query);
      if (!resolved) {
        return message.reply('No encontré ningún resultado para eso (o YouTube lo está bloqueando).');
      }

      const result = await player.search({ query: resolved.url }, message.author);
      if (!result || !result.tracks?.length) {
        return message.reply('Encontré el tema pero Lavalink no pudo cargar el audio. Probá con otra búsqueda.');
      }

      const track = result.tracks[0];
      // Nos quedamos con el título/autor reales que sacó yt-dlp (más prolijo
      // que lo que a veces trae el link crudo).
      track.info.title = resolved.title;
      track.info.author = resolved.author;

      if (isDjEnabled(guildId)) {
        const introText = dj.buildIntroText(track.info);
        await queueDjIntro(player, introText, message.author);
      }

      player.queue.add(track);
      message.reply(`✅ Agregado a la cola: **${track.info.title}**`);

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

client.lavalink.on('trackStart', (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  // No anunciamos los clips del propio DJ (source flowery), solo canciones reales.
  if (track.info.sourceName !== 'flowerytts') {
    channel?.send(`🎶 Sonando ahora: **${track.info.title}** — ${track.info.author}`);
  }
});

client.lavalink.on('trackError', (player, track, payload) => {
  const channel = client.channels.cache.get(player.textChannelId);
  console.error('Error de reproducción:', payload?.exception?.message || payload);
  channel?.send(
    `❌ No pude reproducir **${track?.info?.title || 'ese tema'}** (posiblemente bloqueado por YouTube). Probá con otra búsqueda.`,
  );
});

client.lavalink.on('trackStuck', (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send(`⚠️ **${track?.info?.title || 'El tema'}** se trabó, lo salteo.`);
});

client.lavalink.on('queueEnd', (player) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('🏁 Se terminó la cola.');
});

client.lavalink.on('playerDisconnect', (player) => {
  const channel = client.channels.cache.get(player.textChannelId);
  channel?.send('👋 Me desconecté del canal de voz.');
});

client.login(process.env.DISCORD_TOKEN);
