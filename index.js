// index.js
// Bot de música para Discord con locutor DJ (TTS) estilo Spotify AI DJ.

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YouTubePlugin } = require('@distube/youtube');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const fs = require('fs');
const dj = require('./dj');

const PREFIX = process.env.PREFIX || '!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const distube = new DisTube(client, {
  plugins: [new SpotifyPlugin(), new YouTubePlugin()],
  emitNewSongOnly: true,
});

// Guardamos, por servidor (guildId), si el DJ está activo o no.
const djEnabledByGuild = new Map();
function isDjEnabled(guildId) {
  return djEnabledByGuild.get(guildId) ?? true; // por defecto: activado
}

/**
 * Reproduce un clip de TTS interrumpiendo momentáneamente la canción actual.
 * Truco: DisTube mantiene su propia conexión de voz en `queue.voice`. Le
 * "robamos" la suscripción para meter el audio del DJ y se la devolvemos
 * cuando termina de hablar.
 */
function playTtsOverQueue(queue, filepath) {
  return new Promise((resolve) => {
    const connection = queue.voice.connection;
    const originalPlayer = queue.voice.audioPlayer;

    const ttsPlayer = createAudioPlayer();
    const resource = createAudioResource(filepath, {
      inputType: StreamType.Arbitrary,
    });

    connection.subscribe(ttsPlayer);
    ttsPlayer.play(resource);

    ttsPlayer.on(AudioPlayerStatus.Idle, () => {
      // Devolvemos la conexión a DisTube para que siga con la canción.
      connection.subscribe(originalPlayer);
      fs.unlink(filepath, () => {});
      resolve();
    });

    ttsPlayer.on('error', () => {
      connection.subscribe(originalPlayer);
      resolve();
    });
  });
}

client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
  dj.cleanupOldFiles();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  try {
    if (command === 'play' || command === 'p') {
      const query = args.join(' ');
      if (!query) return message.reply('Decime qué querés escuchar. Ej: `!play nombre de la canción` o un link de Spotify/YouTube.');
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) return message.reply('Primero conectate a un canal de voz.');

      distube.play(voiceChannel, query, {
        textChannel: message.channel,
        member: message.member,
      });
    }

    else if (command === 'skip') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada sonando.');
      await queue.skip();
      message.reply('⏭️ Siguiente tema.');
    }

    else if (command === 'stop') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada sonando.');
      queue.stop();
      message.reply('⏹️ Corté la música.');
    }

    else if (command === 'pause') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada sonando.');
      queue.pause();
      message.reply('⏸️ Pausado.');
    }

    else if (command === 'resume') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada sonando.');
      queue.resume();
      message.reply('▶️ Reanudado.');
    }

    else if (command === 'volume' || command === 'vol') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada sonando.');
      const vol = parseInt(args[0], 10);
      if (isNaN(vol)) return message.reply('Usá `!volume 50` (0-100).');
      queue.setVolume(vol);
      message.reply(`🔊 Volumen: ${vol}%`);
    }

    else if (command === 'queue' || command === 'q') {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('No hay nada en la cola.');
      const list = queue.songs
        .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.name} — ${s.formattedDuration}`)
        .slice(0, 15)
        .join('\n');
      const embed = new EmbedBuilder().setTitle('Cola de reproducción').setDescription(list).setColor(0x1db954);
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

// Cada vez que arranca una canción nueva, si el DJ está activo, la anunciamos.
distube.on('playSong', async (queue, song) => {
  if (!isDjEnabled(queue.textChannel?.guildId)) return;

  try {
    queue.pause();
    const text = dj.buildIntroText(song);
    const filepath = await dj.generateTTS(text);
    await playTtsOverQueue(queue, filepath);
    queue.resume();
  } catch (err) {
    console.error('Error en el anuncio del DJ:', err);
    if (queue.paused) queue.resume();
  }
});

distube.on('addSong', (queue, song) => {
  queue.textChannel?.send(`✅ Agregado a la cola: **${song.name}** — ${song.formattedDuration}`);
});

distube.on('error', (error, queue) => {
  console.error(error);
  queue?.textChannel?.send('❌ Ocurrió un error con la reproducción.');
});

distube.on('finish', (queue) => {
  queue.textChannel?.send('🏁 Se terminó la cola.');
});

distube.on('disconnect', (queue) => {
  queue.textChannel?.send('👋 Me desconecté del canal de voz.');
});

client.login(process.env.DISCORD_TOKEN);
