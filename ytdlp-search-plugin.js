async searchSong(query, options) {
    let info;
    try {
      info = await ytDlpJson(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        skipDownload: true,
      });
    } catch (err) {
      console.error('[YtDlpSearchPlugin] Error buscando con yt-dlp:', err);
      return null;
    }

    const video = info?.entries?.length ? info.entries[0] : info;
    if (!video || !video.id) {
      console.error('[YtDlpSearchPlugin] yt-dlp no devolvió un video usable. Respuesta:', JSON.stringify(info)?.slice(0, 500));
      return null;
    }
