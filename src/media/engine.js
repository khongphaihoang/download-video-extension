/*
 * Media classification shared by the isolated content pipeline.
 * Download implementations can be added without changing social modules.
 */
(() => {
  'use strict';

  function classify(url, hint) {
    if (hint === 'yt-adaptive') return 'yt-adaptive';
    if (typeof url !== 'string') return null;
    if (/\.m3u8(?:\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(?:\?|#|$)/i.test(url)) return 'dash';
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('bytestart') || parsed.searchParams.has('byteend')) return 'segment';
      if (/\.(?:ts|m4s)(?:\?|#|$)/i.test(parsed.pathname)) return 'segment';
    } catch { /* ignore malformed URLs */ }
    return 'file';
  }

  function isDownloadable(kind) {
    return kind === 'file' || kind === 'yt-adaptive';
  }

  const ENGINES = {
    file: { resolve: (candidate) => candidate },
    hls: { resolve: (candidate) => candidate },
    dash: { resolve: (candidate) => candidate },
    'yt-adaptive': { resolve: (candidate) => candidate },
  };

  function resolve(candidate) {
    const engine = ENGINES[candidate && candidate.kind];
    return engine ? engine.resolve(candidate) : null;
  }

  window.__VG_MEDIA_ENGINE__ = { classify, isDownloadable, resolve, ENGINES };
})();
