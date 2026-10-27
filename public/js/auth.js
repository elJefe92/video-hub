// Auth State Manager (Direct Local Authentication without Google)
const AUTH = {
  token: localStorage.getItem('francevideo_token') || null,
  user: null,

  async init() {
    if (this.token) {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (res.ok) {
          const data = await res.json();
          this.user = data.user;
          this.updateUi();
        } else {
          this.logout();
        }
      } catch (err) {
        console.error('Auth verification failed', err);
      }
    } else {
      const savedToken = localStorage.getItem('vh_pending_reg_token');
      const savedEmail = localStorage.getItem('vh_pending_reg_email');
      if (savedToken && savedEmail) {
        currentPendingRegistrationToken = savedToken;
        currentPendingEmail = savedEmail;
        const emailDisplay = document.getElementById('verifyOtpEmailDisplay');
        if (emailDisplay) emailDisplay.textContent = savedEmail;
      }
      this.updateUi();
    }
  },

  setAuth(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('francevideo_token', token);
    this.updateUi();
  },

  logout() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('francevideo_token');
    this.updateUi();
    showToast('Vous avez été déconnecté.');
    switchTab('accueil');
  },

  isLoggedIn() {
    return !!this.user;
  },

  isAdmin() {
    return !!(
      this.user &&
      ((this.user.email && this.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') ||
       this.user.role === 'admin' ||
       (this.user.username && this.user.username.toLowerCase() === 'administrateur'))
    );
  },

  isVip() {
    if (!this.user) return false;
    if (this.isAdmin()) return true;
    if (this.user.role === 'admin') return true;
    if (this.user.email && this.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') return true;
    if (this.user.username && this.user.username.toLowerCase() === 'administrateur') return true;
    return Boolean(this.user.isVip);
  },

  updateUi() {
    const authBtn = document.getElementById('headerAuthBtn');
    const authNotice = document.getElementById('uploadAuthNotice');
    const uploadForm = document.getElementById('uploadForm');
    const authView = document.getElementById('authView');
    const profileView = document.getElementById('profileView');
    const sideAdminItem = document.getElementById('sideAdminItem');
    const btnAdminAccess = document.getElementById('btnAdminAccess');

    if (this.user) {
      // Header status
      if (authBtn) {
        authBtn.innerHTML = `
          <img src="${this.user.avatar}" class="avatar-sm" style="border-radius:50%;width:24px;height:24px;object-fit:cover;">
          <span class="header-auth-label">${this.user.username} ${this.user.isVip ? '(VIP)' : ''}</span>
        `;
      }

      // Upload form is ALWAYS accessible to everyone without registration
      if (authNotice) authNotice.classList.add('hidden');
      if (uploadForm) {
        uploadForm.classList.remove('hidden');
      }

      // Auto-fill user credentials across all forms (Nous contacter, Déposer une vidéo, Signalement...)
      autoFillUserCredentials(this.user);

      // Admin button in sidebar & profile ONLY for ia.project.pro2k26@gmail.com
      if (this.isAdmin()) {
        if (sideAdminItem) sideAdminItem.classList.remove('hidden');
        if (btnAdminAccess) btnAdminAccess.classList.remove('hidden');
      } else {
        if (sideAdminItem) sideAdminItem.classList.add('hidden');
        if (btnAdminAccess) btnAdminAccess.classList.add('hidden');
      }

      // Profile tab
      if (authView) authView.classList.add('hidden');
      if (profileView) {
        profileView.classList.remove('hidden');
        document.getElementById('profileUsername').textContent = this.user.username;
        document.getElementById('profileEmail').textContent = this.user.email;
        document.getElementById('userAvatarImg').src = this.user.avatar;
        const bioEl = document.getElementById('profileBio');
        if (bioEl) bioEl.textContent = this.user.bio || 'Passionné par le partage de vidéos.';

        const vipCrown = document.getElementById('vipCrownBadge');
        const vipTag = document.getElementById('profileVipTag');
        const roleBadge = document.getElementById('profileRoleBadge');
        const btnUpgrade = document.getElementById('btnUpgradeProfileVip');

        if (this.isAdmin()) {
          if (roleBadge) roleBadge.classList.remove('hidden');
        } else {
          if (roleBadge) roleBadge.classList.add('hidden');
        }

        if (this.isVip()) {
          if (vipCrown) vipCrown.classList.remove('hidden');
          if (vipTag) vipTag.classList.remove('hidden');
          if (btnUpgrade) btnUpgrade.classList.add('hidden');
        } else {
          if (vipCrown) vipCrown.classList.add('hidden');
          if (vipTag) vipTag.classList.add('hidden');
          if (btnUpgrade) btnUpgrade.classList.remove('hidden');
        }

        // Account deletion button: completely forbidden and hidden for admin
        const btnDeleteAccount = document.getElementById('btnDeleteAccount');
        if (btnDeleteAccount) {
          if (this.isAdmin()) {
            btnDeleteAccount.classList.add('hidden');
            btnDeleteAccount.style.display = 'none';
          } else {
            btnDeleteAccount.classList.remove('hidden');
            btnDeleteAccount.style.display = '';
          }
        }

        // Load user videos, favorites and creator dashboard in profile
        loadMyVideos();
        if (typeof loadAndShowFavorites === 'function') loadAndShowFavorites();
        if (typeof loadCreatorDashboard === 'function') loadCreatorDashboard();
      }
    } else {
      // Logged out
      if (authBtn) {
        authBtn.innerHTML = `
          <span class="header-auth-label">Se connecter</span>
        `;
      }

      const adBanner = document.getElementById('adBannerFeed');
      if (adBanner) {
        const hasContent = !!adBanner.querySelector('img, a, iframe');
        if (this.isVip() || !hasContent) {
          adBanner.classList.add('hidden');
        } else {
          adBanner.classList.remove('hidden');
        }
      }

      if (authView) authView.classList.remove('hidden');
      if (profileView) profileView.classList.add('hidden');

      // Clear auto-filled credentials when disconnected
      clearAutoFilledCredentials();
    }

    // Sync sidebar logout/login buttons
    if (typeof updateSidebarAuthButtons === 'function') {
      updateSidebarAuthButtons();
    }
  }
};

// ==================== AUTO-FILL USER CREDENTIALS IN FORMS ====================
function autoFillUserCredentials(customUser) {
  const user = customUser || (typeof AUTH !== 'undefined' && AUTH.isLoggedIn() ? AUTH.user : null);
  if (!user) return;

  // 1. Formulaire Nous contacter (tab-contact)
  const contactName = document.getElementById('contactName');
  if (contactName && (!contactName.value || contactName.dataset.autofilled === 'true')) {
    contactName.value = user.username || '';
    contactName.dataset.autofilled = 'true';
  }
  const contactEmail = document.getElementById('contactEmail');
  if (contactEmail && (!contactEmail.value || contactEmail.dataset.autofilled === 'true')) {
    contactEmail.value = user.email || '';
    contactEmail.dataset.autofilled = 'true';
  }

  // 2. Formulaire Déposer une vidéo (tab-upload)
  const uploaderEmail = document.getElementById('uploaderEmail');
  if (uploaderEmail && (!uploaderEmail.value || uploaderEmail.dataset.autofilled === 'true')) {
    uploaderEmail.value = user.email || '';
    uploaderEmail.dataset.autofilled = 'true';
  }

  // 3. Formulaire Signaler un abus (tab-signaler)
  const reportFullName = document.getElementById('reportFullName');
  if (reportFullName && (!reportFullName.value || reportFullName.dataset.autofilled === 'true')) {
    reportFullName.value = user.username || '';
    reportFullName.dataset.autofilled = 'true';
  }
  const reportEmail = document.getElementById('reportEmail');
  if (reportEmail && (!reportEmail.value || reportEmail.dataset.autofilled === 'true')) {
    reportEmail.value = user.email || '';
    reportEmail.dataset.autofilled = 'true';
  }
  const reportSignature = document.getElementById('reportSignature');
  if (reportSignature && (!reportSignature.value || reportSignature.dataset.autofilled === 'true')) {
    reportSignature.value = user.username || '';
    reportSignature.dataset.autofilled = 'true';
  }
}

function clearAutoFilledCredentials() {
  const fieldIds = ['contactName', 'contactEmail', 'uploaderEmail', 'reportFullName', 'reportEmail', 'reportSignature'];
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.autofilled === 'true') {
      el.value = '';
      delete el.dataset.autofilled;
    }
  });
}

// Reset autofilled flag if user manually edits the input
document.addEventListener('DOMContentLoaded', () => {
  ['contactName', 'contactEmail', 'uploaderEmail', 'reportFullName', 'reportEmail', 'reportSignature'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        el.dataset.autofilled = 'false';
      });
    }
  });
  // Trigger autofill on DOM ready if user is already authenticated
  setTimeout(() => {
    if (typeof autoFillUserCredentials === 'function') {
      autoFillUserCredentials();
    }
  }, 250);
});

let currentPendingRegistrationToken = null;
let currentPendingEmail = '';

function switchAuthMode(mode) {
  const tabLogin = document.getElementById('tabLoginBtn');
  const tabRegister = document.getElementById('tabRegisterBtn');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const verifyOtpForm = document.getElementById('verifyOtpForm');

  if (mode === 'login') {
    if (tabLogin) tabLogin.classList.add('active');
    if (tabRegister) tabRegister.classList.remove('active');
    if (loginForm) loginForm.classList.remove('hidden');
    if (registerForm) registerForm.classList.add('hidden');
    if (verifyOtpForm) verifyOtpForm.classList.add('hidden');
  } else if (mode === 'verify_otp') {
    if (tabRegister) tabRegister.classList.add('active');
    if (tabLogin) tabLogin.classList.remove('active');
    if (verifyOtpForm) verifyOtpForm.classList.remove('hidden');
    if (registerForm) registerForm.classList.add('hidden');
    if (loginForm) loginForm.classList.add('hidden');
  } else {
    if (tabRegister) tabRegister.classList.add('active');
    if (tabLogin) tabLogin.classList.remove('active');
    if (registerForm) registerForm.classList.remove('hidden');
    if (loginForm) loginForm.classList.add('hidden');
    if (verifyOtpForm) verifyOtpForm.classList.add('hidden');
  }
}

async function handleLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername: identifier, password })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Identifiants invalides');
      return;
    }

    AUTH.setAuth(data.token, data.user);
    showToast('Bienvenue ' + data.user.username + (data.user.role === 'admin' ? ' (Mode Admin)' : '') + ' !');
    
    if (data.user.role === 'admin') {
      loadAdminStats();
      loadAdminVideos();
      switchTab('admin');
    } else {
      switchTab('accueil');
    }
  } catch (err) {
    showToast('Erreur de connexion au serveur.');
  }
}

async function quickFillAdminLogin() {
  const idInput = document.getElementById('loginIdentifier');
  const pwInput = document.getElementById('loginPassword');
  if (idInput && pwInput) {
    idInput.value = 'ia.project.pro2k26@gmail.com';
    pwInput.value = 'admin123';
  }
  await handleLogin({ preventDefault: () => {} });
}

// Étape 1 : Envoi du code de vérification par e-mail
async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const btnSubmit = document.getElementById('btnSubmitRegister');

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Envoi du code en cours...';
  }

  try {
    const res = await fetch('/api/auth/send-verification-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de la demande d\'inscription');
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Continuer et recevoir mon code';
      }
      return;
    }

    currentPendingRegistrationToken = data.pendingToken;
    currentPendingEmail = email;
    try {
      localStorage.setItem('vh_pending_reg_token', data.pendingToken);
      localStorage.setItem('vh_pending_reg_email', email);
    } catch (err) {}

    const emailDisplay = document.getElementById('verifyOtpEmailDisplay');
    if (emailDisplay) emailDisplay.textContent = email;

    showToast('Code envoyé à ' + email + ' ! Pensez à vérifier vos spams.');
    switchAuthMode('verify_otp');

    const otpInput = document.getElementById('regOtpCode');
    if (otpInput) {
      otpInput.value = '';
      setTimeout(() => otpInput.focus(), 150);
    }
  } catch (err) {
    showToast('Erreur de connexion au serveur.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Continuer et recevoir mon code';
    }
  }
}

// Étape 2 : Confirmation du code OTP et création définitive du compte en base de données
async function handleVerifyOtp(e) {
  e.preventDefault();
  const codeInput = document.getElementById('regOtpCode');
  let code = codeInput ? codeInput.value.replace(/[^0-9]/g, '').trim() : '';
  const btnSubmit = document.getElementById('btnSubmitVerifyOtp');

  if (!code || code.length !== 6) {
    showToast('Veuillez saisir le code complet à 6 chiffres.');
    if (codeInput) codeInput.focus();
    return;
  }

  const tokenToVerify = currentPendingRegistrationToken || localStorage.getItem('vh_pending_reg_token');
  if (!tokenToVerify) {
    showToast('Session expirée. Veuillez redemander un code.');
    switchAuthMode('register');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Création du compte en cours...';
  }

  try {
    const res = await fetch('/api/auth/verify-and-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken: tokenToVerify, code })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Code invalide ou expiré.');
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Confirmer et activer mon compte';
      }
      return;
    }

    try {
      localStorage.removeItem('vh_pending_reg_token');
      localStorage.removeItem('vh_pending_reg_email');
    } catch (err) {}
    currentPendingRegistrationToken = null;
    currentPendingEmail = '';

    AUTH.setAuth(data.token, data.user);
    showToast('Compte vérifié et enregistré avec succès ! Bienvenue ' + data.user.username);
    switchTab('accueil');
  } catch (err) {
    showToast('Erreur de communication avec le serveur.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Confirmer et activer mon compte';
    }
  }
}

// Renvoyer le code de confirmation
async function handleResendOtp() {
  const tokenToResend = currentPendingRegistrationToken || localStorage.getItem('vh_pending_reg_token');
  if (!tokenToResend) {
    showToast('Aucune inscription en attente.');
    switchAuthMode('register');
    return;
  }

  const btn = document.getElementById('btnResendOtp');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Envoi...';
  }

  try {
    const res = await fetch('/api/auth/resend-verification-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken: tokenToResend })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors du renvoi du code.');
      return;
    }

    currentPendingRegistrationToken = data.pendingToken;
    try {
      localStorage.setItem('vh_pending_reg_token', data.pendingToken);
    } catch (err) {}
    showToast(data.message || 'Nouveau code envoyé par e-mail ! Pensez à vérifier vos spams.');
  } catch (err) {
    showToast('Erreur de communication.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Renvoyer le code';
    }
  }
}

// Revenir à l'étape 1 pour modifier ses identifiants
function handleCancelOtp() {
  try {
    localStorage.removeItem('vh_pending_reg_token');
    localStorage.removeItem('vh_pending_reg_email');
  } catch (err) {}
  currentPendingRegistrationToken = null;
  currentPendingEmail = '';
  switchAuthMode('register');
}

function handleLogout() {
  if (confirm('Voulez-vous vraiment vous déconnecter ?')) {
    AUTH.logout();
  }
}

async function loadMyVideos() {
  if (!AUTH.user) return;
  const grid = document.getElementById('myVideosGrid');
  const videosStatEl = document.getElementById('profileStatVideos');
  const viewsStatEl = document.getElementById('profileStatViews');
  const ratingStatEl = document.getElementById('profileStatRating') || document.getElementById('profileStatLikes');
  const statusStatEl = document.getElementById('profileStatStatus');
  const countHeaderEl = document.getElementById('myVideosCountHeader');

  if (statusStatEl) {
    statusStatEl.textContent = AUTH.isAdmin() ? 'Administrateur (VIP)' : (AUTH.isVip() ? 'VIP Certifié' : 'Membre Gratuit');
  }

  if (!grid) return;

  try {
    const res = await fetch(`/api/videos?userId=${AUTH.user.id}`);
    const data = await res.json();
    const myVideos = data.videos || [];

    const totalViews = myVideos.reduce((sum, v) => sum + (v.views || 0), 0);
    const ratedVideos = myVideos.filter(v => typeof v.rating === 'number' && v.rating > 0);
    const avgRating = ratedVideos.length > 0
      ? (ratedVideos.reduce((sum, v) => sum + v.rating, 0) / ratedVideos.length).toFixed(1)
      : '5.0';

    if (videosStatEl) videosStatEl.textContent = myVideos.length;
    if (viewsStatEl) viewsStatEl.textContent = totalViews.toLocaleString();
    if (ratingStatEl) ratingStatEl.textContent = `${avgRating} / 5`;
    if (countHeaderEl) countHeaderEl.textContent = myVideos.length;

    if (myVideos.length === 0) {
      grid.innerHTML = `
        <div class="empty-my-videos-card">
          <h4>Vous n'avez pas encore publié de vidéo</h4>
          <p>Partagez dès maintenant vos créations avec la communauté en quelques clics sans inscription.</p>
          <button class="btn btn-primary mt-2" onclick="switchTab('upload')">+ Déposer une vidéo</button>
        </div>
      `;
      return;
    }

    grid.innerHTML = myVideos.map(v => renderVideoCard(v)).join('');
  } catch (err) {
    console.error(err);
  }
}
