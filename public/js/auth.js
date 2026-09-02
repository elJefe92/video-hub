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
      this.user.email &&
      this.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com'
    );
  },

  isVip() {
    return this.user && this.user.isVip;
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
        const emailInput = document.getElementById('uploaderEmail');
        if (emailInput && this.user.email) {
          emailInput.value = this.user.email;
        }
      }

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

        if (this.user.isVip) {
          if (vipCrown) vipCrown.classList.remove('hidden');
          if (vipTag) vipTag.classList.remove('hidden');
          if (btnUpgrade) btnUpgrade.classList.add('hidden');
        } else {
          if (vipCrown) vipCrown.classList.add('hidden');
          if (vipTag) vipTag.classList.add('hidden');
          if (btnUpgrade) btnUpgrade.classList.remove('hidden');
        }

        // Load user videos in profile
        loadMyVideos();
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
        if (this.isVip()) {
          adBanner.classList.add('hidden');
        } else {
          adBanner.classList.remove('hidden');
        }
      }

      if (authView) authView.classList.remove('hidden');
      if (profileView) profileView.classList.add('hidden');
    }
  }
};

function switchAuthMode(mode) {
  const tabLogin = document.getElementById('tabLoginBtn');
  const tabRegister = document.getElementById('tabRegisterBtn');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  if (mode === 'login') {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
  } else {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    registerForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
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

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de l\'inscription');
      return;
    }

    AUTH.setAuth(data.token, data.user);
    showToast('Inscription réussie ! Bienvenue ' + data.user.username);
    switchTab('accueil');
  } catch (err) {
    showToast('Erreur de connexion au serveur.');
  }
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
  const likesStatEl = document.getElementById('profileStatLikes');
  const statusStatEl = document.getElementById('profileStatStatus');
  const countHeaderEl = document.getElementById('myVideosCountHeader');

  if (statusStatEl) {
    statusStatEl.textContent = AUTH.isVip() ? 'VIP Certifié' : 'Membre Gratuit';
  }

  if (!grid) return;

  try {
    const res = await fetch(`/api/videos?userId=${AUTH.user.id}`);
    const data = await res.json();
    const myVideos = data.videos || [];

    const totalViews = myVideos.reduce((sum, v) => sum + (v.views || 0), 0);
    const totalLikes = myVideos.reduce((sum, v) => sum + (v.likes || 0), 0);

    if (videosStatEl) videosStatEl.textContent = myVideos.length;
    if (viewsStatEl) viewsStatEl.textContent = totalViews.toLocaleString();
    if (likesStatEl) likesStatEl.textContent = totalLikes.toLocaleString();
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
