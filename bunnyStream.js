const fs = require('fs');

const libraryId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
const apiKey = (process.env.BUNNY_STREAM_API_KEY || '').trim();
const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();

function isBunnyConfigured() {
  return Boolean(libraryId && apiKey);
}

/**
 * Crée et téléverse une vidéo sur Bunny Stream.
 * Gère automatiquement le transcodage multi-qualités (4K, 1080p, 720p, 480p) et la génération de miniature.
 * @param {string} localFilePath - Chemin local du fichier vidéo
 * @param {string} title - Titre de la vidéo
 * @returns {Promise<{videoId: string, isBunny: boolean, directPlayUrl: string, iframeUrl: string, thumbnailUrl: string, previewAnimationUrl: string}|null>}
 */
async function uploadToBunnyStream(localFilePath, title) {
  if (!isBunnyConfigured()) return null;

  try {
    if (!fs.existsSync(localFilePath)) {
      console.error('[Bunny Stream] Fichier local introuvable:', localFilePath);
      return null;
    }

    // 1. Création de l'entrée vidéo dans la bibliothèque Bunny Stream
    const createRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
      method: 'POST',
      headers: {
        'AccessKey': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        title: title || 'Vidéo ' + new Date().toISOString()
      })
    });

    if (!createRes.ok) {
      const errTxt = await createRes.text();
      console.error('[Bunny Stream] Échec création entrée vidéo:', createRes.status, errTxt);
      return null;
    }

    const videoData = await createRes.json();
    const videoGuid = videoData.guid;

    // 2. Téléversement du binaire vidéo vers Bunny Stream
    const fileBuffer = fs.readFileSync(localFilePath);

    const uploadRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${videoGuid}`, {
      method: 'PUT',
      headers: {
        'AccessKey': apiKey,
        'Content-Type': 'application/octet-stream'
      },
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      const uploadErrTxt = await uploadRes.text();
      console.error('[Bunny Stream] Échec téléversement fichier:', uploadRes.status, uploadErrTxt);
      return null;
    }

    const hlsHost = customCdn || `vz-${libraryId}.b-cdn.net`;

    return {
      videoId: videoGuid,
      isBunny: true,
      directPlayUrl: `https://${hlsHost}/${videoGuid}/playlist.m3u8`,
      iframeUrl: `https://iframe.mediadelivery.net/embed/${libraryId}/${videoGuid}?autoplay=false&preload=true`,
      thumbnailUrl: `https://${hlsHost}/${videoGuid}/thumbnail.jpg`,
      previewAnimationUrl: `https://${hlsHost}/${videoGuid}/preview.webp`
    };
  } catch (err) {
    console.error('[Bunny Stream Erreur]:', err.message);
    return null;
  }
}

module.exports = {
  isBunnyConfigured,
  uploadToBunnyStream
};
