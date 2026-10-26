// Video Upload Manager (Direct / Sans Connexion Requise)

let selectedCapturedThumbnailBlob = null;
let customThumbnailFile = null;
window._compressedCustomThumbnailBase64 = null;
window._videoSnapshotsList = [];

function compressImageToDataUrl(file, maxWidth = 1280, maxHeight = 720, quality = 0.82) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function previewVideoFile(input) {
  const file = input.files[0];
  if (!file) return;

  const dropPrompt = document.getElementById('videoDropPrompt');
  const previewDiv = document.getElementById('videoFilePreview');
  const player = document.getElementById('previewPlayer');

  const fileUrl = URL.createObjectURL(file);
  player.src = fileUrl;

  dropPrompt.classList.add('hidden');
  previewDiv.classList.remove('hidden');

  // Generate automated frame captures from the video
  generateVideoThumbnails(file);
}

function removeVideoFile(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const input = document.getElementById('videoFileInput');
  if (input) input.value = '';

  const thumbInput = document.getElementById('thumbnailFileInput');
  if (thumbInput) thumbInput.value = '';

  const dropPrompt = document.getElementById('videoDropPrompt');
  const previewDiv = document.getElementById('videoFilePreview');
  const player = document.getElementById('previewPlayer');
  const snapshotsWrap = document.getElementById('thumbnailSnapshotsWrap');
  const snapshotsGrid = document.getElementById('thumbnailSnapshotsGrid');
  const nameDisplay = document.getElementById('customThumbNameDisplay');

  if (player) player.src = '';
  if (dropPrompt) dropPrompt.classList.remove('hidden');
  if (previewDiv) previewDiv.classList.add('hidden');
  if (snapshotsWrap) snapshotsWrap.classList.add('hidden');
  if (snapshotsGrid) snapshotsGrid.innerHTML = '';
  if (nameDisplay) {
    nameDisplay.textContent = 'Capture automatique par défaut';
    nameDisplay.style.color = 'var(--text-muted)';
  }

  selectedCapturedThumbnailBlob = null;
  customThumbnailFile = null;
  window._compressedCustomThumbnailBase64 = null;
  window._videoSnapshotsList = [];
}

// Extract 4 high-quality candidate frames from the video
async function generateVideoThumbnails(file) {
  const snapshotsWrap = document.getElementById('thumbnailSnapshotsWrap');
  const snapshotsGrid = document.getElementById('thumbnailSnapshotsGrid');
  if (!snapshotsWrap || !snapshotsGrid) return;

  snapshotsGrid.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:8px 0;grid-column:1/-1;">Génération des captures automatiques de la vidéo...</div>';
  snapshotsWrap.classList.remove('hidden');

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  const fileUrl = URL.createObjectURL(file);
  video.src = fileUrl;

  video.onloadeddata = async () => {
    const duration = video.duration || 10;
    const seekPoints = [0.15, 0.35, 0.60, 0.85];
    const snapshots = [];

    for (let i = 0; i < seekPoints.length; i++) {
      const time = Math.min(Math.max(duration * seekPoints[i], 0.2), Math.max(duration - 0.2, 0.5));
      try {
        const frameData = await captureFrameAtTime(video, time);
        if (frameData && frameData.dataUrl) {
          snapshots.push(frameData);
        }
      } catch (err) {
        console.warn('Frame capture error', err);
      }
    }

    if (snapshots.length === 0) {
      snapshotsWrap.classList.add('hidden');
      return;
    }

    snapshotsGrid.innerHTML = snapshots.map((s, idx) => `
      <div class="thumb-snap-item ${idx === 0 ? 'active' : ''}" onclick="selectThumbnailSnapshot(${idx})" id="snapItem-${idx}">
        <img src="${s.dataUrl}" alt="Miniature ${idx + 1}" class="thumb-snap-img">
        <span class="thumb-snap-badge">${idx === 0 ? 'Sélectionné' : 'Choisir'}</span>
      </div>
    `).join('');

    window._videoSnapshotsList = snapshots;
    selectedCapturedThumbnailBlob = snapshots[0].blob;

    const nameDisplay = document.getElementById('customThumbNameDisplay');
    if (nameDisplay) {
      nameDisplay.textContent = 'Capture n°1 sélectionnée par défaut';
      nameDisplay.style.color = 'var(--primary)';
    }
  };
}

function captureFrameAtTime(video, time) {
  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      resolve(null);
    }, 2500);

    const onSeeked = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        canvas.toBlob((blob) => {
          resolve({ dataUrl, blob });
        }, 'image/jpeg', 0.85);
      } catch (e) {
        reject(e);
      }
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

function selectThumbnailSnapshot(idx) {
  if (!window._videoSnapshotsList || !window._videoSnapshotsList[idx]) return;
  selectedCapturedThumbnailBlob = window._videoSnapshotsList[idx].blob;
  customThumbnailFile = null;

  const thumbFileInput = document.getElementById('thumbnailFileInput');
  if (thumbFileInput) thumbFileInput.value = '';

  document.querySelectorAll('.thumb-snap-item').forEach((el, i) => {
    if (i === idx) {
      el.classList.add('active');
      el.querySelector('.thumb-snap-badge').textContent = 'Sélectionné';
    } else {
      el.classList.remove('active');
      el.querySelector('.thumb-snap-badge').textContent = 'Choisir';
    }
  });

  const nameDisplay = document.getElementById('customThumbNameDisplay');
  if (nameDisplay) {
    nameDisplay.textContent = `Capture n°${idx + 1} sélectionnée`;
    nameDisplay.style.color = 'var(--primary)';
  }
}

async function handleCustomThumbnailPick(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  customThumbnailFile = file;
  selectedCapturedThumbnailBlob = null;

  const nameDisplay = document.getElementById('customThumbNameDisplay');
  if (nameDisplay) {
    nameDisplay.textContent = 'Optimisation de la miniature...';
    nameDisplay.style.color = 'var(--primary)';
  }

  const compressed = await compressImageToDataUrl(file, 1280, 720, 0.82);
  window._compressedCustomThumbnailBase64 = compressed;

  document.querySelectorAll('.thumb-snap-item').forEach(el => {
    el.classList.remove('active');
    el.querySelector('.thumb-snap-badge').textContent = 'Choisir';
  });

  if (nameDisplay) {
    nameDisplay.textContent = `Image personnalisee : ${file.name}`;
    nameDisplay.style.color = '#10b981';
  }
}

async function handleVideoUpload(e) {
  e.preventDefault();

  const emailInput = document.getElementById('uploaderEmail');
  const regionInput = document.getElementById('uploaderRegion');
  const titleInput = document.getElementById('videoTitle');
  const descInput = document.getElementById('videoDesc');
  const videoFileInput = document.getElementById('videoFileInput');
  const thumbFileInput = document.getElementById('thumbnailFileInput');

  const email = (emailInput ? emailInput.value.trim() : '');
  const region = (regionInput ? regionInput.value : 'Île-de-France');
  const title = (titleInput ? titleInput.value.trim() : '');
  const description = (descInput ? descInput.value.trim() : '');

  if (!videoFileInput || !videoFileInput.files[0]) {
    showToast('Veuillez sélectionner un fichier vidéo.');
    return;
  }

  if (!email) {
    showToast('Veuillez renseigner votre adresse e-mail.');
    if (emailInput) emailInput.focus();
    return;
  }

  if (!description) {
    showToast('Veuillez ajouter une description.');
    if (descInput) descInput.focus();
    return;
  }

  const cguCheckbox = document.getElementById('cguAgreementCheckbox');
  if (cguCheckbox && !cguCheckbox.checked) {
    showToast('Vous devez certifier être propriétaire des droits et accepter les CGU.');
    cguCheckbox.focus();
    return;
  }

  // Get selected categories from multi-select checkboxes
  const selectedCatCheckboxes = document.querySelectorAll('#uploadCategoriesMultiSelect input[type="checkbox"]:checked');
  let selectedCategories = Array.from(selectedCatCheckboxes).map(cb => cb.value);
  if (selectedCategories.length === 0) {
    selectedCategories = ['all'];
  }

  const btnSubmit = document.getElementById('btnSubmitVideo');
  const originalText = btnSubmit ? btnSubmit.innerHTML : 'Envoyer ma vidéo';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = 'Envoi en cours...';
  }

  const headers = {};
  if (AUTH && AUTH.token) {
    headers['Authorization'] = `Bearer ${AUTH.token}`;
  }

  // 1. Priorité Bunny Stream : Téléversement direct client -> Bunny CDN (contourne la limite 4.5 Mo de Vercel)
  try {
    const initRes = await fetch('/api/videos/bunny-init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify({ title: title || `Vidéo (${region})` })
    });

    if (initRes.ok) {
      const bunnyData = await initRes.json();
      if (bunnyData && bunnyData.uploadUrl && bunnyData.apiKey) {
        btnSubmit.innerHTML = 'Envoi vers Bunny Stream (0%)...';

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', bunnyData.uploadUrl, true);
          xhr.setRequestHeader('AccessKey', bunnyData.apiKey);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');

          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
              const pct = Math.round((ev.loaded / ev.total) * 100);
              btnSubmit.innerHTML = `Envoi vers Bunny Stream (${pct}%)...`;
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(xhr.response);
            } else {
              reject(new Error(`Échec du transfert Bunny (${xhr.status})`));
            }
          };

          xhr.onerror = () => reject(new Error('Erreur de connexion vers Bunny Stream.'));
          xhr.send(videoFileInput.files[0]);
        });

        btnSubmit.innerHTML = 'Finalisation de la publication...';

        // Extract thumbnail base64 if selected
        let customThumbnailBase64 = null;
        if (window._compressedCustomThumbnailBase64) {
          customThumbnailBase64 = window._compressedCustomThumbnailBase64;
        } else if (selectedCapturedThumbnailBlob) {
          customThumbnailBase64 = await new Promise(r => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result);
            reader.readAsDataURL(selectedCapturedThumbnailBlob);
          });
        } else if (thumbFileInput && thumbFileInput.files && thumbFileInput.files[0]) {
          customThumbnailBase64 = await compressImageToDataUrl(thumbFileInput.files[0], 1280, 720, 0.82);
        }

        const completeRes = await fetch('/api/videos/bunny-complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers
          },
          body: JSON.stringify({
            videoId: bunnyData.videoId,
            title: title || `Video (${region})`,
            description,
            email,
            uploaderEmail: email,
            region,
            uploaderRegion: region,
            category: selectedCategories[0],
            categories: selectedCategories,
            customThumbnailBase64,
            directPlayUrl: bunnyData.directPlayUrl,
            iframeUrl: bunnyData.iframeUrl,
            thumbnailUrl: bunnyData.thumbnailUrl,
            previewAnimationUrl: bunnyData.previewAnimationUrl
          })
        });

        const completeData = await completeRes.json();
        if (!completeRes.ok) {
          showToast(completeData.error || 'Erreur lors de la finalisation');
          if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = originalText;
          }
          return;
        }

        showToast(completeData.message || 'Votre video a bien ete mise en ligne et publiee sur le site !');
        document.getElementById('uploadForm').reset();
        window._compressedCustomThumbnailBase64 = null;
        if (typeof autoFillUserCredentials === 'function') autoFillUserCredentials();
        removeVideoFile(e);
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerHTML = originalText;
        }
        await loadVideos();
        if (typeof loadExplorerData === 'function') loadExplorerData();
        switchTab('accueil');
        return;
      }
    }
  } catch (bunnyErr) {
    console.warn('Téléversement direct Bunny indisponible, tentative de secours...', bunnyErr);
  }

  const formData = new FormData();
  formData.append('videoFile', videoFileInput.files[0]);

  // Thumbnail priority: 1) Custom file uploaded by user, 2) Automatic frame captured from video
  if (thumbFileInput && thumbFileInput.files && thumbFileInput.files[0]) {
    formData.append('thumbnailFile', thumbFileInput.files[0]);
  } else if (selectedCapturedThumbnailBlob) {
    formData.append('thumbnailFile', selectedCapturedThumbnailBlob, 'thumbnail.jpg');
  }

  formData.append('email', email);
  formData.append('uploaderEmail', email);
  formData.append('region', region);
  formData.append('uploaderRegion', region);
  formData.append('title', title || `Vidéo (${region})`);
  formData.append('description', description);
  formData.append('category', selectedCategories[0]);
  formData.append('categories', JSON.stringify(selectedCategories));

  try {
    const res = await fetch('/api/videos/upload', {
      method: 'POST',
      headers: headers,
      body: formData
    });

    const resText = await res.text();
    let data = {};
    try {
      data = JSON.parse(resText);
    } catch (parseErr) {
      if (res.status === 413) {
        showToast('Fichier trop lourd : La taille limite est dépassée. Compressez la vidéo avant envoi.');
        return;
      }
      showToast(`Erreur (${res.status}) lors de l'envoi de la vidéo.`);
      return;
    }

    if (!res.ok) {
      showToast(data.error || 'Erreur lors de l\'envoi');
      return;
    }

    showToast(data.message || 'Votre vidéo a bien été reçue.');
    
    // Reset form
    document.getElementById('uploadForm').reset();
    if (typeof autoFillUserCredentials === 'function') autoFillUserCredentials();
    removeVideoFile(e);

    // Refresh video feed & explorer
    await loadVideos();
    if (typeof loadExplorerData === 'function') loadExplorerData();
    switchTab('accueil');
  } catch (err) {
    console.error(err);
    showToast('Erreur de transmission : Vérifiez votre connexion.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalText;
    }
  }
}

