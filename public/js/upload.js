// Video Upload Manager (Direct / Sans Connexion Requise)

let selectedCapturedThumbnailBlob = null;
let customThumbnailFile = null;
window._videoSnapshotsList = [];

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

function handleCustomThumbnailPick(input) {
  if (!input.files || !input.files[0]) return;
  customThumbnailFile = input.files[0];
  selectedCapturedThumbnailBlob = null;

  document.querySelectorAll('.thumb-snap-item').forEach(el => {
    el.classList.remove('active');
    el.querySelector('.thumb-snap-badge').textContent = 'Choisir';
  });

  const nameDisplay = document.getElementById('customThumbNameDisplay');
  if (nameDisplay) {
    nameDisplay.textContent = `Image personnalisée : ${customThumbnailFile.name}`;
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

  const headers = {};
  if (AUTH && AUTH.token) {
    headers['Authorization'] = `Bearer ${AUTH.token}`;
  }

  try {
    const res = await fetch('/api/videos/upload', {
      method: 'POST',
      headers: headers,
      body: formData
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de l\'envoi');
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = originalText;
      }
      return;
    }

    showToast(data.message || 'Votre vidéo a bien été reçue.');
    
    // Reset form
    document.getElementById('uploadForm').reset();
    removeVideoFile(e);

    // Refresh video feed & explorer
    await loadVideos();
    if (typeof loadExplorerData === 'function') loadExplorerData();
    switchTab('accueil');
  } catch (err) {
    console.error(err);
    showToast('Erreur lors de l\'envoi au serveur.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalText;
    }
  }
}

