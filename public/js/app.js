// Main App Controller
let allVideosList = [];
let allCategoriesList = [];
let activeCategory = 'all';
let currentPlayingVideo = null;
let selectedExplorerTags = new Set();
let currentFeedPage = 1;
const VIDEOS_PER_PAGE = 12;

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await AUTH.init();
  await loadCategories();
  await loadVideos();
  await loadFaqs();
  if (AUTH.isAdmin()) {
    await loadAdminStats();
    await loadAdminVideos();
  }

  // Handle URL hash on load (e.g. #explorer, #tag=gaming)
  handleUrlHash();
  window.addEventListener('hashchange', handleUrlHash);
});

// ==================== THEME CONTROLLER (MODE SOMBRE / CLAIR) ====================
function initTheme() {
  const savedTheme = localStorage.getItem('francevideo_theme') || 'dark';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  const btn = document.getElementById('themeToggleBtn');
  const sideIcon = document.getElementById('sideThemeIcon');
  const sideLabel = document.getElementById('sideThemeLabel');

  if (theme === 'light') {
    document.body.classList.add('theme-light');
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
      btn.title = "Passer au mode sombre";
    }
    if (sideIcon) {
      sideIcon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    }
    if (sideLabel) {
      sideLabel.textContent = "Passer au mode sombre";
    }
  } else {
    document.body.classList.remove('theme-light');
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
      btn.title = "Passer au mode clair";
    }
    if (sideIcon) {
      sideIcon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    }
    if (sideLabel) {
      sideLabel.textContent = "Passer au mode clair";
    }
  }
  localStorage.setItem('francevideo_theme', theme);
}


function toggleTheme() {
  const isLight = document.body.classList.contains('theme-light');
  applyTheme(isLight ? 'dark' : 'light');
}

function handleUrlHash() {
  const pathname = window.location.pathname;
  const hash = window.location.hash.replace('#', '');
  const urlParams = new URLSearchParams(window.location.search);
  const catQuery = urlParams.get('cat') || urlParams.get('categorie') || urlParams.get('category');

  // Handle /profil/:username direct URLs
  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'profil' && pathParts[1]) {
    const username = decodeURIComponent(pathParts[1]);
    switchTab('accueil');
    setTimeout(() => openPublicUserProfile(username), 400);
    return;
  }

  if (pathname === '/admin' || hash === 'admin') {
    if (AUTH.isAdmin()) {
      switchTab('admin');
    } else {
      showToast("Accès refusé. L'Espace Administrateur est strictement réservé au compte ia.project.pro2k26@gmail.com");
      window.history.replaceState(null, '', '/');
      window.location.hash = 'accueil';
      switchTab('accueil');
    }
    return;
  }

  if (catQuery) {
    quickFilterByTag(catQuery);
    return;
  }

  if (hash.startsWith('tag=') || hash.startsWith('category=') || hash.startsWith('categorie=') || hash.startsWith('cat=')) {
    const tag = hash.split('=')[1];
    quickFilterByTag(tag);
  } else if (hash === 'explorer') {
    switchTab('explorer');
  } else if (['accueil', 'upload', 'vip', 'faq', 'profil'].includes(hash)) {
    switchTab(hash);
  }
}


// Sidebar drawer toggle
function toggleSidebar(forceState) {
  const sidebar = document.getElementById('appSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;

  const isOpen = sidebar.classList.contains('open');
  const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;

  if (shouldOpen) {
    sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
  } else {
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }
}

// Navigate to Admin URL /admin only if logged in as ia.project.pro2k26@gmail.com
function navigateToAdmin() {
  if (!AUTH.isAdmin()) {
    showToast("Accès refusé. L'Espace Administrateur est strictement réservé au compte ia.project.pro2k26@gmail.com");
    window.history.replaceState(null, '', '/');
    switchTab('accueil');
    return;
  }
  if (window.location.pathname !== '/admin') {
    window.history.pushState(null, '', '/admin');
  }
  switchTab('admin');
  toggleSidebar(false);
}

// Navigate from sidebar with auto-close on mobile
function navigateToTab(tabName) {
  if (tabName === 'admin') {
    navigateToAdmin();
    return;
  }
  switchTab(tabName);
  toggleSidebar(false);
}

// Tab navigation controller
function switchTab(tabName) {
  if (tabName === 'admin') {
    if (!AUTH.isAdmin()) {
      showToast("Accès refusé. L'Espace Administrateur est strictement réservé au compte ia.project.pro2k26@gmail.com");
      window.history.replaceState(null, '', '/');
      tabName = 'accueil';
    } else {
      if (window.location.pathname !== '/admin') {
        window.history.pushState(null, '', '/admin');
      }
    }
  } else if (window.location.pathname === '/admin') {
    window.history.pushState(null, '', '/');
  }

  const tabs = ['accueil', 'explorer', 'upload', 'vip', 'faq', 'profil', 'admin'];
  tabs.forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.classList.remove('active');
  });

  const targetTab = document.getElementById(`tab-${tabName}`);
  if (targetTab) targetTab.classList.add('active');

  // Update mobile bottom nav active classes
  const navItems = ['accueil', 'upload', 'vip', 'faq', 'profil'];
  navItems.forEach(item => {
    const navBtn = document.getElementById(`nav-${item}`);
    if (navBtn) {
      navBtn.classList.toggle('active', item === tabName);
    }
  });

  // Update sidebar active classes
  const allSideItems = ['accueil', 'explorer', 'upload', 'vip', 'faq', 'profil', 'admin'];
  allSideItems.forEach(item => {
    const sideBtn = document.getElementById(`side-nav-${item}`);
    if (sideBtn) {
      sideBtn.classList.toggle('active', item === tabName);
    }
  });

  // If opening explorer tab, refresh explorer data
  if (tabName === 'explorer') {
    loadExplorerData();
  }

  // If opening admin tab, refresh data
  if (tabName === 'admin' && AUTH.isAdmin()) {
    loadAdminStats();
    loadAdminVideos();
    renderAdminCategoriesManager();
  }

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==================== CATEGORIES & SELECTORS ====================
async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    allCategoriesList = data.categories || [];
    renderCategoriesBar();
    renderSidebarCategories();
    populateMultiCategorySelectors();
    renderAdminCategoriesManager();
  } catch (err) {
    console.error('Error loading categories', err);
  }
}

function renderSidebarCategories() {
  const catContainer = document.getElementById('sidebarCategoriesList');
  if (!catContainer) return;

  catContainer.innerHTML = allCategoriesList.map(cat => {
    const isAct = activeCategory === cat.id;
    return `
      <li>
        <button class="sidebar-nav-item ${isAct ? 'active' : ''}" onclick="selectCategoryFromSidebar('${cat.id}')">
          <span class="sidebar-item-label">${cat.name}</span>
        </button>
      </li>
    `;
  }).join('');
}

function renderCategoriesBar() {
  const bar = document.getElementById('categoriesBar');
  if (!bar) return;

  bar.innerHTML = allCategoriesList.map(cat => `
    <button class="category-pill ${activeCategory === cat.id ? 'active' : ''}" onclick="filterByCategory('${cat.id}')">
      <span>${cat.name}</span>
    </button>
  `).join('');
}

function populateMultiCategorySelectors() {
  const uploadContainer = document.getElementById('uploadCategoriesMultiSelect');
  const editContainer = document.getElementById('editVideoCategoriesMultiSelect');

  const availableCats = allCategoriesList.filter(c => c.id !== 'all');

  const generateCheckboxes = (containerPrefix, defaultCheckedId = '') => {
    return availableCats.map(cat => `
      <label class="multi-cat-item ${cat.id === defaultCheckedId ? 'selected' : ''}" id="${containerPrefix}_label_${cat.id}">
        <input type="checkbox" value="${cat.id}" ${cat.id === defaultCheckedId ? 'checked' : ''} onchange="toggleCatCheckboxStyle(this, '${containerPrefix}')">
        <span>${cat.name}</span>
      </label>
    `).join('');
  };

  if (uploadContainer) {
    uploadContainer.innerHTML = generateCheckboxes('uploadCat');
  }
  if (editContainer) {
    editContainer.innerHTML = generateCheckboxes('editCat', '');
  }
}

function toggleCatCheckboxStyle(checkbox, containerPrefix) {
  const label = document.getElementById(`${containerPrefix}_label_${checkbox.value}`);
  if (label) {
    if (checkbox.checked) {
      label.classList.add('selected');
    } else {
      label.classList.remove('selected');
    }
  }
}

function filterByCategory(catId) {
  activeCategory = catId;
  renderCategoriesBar();
  renderSidebarCategories();

  const searchVal = document.getElementById('globalSearchInput')?.value || '';
  loadVideos(catId, searchVal);

  const heading = document.getElementById('feedHeading');
  const found = allCategoriesList.find(c => c.id === catId);
  if (heading && found) {
    heading.textContent = `${found.name}`;
  }
}

function selectCategoryFromSidebar(catId) {
  switchTab('accueil');
  filterByCategory(catId);
  toggleSidebar(false);
}

function navigateToAdmin() {
  toggleSidebar(false);
  if (AUTH && AUTH.isAdmin()) {
    switchTab('admin');
  } else {
    showToast('Veuillez vous connecter en tant qu\'administrateur.');
    switchTab('profil');
  }
}

// Add Category Modal
function openAddCategoryModal() {
  const modal = document.getElementById('addCategoryModal');
  if (modal) modal.classList.remove('hidden');
}

function closeAddCategoryModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('addCategoryModal');
  if (modal) modal.classList.add('hidden');
}

async function handleAddCategory(e) {
  e.preventDefault();

  if (!AUTH.isLoggedIn()) {
    showToast('Vous devez être connecté pour ajouter une catégorie.');
    switchTab('profil');
    closeAddCategoryModal();
    return;
  }

  const name = document.getElementById('newCatName').value.trim();
  const icon = '';
  const description = '';

  try {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({ name, icon, description })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de l\'ajout'));
      return;
    }

    showToast(data.message);
    document.getElementById('addCategoryForm').reset();
    closeAddCategoryModal();

    await loadCategories();
    if (typeof loadExplorerData === 'function') loadExplorerData();
  } catch (err) {
    showToast('Erreur de communication avec le serveur.');
  }
}

async function deleteCategory(catId) {
  if (!confirm('Êtes-vous sûr de vouloir supprimer cette catégorie ?')) return;

  try {
    const res = await fetch(`/api/categories/${catId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la suppression'));
      return;
    }

    showToast(data.message);
    await loadCategories();
    if (typeof loadExplorerData === 'function') loadExplorerData();
  } catch (err) {
    showToast('Erreur de suppression.');
  }
}

// ==================== VIDEO FEED ====================
let searchDebounceTimer = null;

function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentFeedPage = 1;
    loadVideos();
  }, 400);
}

function applyAdvancedFilters() {
  currentFeedPage = 1;
  loadVideos();
}

function resetAdvancedFilters() {
  const s = document.getElementById('searchInput');
  const r = document.getElementById('filterRegion');
  const so = document.getElementById('filterSort');
  if (s) s.value = '';
  if (r) r.value = '';
  if (so) so.value = 'recent';
  currentFeedPage = 1;
  loadVideos();
}

function getAdvancedFilterParams(cat) {
  const params = new URLSearchParams();
  const q = document.getElementById('searchInput')?.value?.trim();
  const region = document.getElementById('filterRegion')?.value;
  const sort = document.getElementById('filterSort')?.value || 'recent';
  if (cat && cat !== 'all') params.set('category', cat);
  if (q) params.set('q', q);
  if (region) params.set('region', region);
  params.set('sort', sort);
  return params.toString();
}

async function loadVideos(cat = 'all', searchQuery = '') {
  try {
    let queryString = getAdvancedFilterParams(cat);
    // Legacy: support explicit searchQuery param
    if (searchQuery && !document.getElementById('searchInput')?.value) {
      queryString += `&q=${encodeURIComponent(searchQuery)}`;
    }
    const res = await fetch(`/api/videos?${queryString}`);
    const data = await res.json();
    allVideosList = data.videos || [];

    renderVideoGrid(allVideosList);
  } catch (err) {
    console.error('Error loading videos', err);
  }
}


function renderVideoGrid(videos, targetGridId = 'videoGrid') {
  const grid = document.getElementById(targetGridId);
  const countEl = document.getElementById('videoCount');
  const paginationContainer = document.getElementById('feedPagination');
  if (!grid) return;

  if (countEl && targetGridId === 'videoGrid') {
    countEl.textContent = `${videos.length} vidéo${videos.length > 1 ? 's' : ''}`;
  }

  if (videos.length === 0) {
    grid.innerHTML = `
      <div class="empty-feed-card">
        
        <h4>Aucune vidéo pour le moment</h4>
        <p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:16px;">Soyez le premier à déposer une vidéo !</p>
        <button class="btn btn-primary" onclick="switchTab('upload')">Déposer une vidéo</button>
      </div>
    `;
    if (paginationContainer && targetGridId === 'videoGrid') {
      paginationContainer.innerHTML = '';
    }
    return;
  }

  // Handle Home Tab Pagination (10 videos per page)
  if (targetGridId === 'videoGrid') {
    const totalPages = Math.ceil(videos.length / VIDEOS_PER_PAGE);
    if (currentFeedPage > totalPages) currentFeedPage = 1;
    if (currentFeedPage < 1) currentFeedPage = 1;

    const startIndex = (currentFeedPage - 1) * VIDEOS_PER_PAGE;
    const endIndex = startIndex + VIDEOS_PER_PAGE;
    const pageVideos = videos.slice(startIndex, endIndex);

    grid.innerHTML = pageVideos.map(v => renderVideoCard(v)).join('');
    renderPaginationControls(totalPages, currentFeedPage);
    return;
  }

  grid.innerHTML = videos.map(v => renderVideoCard(v)).join('');
}

function renderPaginationControls(totalPages, currentPage) {
  const container = document.getElementById('feedPagination');
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <div class="pagination-box">
      <button class="btn-page-nav" ${currentPage <= 1 ? 'disabled' : ''} onclick="goToFeedPage(${currentPage - 1})">
        ← Précédent
      </button>
      <div class="pagination-numbers">
  `;

  for (let i = 1; i <= totalPages; i++) {
    html += `
      <button class="btn-page-number ${i === currentPage ? 'active' : ''}" onclick="goToFeedPage(${i})">
        ${i}
      </button>
    `;
  }

  html += `
      </div>
      <button class="btn-page-nav" ${currentPage >= totalPages ? 'disabled' : ''} onclick="goToFeedPage(${currentPage + 1})">
        Suivant →
      </button>
    </div>
  `;

  container.innerHTML = html;
}

function goToFeedPage(page) {
  currentFeedPage = page;
  renderVideoGrid(allVideosList);
  const feedHeading = document.getElementById('feedHeading');
  if (feedHeading) {
    feedHeading.scrollIntoView({ behavior: 'smooth' });
  }
}

function renderVideoCard(v) {
  const cats = (v.categories && Array.isArray(v.categories) && v.categories.length > 0) ? v.categories : [v.category || 'general'];
  const regionName = v.region || 'Île-de-France';
  const pubDate = v.publishedAt || v.createdAt;
  const formattedDate = pubDate ? new Date(pubDate).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const avatarUrl = v.authorAvatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(v.authorName || 'Utilisateur')}`;

  return `
    <div class="video-card" onclick="openVideoPlayerModal('${v.id}')">
      <div class="video-thumbnail-wrap">
        <img class="video-thumbnail" src="${v.thumbnail}" alt="${v.title}" loading="lazy">
        <div class="play-overlay-btn">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
        <span class="video-rating-pill-card"> ${(v.rating || 5.0).toFixed(1)}</span>
        <span class="video-duration-badge">${v.duration || '0:30'}</span>
        ${v.status === 'pending' ? '<span class="video-pending-badge">En attente</span>' : ''}
        ${v.isVipExclusive ? '<span class="vip-exclusive-badge">EXCLUSIF VIP</span>' : (v.isVipAuthor ? '<span class="vip-card-badge">VIP</span>' : '')}
      </div>

      <div class="video-card-body">
        <div class="video-card-header">
          <img src="${avatarUrl}" alt="${v.authorName}" class="creator-avatar" style="cursor:pointer;" onclick="event.stopPropagation(); openPublicUserProfile('${v.authorId || v.authorName}')" title="Voir le profil de ${v.authorName}">
          <div class="video-card-meta">
            <h4 class="video-card-title">${v.title}</h4>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
              <span class="video-creator-name" style="cursor:pointer;" onclick="event.stopPropagation(); openPublicUserProfile('${v.authorId || v.authorName}')" title="Voir le profil de ${v.authorName}">
                ${v.authorName} ${v.isVipAuthor ? '(VIP)' : ''}
              </span>
              <span class="badge-region-pill" title="Region">${regionName}</span>
            </div>
            ${v.creatorBadge ? `<span style="font-size:0.65rem;font-weight:700;color:${{'Bronze':'#cd7f32','Argent':'#a8a9ad','Or':'#ffd700','Platine':'#e5e4e2'}[v.creatorBadge]||'#94a3b8'};letter-spacing:0.3px;">Createur ${v.creatorBadge}</span>` : ''}
          </div>
        </div>

        <div class="video-card-pub-row">
          <span>${formattedDate ? 'Publiée le ' + formattedDate : 'Récemment'}</span>
          <span>${(v.views || 0).toLocaleString()} vues • ${v.likes || 0} j'aime</span>
        </div>
        
        <div style="display:flex;justify-content:flex-end;padding:4px 0 0;">
          <button data-fav-btn="${v.id}" onclick="event.stopPropagation(); toggleFavorite('${v.id}')" 
            style="background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;color:var(--text-muted);display:flex;align-items:center;gap:4px;font-size:0.78rem;">
            ${isFavorite(v.id) 
              ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#ef4444" stroke="#ef4444" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
              : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
            }
          </button>
        </div>

        <div class="video-stats-footer">
          <div class="video-tags-wrap">
            ${cats.map(c => `
              <span class="video-tag-pill" onclick="event.stopPropagation(); quickFilterByTag('${c}')" title="Filtrer par #${c}">
                #${c}
              </span>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Category-Only Search Engine (Deduplicated & Smart Filter)
let categorySearchDebounce = null;
function handleCategorySearch(val) {
  clearTimeout(categorySearchDebounce);
  const dropdown = document.getElementById('categorySearchSuggestions');
  const query = (val || '').trim().toLowerCase();

  if (!query) {
    if (dropdown) dropdown.classList.add('hidden');
    loadVideos(activeCategory, '');
    return;
  }

  categorySearchDebounce = setTimeout(() => {
    // Unique categories deduplicated
    const seen = new Set();
    const matches = allCategoriesList.filter(c => {
      if (c.id === 'all') return false;
      const key = (c.name || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      if (key.includes(query)) {
        seen.add(key);
        return true;
      }
      return false;
    });

    if (dropdown) {
      if (matches.length === 0) {
        dropdown.innerHTML = `<div class="cat-suggestion-item" style="color:var(--text-muted);">Aucune catégorie correspondant à "${val}"</div>`;
        dropdown.classList.remove('hidden');
      } else {
        dropdown.innerHTML = matches.map(c => `
          <div class="cat-suggestion-item" onclick="selectCategoryFromSearch('${c.id}')">
            <span>#${c.name}</span>
            <span class="cat-suggestion-count">Catégorie</span>
          </div>
        `).join('');
        dropdown.classList.remove('hidden');
      }
    }

    // Filter video grid by matched category IDs
    const matchedIds = matches.map(m => m.id);
    if (matchedIds.length > 0) {
      filterVideosByCategoryIds(matchedIds);
    } else {
      loadVideos('', query);
    }
  }, 200);
}

function selectCategoryFromSearch(catId) {
  const dropdown = document.getElementById('categorySearchSuggestions');
  if (dropdown) dropdown.classList.add('hidden');
  const cat = allCategoriesList.find(c => c.id === catId);
  const input = document.getElementById('globalSearchInput');
  if (input && cat) input.value = cat.name;
  quickFilterByTag(catId);
}

function filterVideosByCategoryIds(catIds) {
  const filtered = allVideosList.filter(v => {
    const vCats = (v.categories && Array.isArray(v.categories)) ? v.categories : [v.category];
    return vCats.some(c => catIds.includes(c));
  });
  renderVideoGrid(filtered);
}

// ==================== EXPLORATEUR MULTI-TAGS CONTROLLER ====================
let currentCategorySortMode = 'popular'; // 'popular' (les plus sélectionnées) ou 'alpha' (ordre alphabétique A-Z)
let cachedExplorerCategories = [];

function setCategorySortMode(mode) {
  currentCategorySortMode = mode;
  const btnPop = document.getElementById('btnSortPopular');
  const btnAlpha = document.getElementById('btnSortAlpha');
  if (btnPop && btnAlpha) {
    if (mode === 'popular') {
      btnPop.classList.add('active');
      btnAlpha.classList.remove('active');
    } else {
      btnAlpha.classList.add('active');
      btnPop.classList.remove('active');
    }
  }
  renderExplorerTagsCloud();
}

function sortCategoriesList(categories) {
  const list = [...categories];
  if (currentCategorySortMode === 'popular') {
    // Plus sélectionnées / populaires en premier, puis alphabétique
    return list.sort((a, b) => {
      const diff = (b.count || 0) - (a.count || 0);
      if (diff !== 0) return diff;
      return (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
    });
  } else {
    // Ordre alphabétique pur A-Z
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' }));
  }
}

function renderExplorerTagsCloud() {
  const tagsContainer = document.getElementById('explorerTagsCloud');
  if (!tagsContainer || !cachedExplorerCategories) return;

  const sortedCategories = sortCategoriesList(cachedExplorerCategories);

  tagsContainer.innerHTML = sortedCategories.map(c => {
    const isSelected = selectedExplorerTags.has(c.id);
    return `
      <a href="?cat=${encodeURIComponent(c.id)}" class="tag-chip ${isSelected ? 'active' : ''}" onclick="event.preventDefault(); toggleExplorerTag('${c.id}')" title="Filtrer et afficher les vidéos de la catégorie ${c.name}">
        <span>${c.name}</span>
        <span class="tag-chip-count">${c.count || 0}</span>
      </a>
    `;
  }).join('');
}

async function loadExplorerData(shouldScroll = false) {
  const tagsContainer = document.getElementById('explorerTagsCloud');
  const contentArea = document.getElementById('explorerContentArea');
  const clearBtn = document.getElementById('btnClearTags');
  const statusEl = document.getElementById('activeTagsStatus');

  if (!tagsContainer || !contentArea) return;

  try {
    const res = await fetch('/api/explorer');
    const data = await res.json();
    cachedExplorerCategories = data.categories || [];

    // Render tag chips with active sort mode
    renderExplorerTagsCloud();

    // If tags are selected, show filtered multi-tag results
    if (selectedExplorerTags.size > 0) {
      if (clearBtn) clearBtn.style.display = 'inline-block';
      const tagNames = Array.from(selectedExplorerTags).map(t => {
        const found = cachedExplorerCategories.find(c => c.id === t);
        return found ? `${found.name}` : `#${t}`;
      }).join(' + ');

      if (statusEl) {
        statusEl.innerHTML = `<span>Filtre actif combiné : <strong>${tagNames}</strong></span>`;
      }

      // Fetch matching videos
      const queryCats = Array.from(selectedExplorerTags).join(',');
      const vidRes = await fetch(`/api/videos?categories=${encodeURIComponent(queryCats)}`);
      const vidData = await vidRes.json();
      const matchedVideos = vidData.videos || [];

      contentArea.innerHTML = `
        <div class="section-heading mt-3" id="explorerResultsHeading">
          <h3>Résultats (${matchedVideos.length} vidéo${matchedVideos.length > 1 ? 's' : ''})</h3>
          <span class="video-counter">${selectedExplorerTags.size} catégorie(s) sélectionnée(s)</span>
        </div>
        <div class="video-grid" id="explorerMatchedGrid">
          <!-- Dynamic Matched Cards -->
        </div>
      `;
      renderVideoGrid(matchedVideos, 'explorerMatchedGrid');

      // Défilement fluide vers les vidéos de la catégorie choisie
      if (shouldScroll) {
        setTimeout(() => {
          const scrollTarget = document.getElementById('activeTagsStatus') || document.getElementById('explorerResultsHeading') || contentArea;
          if (scrollTarget) {
            scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 60);
      }

    } else {
      // No tag selected: Display directory of Category Showcases
      if (clearBtn) clearBtn.style.display = 'none';
      if (statusEl) {
        statusEl.innerHTML = `<small style="color:var(--text-muted);">Cliquez sur une ou plusieurs catégories ci-dessus pour accéder directement aux vidéos.</small>`;
      }

      const sortedList = sortCategoriesList(cachedExplorerCategories);

      contentArea.innerHTML = sortedList.map(c => `
        <div class="category-showcase-block" id="category_section_${c.id}">
          <div class="showcase-header">
            <div class="showcase-title-left">
              <div>
                <h3 class="showcase-name">${c.name}</h3>
                <p class="showcase-desc">${c.description || 'Découvrez toutes les créations de cette catégorie.'}</p>
              </div>
            </div>
            <a href="?cat=${encodeURIComponent(c.id)}" class="btn-showcase-explore" onclick="event.preventDefault(); quickFilterByTag('${c.id}')">
              Explorer (${c.count || 0}) →
            </a>
          </div>

          <div class="video-grid" id="showcase_grid_${c.id}">
            ${c.videos && c.videos.length > 0 ? c.videos.map(v => renderVideoCard(v)).join('') : `
              <p style="grid-column:1/-1;color:var(--text-muted);font-size:0.88rem;padding:12px;background:var(--bg-subtle);border-radius:8px;">
                Aucune vidéo pour le moment dans cette catégorie.
              </p>
            `}
          </div>
        </div>
      `).join('');
    }

  } catch (err) {
    console.error('Error loading explorer', err);
  }
}

function toggleExplorerTag(tagId) {
  if (selectedExplorerTags.has(tagId)) {
    selectedExplorerTags.delete(tagId);
  } else {
    selectedExplorerTags.add(tagId);
  }

  // Mise à jour de l'URL avec le lien hypertexte direct vers la catégorie
  if (selectedExplorerTags.size > 0) {
    const catsStr = Array.from(selectedExplorerTags).join(',');
    window.history.replaceState(null, '', `?cat=${encodeURIComponent(catsStr)}`);
  } else {
    window.history.replaceState(null, '', window.location.pathname);
  }

  loadExplorerData(true);
}

function clearSelectedExplorerTags() {
  selectedExplorerTags.clear();
  window.history.replaceState(null, '', window.location.pathname);
  loadExplorerData(false);
  showToast('Filtres réinitialisés.');
}

function quickFilterByTag(tagId) {
  selectedExplorerTags.clear();
  selectedExplorerTags.add(tagId);
  window.history.replaceState(null, '', `?cat=${encodeURIComponent(tagId)}`);
  switchTab('explorer');
  loadExplorerData(true);
  showToast(`Filtré sur la catégorie : #${tagId}`);
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return 'Publiée récemment';
  const timestamp = new Date(dateStr).getTime();
  if (isNaN(timestamp)) return 'Publiée récemment';
  const diff = Date.now() - timestamp;
  if (diff < 0) return "À l'instant";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "À l'instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours} ${hours === 1 ? 'heure' : 'heures'}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Il y a ${days} ${days === 1 ? 'jour' : 'jours'}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Il y a ${months} mois`;
  const years = Math.floor(months / 12);
  return `Il y a ${years} ${years === 1 ? 'an' : 'ans'}`;
}

// Video Player Modal with VIP Paywall check & Rich Details (Tags, Similar, Comments)
async function openVideoPlayerModal(videoId) {
  let video = (allVideosList || []).find(v => v.id === videoId);
  if (!video && window.adminVideosList) {
    video = window.adminVideosList.find(v => v.id === videoId);
  }
  if (!video && typeof allAdminOnlineVideos !== 'undefined') {
    video = allAdminOnlineVideos.find(v => v.id === videoId);
  }
  if (!video) {
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}`);
      if (res.ok) {
        const data = await res.json();
        video = data.video;
      }
    } catch (e) {}
  }
  if (!video) {
    showToast('Vidéo introuvable.');
    return;
  }

  currentPlayingVideo = video;
  const modal = document.getElementById('videoModal');
  const player = document.getElementById('modalVideoPlayer');
  const paywallOverlay = document.getElementById('vipPaywallOverlay');
  const title = document.getElementById('modalVideoTitle');
  const desc = document.getElementById('modalVideoDesc');
  const authorName = document.getElementById('modalAuthorName');
  const authorAvatar = document.getElementById('modalAuthorAvatar');
  const authorBadge = document.getElementById('modalAuthorBadge');
  const authorLevelBadge = document.getElementById('modalAuthorLevelBadge');
  const likesCount = document.getElementById('modalLikesCount');
  const adminEditBtn = document.getElementById('modalAdminEditTagsBtn');
  const dateEl = document.getElementById('modalVideoDate');
  const viewsEl = document.getElementById('modalVideoViews');
  const regionEl = document.getElementById('modalVideoRegion');

  if (title) title.textContent = video.title || 'Vidéo sans titre';
  if (desc) desc.textContent = video.description || 'Aucune description fournie.';
  if (authorName) {
    authorName.textContent = video.authorName || 'Membre VideoHub';
    authorName.style.cursor = 'pointer';
    authorName.title = `Voir le profil de ${video.authorName}`;
    authorName.onclick = () => openPublicUserProfile(video.authorId || video.authorName);
  }

  if (authorAvatar) {
    authorAvatar.src = video.authorAvatar || ('https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(video.authorName || 'VideoHub'));
    authorAvatar.style.cursor = 'pointer';
    authorAvatar.title = `Voir le profil de ${video.authorName}`;
    authorAvatar.onclick = () => openPublicUserProfile(video.authorId || video.authorName);
  }

  if (likesCount) likesCount.textContent = video.likes || 0;
  
  const modalFavBtn = document.getElementById('modalFavBtn');
  if (modalFavBtn) {
    modalFavBtn.setAttribute('data-fav-btn', video.id);
    const isFav = isFavorite(video.id);
    modalFavBtn.classList.toggle('active', isFav);
    modalFavBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="${isFav ? '#ef4444' : 'none'}" stroke="${isFav ? '#ef4444' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      <span class="action-text">${isFav ? 'Ajouté' : 'Favori'}</span>
    `;
  }

  if (dateEl) {
    dateEl.textContent = formatTimeAgo(video.createdAt);
  }
  if (viewsEl) {
    viewsEl.textContent = `${(video.views || 1).toLocaleString()} vues`;
  }
  if (regionEl) {
    regionEl.textContent = `${video.region || 'France'}`;
  }

  // Admin Tag / Metadata button
  if (adminEditBtn) {
    if (AUTH.isAdmin()) {
      adminEditBtn.classList.remove('hidden');
    } else {
      adminEditBtn.classList.add('hidden');
    }
  }

  if (video.isVipAuthor || video.isVipExclusive) {
    authorBadge.classList.remove('hidden');
    authorBadge.textContent = video.isVipExclusive ? 'EXCLUSIF VIP' : 'VIP';
  } else {
    authorBadge.classList.add('hidden');
  }

  if (authorLevelBadge) {
    if (video.creatorBadge && video.creatorBadge.name) {
      authorLevelBadge.classList.remove('hidden');
      authorLevelBadge.textContent = video.creatorBadge.name;
      authorLevelBadge.className = `creator-level-badge badge-${(video.creatorBadge.level || 'bronze').toLowerCase()}`;
    } else {
      authorLevelBadge.classList.add('hidden');
    }
  }

  // Update Star Rating Display
  const currentRating = video.rating || 5.0;
  const ratingCount = video.ratingCount || 1;
  updateRatingUI(currentRating, ratingCount, video.id);

  // Render Tags
  renderModalTags(video.categories || [video.category]);

  // Load Similar Videos
  loadSimilarVideos(video.id);

  // Load Comments
  loadVideoComments(video.id);

  // Pre-fill user name in comment form if logged in
  const guestNameInput = document.getElementById('commentGuestNameInput');
  if (guestNameInput) {
    if (AUTH.isLoggedIn()) {
      guestNameInput.value = AUTH.user.username;
      guestNameInput.disabled = true;
    } else {
      guestNameInput.value = '';
      guestNameInput.disabled = false;
    }
  }

  // Check VIP Exclusive paywall lock
  const hasVipAccess = AUTH.isVip() || AUTH.isAdmin();
  if (video.isVipExclusive && !hasVipAccess) {
    // Show VIP Paywall Overlay
    player.pause();
    player.style.display = 'none';
    if (paywallOverlay) paywallOverlay.classList.remove('hidden');
  } else {
    // Normal Playback
    if (paywallOverlay) paywallOverlay.classList.add('hidden');
    player.style.display = 'block';
    player.src = video.videoUrl;
    player.play().catch(() => {});
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function renderModalTags(categories) {
  const container = document.getElementById('modalVideoTagsList');
  if (!container) return;

  const cats = Array.isArray(categories) ? categories : [categories];
  const validCats = cats.filter(c => c && c !== 'all');

  if (validCats.length === 0) {
    container.innerHTML = `<span style="color:var(--text-muted);font-size:0.82rem;">Aucun tag associé</span>`;
    return;
  }

  container.innerHTML = validCats.map(catId => {
    const found = allCategoriesList.find(c => c.id === catId);
    const catName = found ? found.name : catId;
    return `
      <span class="modal-tag-pill" onclick="closeVideoModal(); quickFilterByTag('${catId}')">
        #${catName}
      </span>
    `;
  }).join('');
}

function openAdminEditModalFromPlayingVideo() {
  if (!currentPlayingVideo) return;
  openAdminEditModal(currentPlayingVideo.id);
}

// ==================== 5-STAR RATING CONTROLLER ====================
let myActiveRating = 0;

function updateRatingUI(rating, count, videoId) {
  const scoreEl = document.getElementById('modalRatingScore');
  const countEl = document.getElementById('modalRatingCount');
  const metaRatingEl = document.getElementById('modalVideoRatingMeta');

  const rounded = (rating || 5.0).toFixed(1);
  if (scoreEl) scoreEl.textContent = rounded;
  if (countEl) countEl.textContent = `(${count || 1} avis)`;
  if (metaRatingEl) metaRatingEl.textContent = ` ${rounded} / 5 (${count || 1})`;

  // Check if user already rated this video in localStorage
  const storedRating = localStorage.getItem('rated_video_' + videoId);
  myActiveRating = storedRating ? parseInt(storedRating, 10) : Math.round(rating || 5);
  renderActiveStars(myActiveRating);
}

function renderActiveStars(val) {
  const stars = document.querySelectorAll('#modalRatingStars .star-btn');
  stars.forEach(star => {
    const starVal = parseInt(star.getAttribute('data-val'), 10);
    if (starVal <= val) {
      star.classList.add('active-star');
    } else {
      star.classList.remove('active-star');
    }
  });
}

function hoverStar(val) {
  const stars = document.querySelectorAll('#modalRatingStars .star-btn');
  stars.forEach(star => {
    const starVal = parseInt(star.getAttribute('data-val'), 10);
    if (starVal <= val) {
      star.classList.add('hovered');
    } else {
      star.classList.remove('hovered');
    }
  });
}

function resetHoverStars() {
  const stars = document.querySelectorAll('#modalRatingStars .star-btn');
  stars.forEach(star => star.classList.remove('hovered'));
  renderActiveStars(myActiveRating);
}

async function rateCurrentVideo(val) {
  if (!currentPlayingVideo) return;
  const videoId = currentPlayingVideo.id;

  try {
    const res = await fetch(`/api/videos/${videoId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: val })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la notation'));
      return;
    }

    myActiveRating = val;
    localStorage.setItem('rated_video_' + videoId, val);
    updateRatingUI(data.rating, data.ratingCount, videoId);

    // Update in local array
    currentPlayingVideo.rating = data.rating;
    currentPlayingVideo.ratingCount = data.ratingCount;
    const itemInList = (allVideosList || []).find(x => x.id === videoId);
    if (itemInList) {
      itemInList.rating = data.rating;
      itemInList.ratingCount = data.ratingCount;
    }

    showToast(data.message || `Note de ${val}/5 enregistrée !`);
  } catch (err) {
    showToast('Impossible d\'enregistrer la note.');
  }
}

// Load and Render Similar Videos in Modal
async function loadSimilarVideos(videoId) {
  const grid = document.getElementById('modalSimilarVideosGrid');
  if (!grid) return;

  grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;grid-column:1/-1;">Recherche des vidéos similaires...</div>';

  try {
    const res = await fetch(`/api/videos/${videoId}/similar`);
    const data = await res.json();
    const similar = data.similar || [];

    if (similar.length === 0) {
      grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;grid-column:1/-1;">Aucune autre vidéo similaire trouvée pour le moment.</div>';
      return;
    }

    grid.innerHTML = similar.map(v => `
      <div class="similar-video-card" onclick="openVideoPlayerModal('${v.id}')">
        <div class="similar-thumb-wrap">
          <img src="${v.thumbnail}" alt="${v.title}" class="similar-thumb-img" loading="lazy">
          <span class="video-duration-badge">${v.duration || '0:30'}</span>
        </div>
        <div class="similar-info-body">
          <span class="similar-title" title="${v.title}">${v.title}</span>
          <span class="similar-author">${v.authorName} • ${v.views || 1}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;grid-column:1/-1;">Impossible de charger les vidéos similaires.</div>';
  }
}

// Load and Render Comments for a Video
async function loadVideoComments(videoId) {
  const listEl = document.getElementById('modalCommentsList');
  const countEl = document.getElementById('modalCommentsCount');
  if (!listEl) return;

  try {
    const res = await fetch(`/api/videos/${videoId}/comments`);
    const data = await res.json();
    const comments = data.comments || [];

    if (countEl) countEl.textContent = comments.length;

    if (comments.length === 0) {
      listEl.innerHTML = `
        <div style="color:var(--text-muted);font-size:0.85rem;padding:12px 0;text-align:center;">
          Soyez le premier à commenter cette vidéo !
        </div>
      `;
      return;
    }

    const currentUserId = AUTH.user ? AUTH.user.id : null;
    const isUserAdmin = AUTH.isAdmin();

    listEl.innerHTML = comments.map(c => {
      // SEUL L'ADMINISTRATEUR PEUT SUPPRIMER UN COMMENTAIRE
      const canDelete = isUserAdmin;
      const dateStr = new Date(c.createdAt).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      return `
        <div class="comment-item" id="comment-${c.id}">
          <img src="${c.authorAvatar || 'https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(c.authorName)}" alt="${c.authorName}" class="comment-avatar" style="cursor:pointer;" onclick="openDirectMessageModal({ username: '${c.authorName}', avatar: '${c.authorAvatar || ''}' })" title="Envoyer un message à ${c.authorName}">
          <div class="comment-content">
            <div class="comment-header-row">
              <div style="display:flex;align-items:center;gap:6px;cursor:pointer;" onclick="openDirectMessageModal({ username: '${c.authorName}', avatar: '${c.authorAvatar || ''}' })" title="Envoyer un message à ${c.authorName}">
                <span class="comment-author-name">${c.authorName}</span>
                ${c.isVip ? '<span class="vip-author-badge" style="font-size:0.65rem;padding:1px 5px;">VIP</span>' : ''}
                ${c.isAdmin ? '<span class="admin-badge" style="font-size:0.65rem;padding:1px 5px;">Admin</span>' : ''}
                <span style="font-size:0.75rem;color:#60a5fa;margin-left:4px;" title="Envoyer un message">[Message]</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="comment-date">${dateStr}</span>
                ${canDelete ? `<button class="btn-delete-comment" onclick="handleDeleteComment('${c.id}')" title="Supprimer ce commentaire (Admin)">Supprimer</button>` : ''}
              </div>
            </div>
            <div class="comment-text-body">${c.text}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading comments', err);
  }
}

// Post a new comment
async function handlePostComment(e) {
  e.preventDefault();
  if (!currentPlayingVideo) return;

  const textInput = document.getElementById('commentTextInput');
  const guestNameInput = document.getElementById('commentGuestNameInput');
  const btnSubmit = document.getElementById('btnSubmitComment');

  const text = textInput ? textInput.value.trim() : '';
  const authorName = guestNameInput ? guestNameInput.value.trim() : '';

  if (!text) {
    showToast('Veuillez saisir un commentaire.');
    return;
  }

  if (btnSubmit) btnSubmit.disabled = true;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH.token) headers['Authorization'] = `Bearer ${AUTH.token}`;

    const res = await fetch(`/api/videos/${currentPlayingVideo.id}/comments`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ text, authorName })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la publication'));
      return;
    }

    showToast('Commentaire publié avec succès !');
    if (textInput) textInput.value = '';
    await loadVideoComments(currentPlayingVideo.id);
  } catch (err) {
    showToast('Erreur de publication du commentaire.');
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

// Delete a comment (Admin only)
async function handleDeleteComment(commentId) {
  if (!currentPlayingVideo) return;
  if (!AUTH.isAdmin()) {
    showToast('Seul l\'administrateur peut supprimer un commentaire.');
    return;
  }
  if (!confirm('Êtes-vous sûr de vouloir supprimer définitivement ce commentaire ?')) return;

  try {
    const headers = {};
    if (AUTH.token) headers['Authorization'] = `Bearer ${AUTH.token}`;

    const res = await fetch(`/api/videos/${currentPlayingVideo.id}/comments/${commentId}`, {
      method: 'DELETE',
      headers: headers
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la suppression'));
      return;
    }

    showToast('Supprimer Commentaire supprimé par l\'administrateur.');
    await loadVideoComments(currentPlayingVideo.id);
  } catch (err) {
    showToast('Erreur lors de la suppression.');
  }
}

// ==================== MESSAGERIE DIRECTE & TCHAT INTERNE ====================
let currentChatPartner = null;
let chatPollingTimer = null;

function openDirectMessageFromPlayingVideo() {
  if (!currentPlayingVideo) return;
  openDirectMessageModal({
    username: currentPlayingVideo.authorName,
    avatar: currentPlayingVideo.authorAvatar
  });
}

function openDirectMessageModal(partner) {
  if (!partner || !partner.username) return;

  const myUsername = AUTH.isLoggedIn() ? AUTH.user.username : 'Visiteur';
  if (AUTH.isLoggedIn() && partner.username.toLowerCase() === myUsername.toLowerCase()) {
    showToast('Vous ne pouvez pas vous envoyer un message à vous-même.');
    return;
  }

  currentChatPartner = partner;

  const modal = document.getElementById('directMessageModal');
  const nameEl = document.getElementById('chatPartnerName');
  const avatarEl = document.getElementById('chatPartnerAvatar');
  const textInput = document.getElementById('chatTextInput');

  if (nameEl) nameEl.textContent = partner.username;
  if (avatarEl) avatarEl.src = partner.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(partner.username)}`;
  if (textInput) textInput.value = '';

  if (modal) modal.classList.remove('hidden');

  loadConversationMessages(partner.username);

  // Poll for new messages every 3 seconds while chat is open
  clearInterval(chatPollingTimer);
  chatPollingTimer = setInterval(() => {
    if (currentChatPartner) {
      loadConversationMessages(currentChatPartner.username, true);
    }
  }, 3000);
}

function closeDirectMessageModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('directMessageModal');
  if (modal) modal.classList.add('hidden');
  currentChatPartner = null;
  clearInterval(chatPollingTimer);
}

async function loadConversationMessages(partnerUsername, isBackgroundPoll = false) {
  const bodyEl = document.getElementById('chatMessagesBody');
  if (!bodyEl) return;

  if (!isBackgroundPoll) {
    bodyEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px 0;">Chargement des messages...</div>';
  }

  try {
    const myName = AUTH.isLoggedIn() ? AUTH.user.username : 'Visiteur';
    const res = await fetch(`/api/messages/with/${encodeURIComponent(partnerUsername)}?username=${encodeURIComponent(myName)}`);
    const data = await res.json();
    const messages = data.messages || [];

    if (messages.length === 0) {
      bodyEl.innerHTML = `
        <div style="color:var(--text-muted);font-size:0.86rem;text-align:center;padding:30px 10px;">
          Début de votre conversation avec <strong>${partnerUsername}</strong>.<br>
          <span style="font-size:0.78rem;opacity:0.8;">Envoyez-lui un message pour démarrer la discussion !</span>
        </div>
      `;
      return;
    }

    const myLower = myName.toLowerCase();
    bodyEl.innerHTML = messages.map(m => {
      const isMe = m.senderName.toLowerCase() === myLower;
      const timeStr = new Date(m.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="chat-bubble ${isMe ? 'outgoing' : 'incoming'}">
          <span class="chat-msg-text">${m.text}</span>
          <span class="chat-time">${timeStr} ${isMe ? '' : ''}</span>
        </div>
      `;
    }).join('');

    // Scroll to bottom
    if (!isBackgroundPoll) {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  } catch (err) {
    if (!isBackgroundPoll) {
      bodyEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px 0;">Erreur de chargement.</div>';
    }
  }
}

async function handleSendChatMessage(e) {
  e.preventDefault();
  if (!currentChatPartner) return;

  const textInput = document.getElementById('chatTextInput');
  const btnSubmit = document.getElementById('btnSendChat');
  const text = textInput ? textInput.value.trim() : '';

  if (!text) return;
  if (btnSubmit) btnSubmit.disabled = true;

  try {
    const myName = AUTH.isLoggedIn() ? AUTH.user.username : 'Visiteur';
    const res = await fetch('/api/messages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH.token ? { 'Authorization': `Bearer ${AUTH.token}` } : {})
      },
      body: JSON.stringify({
        recipientUsername: currentChatPartner.username,
        text,
        senderName: myName
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de l\'envoi'));
      return;
    }

    if (textInput) textInput.value = '';
    await loadConversationMessages(currentChatPartner.username);
  } catch (err) {
    showToast('Erreur de transmission du message.');
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

// Open Inbox / Conversations List
async function openConversationsModal() {
  const modal = document.getElementById('conversationsModal');
  if (modal) modal.classList.remove('hidden');
  await loadConversationsList();
}

function closeConversationsModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('conversationsModal');
  if (modal) modal.classList.add('hidden');
}

async function loadConversationsList() {
  const container = document.getElementById('conversationsListContainer');
  if (!container) return;

  container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px 0;">Chargement des conversations...</div>';

  try {
    const myName = AUTH.isLoggedIn() ? AUTH.user.username : 'Visiteur';
    const res = await fetch(`/api/messages/conversations?username=${encodeURIComponent(myName)}`);
    const data = await res.json();
    const conversations = data.conversations || [];

    if (conversations.length === 0) {
      container.innerHTML = `
        <div style="color:var(--text-muted);font-size:0.88rem;text-align:center;padding:36px 16px;">
          Aucune conversation pour le moment.<br>
          <span style="font-size:0.8rem;margin-top:6px;display:inline-block;">Cliquez sur l'auteur d'une vidéo ou d'un commentaire pour démarrer une discussion !</span>
        </div>
      `;
      return;
    }

    container.innerHTML = conversations.map(conv => {
      const timeStr = new Date(conv.lastMessageTime).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      return `
        <div class="conversation-item" onclick="closeConversationsModal(); openDirectMessageModal({ username: '${conv.partnerName}', avatar: '${conv.partnerAvatar}' })">
          <img src="${conv.partnerAvatar}" alt="${conv.partnerName}" class="conv-avatar">
          <div class="conv-info">
            <div class="conv-header">
              <span class="conv-name">${conv.partnerName}</span>
              <span class="conv-time">${timeStr}</span>
            </div>
            <span class="conv-last-msg">${conv.lastMessage}</span>
          </div>
          ${conv.unreadCount > 0 ? `<span class="conv-unread-pill">${conv.unreadCount}</span>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px 0;">Impossible de charger les conversations.</div>';
  }
}

function closeVideoModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn') && !e.target.closest('.modal-back-btn') && !e.target.closest('.modal-close-btn-simple')) {
    return;
  }
  const modal = document.getElementById('videoModal');
  const player = document.getElementById('modalVideoPlayer');
  const paywallOverlay = document.getElementById('vipPaywallOverlay');
  if (player) {
    player.pause();
    player.src = '';
    player.style.display = 'block';
  }
  if (paywallOverlay) paywallOverlay.classList.add('hidden');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  currentPlayingVideo = null;
}

async function shareCurrentVideo() {
  if (!currentPlayingVideo) return;
  const url = `${window.location.origin}/?video=${encodeURIComponent(currentPlayingVideo.id)}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: currentPlayingVideo.title || 'Vidéo sur VideoHub',
        text: `Regardez "${currentPlayingVideo.title || 'cette vidéo'}" sur VideoHub`,
        url: url
      });
      return;
    } catch (e) {}
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien de la vidéo copié dans le presse-papier !');
      return;
    } catch (e) {}
  }
  prompt('Copiez le lien de la vidéo :', url);
}

async function likeCurrentVideo() {
  if (!currentPlayingVideo) return;
  try {
    const res = await fetch(`/api/videos/${currentPlayingVideo.id}/like`, { method: 'POST' });
    const data = await res.json();
    document.getElementById('modalLikesCount').textContent = data.likes;
    currentPlayingVideo.likes = data.likes;

    if (data.isVipExclusive) {
      currentPlayingVideo.isVipExclusive = true;
    }
    
    const found = allVideosList.find(v => v.id === currentPlayingVideo.id);
    if (found) {
      found.likes = data.likes;
      if (data.isVipExclusive) found.isVipExclusive = true;
    }
    renderVideoGrid(allVideosList);

    if (data.convertedToVip) {
      showToast("Cette vidéo a atteint 5 mentions J'aime et est désormais passée en Contenu Exclusif VIP !");
      openVideoPlayerModal(currentPlayingVideo.id);
    } else {
      showToast('Mention J\'aime ajoutée !');
    }
  } catch (err) {
    console.error(err);
  }
}


// ==================== VIP ACCORDION DÉPLIABLE ====================
function toggleVipPerks() {
  const body = document.getElementById('vipPerksBody');
  const arrow = document.getElementById('vipPerksArrow');
  if (!body) return;

  const isOpen = body.classList.contains('open');
  if (isOpen) {
    body.classList.remove('open');
    if (arrow) arrow.style.transform = 'rotate(0deg)';
  } else {
    body.classList.add('open');
    if (arrow) arrow.style.transform = 'rotate(180deg)';
  }
}

// ==================== ADMIN PANEL (Shop Ton Partiel Inspired) ====================
// ==================== ADMIN PANEL (Shop Ton Partiel Inspired) ====================
function switchAdminSection(sec) {
  const tabs = ['videos', 'online', 'reports', 'messages', 'reviews', 'categories', 'users', 'logs', 'emails'];
  tabs.forEach(t => {
    const btn = document.getElementById(`adminTab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    const secEl = document.getElementById(`adminSection${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (btn) btn.classList.toggle('active', t === sec);
    if (secEl) secEl.classList.toggle('hidden', t !== sec);
  });

  if (sec === 'videos') loadAdminVideos();
  if (sec === 'online') loadAdminOnlineVideos();
  if (sec === 'reports') loadAdminReports();
  if (sec === 'messages') loadAdminMessages();
  if (sec === 'reviews') loadAdminReviews();
  if (sec === 'categories') renderAdminCategoriesManager();
  if (sec === 'users') loadAdminUsers();
  if (sec === 'logs') loadAdminStats();
  if (sec === 'emails') initAdminEmailTester();
}

// ---------------- ADMIN REPORTS MANAGEMENT (SHOP TON PARTIEL STYLE) ----------------
let currentAdminReportsFilter = 'pending';
let allAdminReports = [];

function setAdminReportsFilter(filter) {
  currentAdminReportsFilter = filter;
  ['pending', 'all', 'resolved'].forEach(f => {
    const b = document.getElementById(`filterReports${f.charAt(0).toUpperCase() + f.slice(1)}Btn`);
    if (b) b.classList.toggle('active', f === filter);
  });
  renderAdminReports();
}

async function loadAdminReports() {
  if (!AUTH.isAdmin()) return;
  const container = document.getElementById('adminReportsList');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Chargement des signalements...</div>';

  try {
    const res = await fetch('/api/admin/reports', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    const data = await res.json();
    allAdminReports = data.reports || [];

    const pendingCount = allAdminReports.filter(r => r.status === 'pending').length;
    const resolvedCount = allAdminReports.filter(r => r.status === 'resolved' || r.status === 'dismissed').length;

    const countPendingEl = document.getElementById('reportCountPending');
    const countAllEl = document.getElementById('reportCountAll');
    const countResolvedEl = document.getElementById('reportCountResolved');
    const adminRepText = document.getElementById('adminReportsCountText');
    const statPendingRep = document.getElementById('statPendingReports');

    if (countPendingEl) countPendingEl.textContent = pendingCount;
    if (countAllEl) countAllEl.textContent = allAdminReports.length;
    if (countResolvedEl) countResolvedEl.textContent = resolvedCount;
    if (adminRepText) adminRepText.textContent = pendingCount;
    if (statPendingRep) statPendingRep.textContent = pendingCount;

    renderAdminReports();
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:#ef4444;">Erreur lors du chargement des signalements.</div>';
  }
}

function renderAdminReports() {
  const container = document.getElementById('adminReportsList');
  if (!container) return;

  let list = allAdminReports;
  if (currentAdminReportsFilter === 'pending') {
    list = allAdminReports.filter(r => r.status === 'pending');
  } else if (currentAdminReportsFilter === 'resolved') {
    list = allAdminReports.filter(r => r.status === 'resolved' || r.status === 'dismissed');
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="background:var(--bg-card);border:1px dashed var(--border-color);border-radius:12px;padding:60px 20px;text-align:center;">
        <p style="color:var(--text-muted);font-size:1rem;margin:0;">Aucun signalement ${currentAdminReportsFilter === 'pending' ? 'en attente' : 'dans cette sélection'}.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(r => {
    const isPending = r.status === 'pending';
    const isResolved = r.status === 'resolved';
    const statusColor = isPending ? '#ef4444' : (isResolved ? '#10b981' : '#94a3b8');
    const statusLabel = isPending ? 'En attente d action' : (isResolved ? 'Traite / Resolu' : 'Classe sans suite');
    const formattedDate = new Date(r.createdAt).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    return `
      <div style="background:var(--bg-card);border:1px solid ${isPending ? '#ef4444' : 'var(--border-color)'};border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">
                ${statusLabel}
              </span>
              <span style="background:rgba(249,115,22,0.1);color:var(--primary);border:1px solid rgba(249,115,22,0.3);padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">
                ${r.reason}
              </span>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;">
              Recu le ${formattedDate} • ID: ${r.id}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            ${isPending ? `
              <button class="btn btn-sm btn-danger" onclick="handleAdminDeleteReportVideo('${r.id}')" title="Supprimer definitivement la video signalee">
                Supprimer la video
              </button>
              <button class="btn btn-sm" style="background:#10b981;color:#fff;" onclick="handleAdminResolveReport('${r.id}')" title="Marquer le signalement comme resolu">
                Marquer comme traite
              </button>
              <button class="btn btn-sm btn-secondary" onclick="handleAdminDismissReport('${r.id}')" title="Classer sans suite">
                Classer sans suite
              </button>
            ` : `
              <span style="font-size:0.8rem;color:#10b981;font-weight:700;">Dossier cloture</span>
            `}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;">
          <div>
            <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;">Signaleur</div>
            <div style="font-size:0.88rem;font-weight:700;color:var(--text-main);margin-top:2px;">${r.fullName}</div>
            <div style="font-size:0.8rem;margin-top:2px;">
              <a href="mailto:${r.email}?subject=Concernant votre signalement sur VideoHub" style="color:var(--primary);text-decoration:none;">
                ${r.email}
              </a>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">Signature : <em>${r.signature}</em></div>
          </div>

          <div>
            <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;">Video signalee</div>
            <div style="font-size:0.88rem;font-weight:700;color:var(--text-main);margin-top:2px;">
              ${r.videoTitle || 'Lien fourni ci-dessous'}
            </div>
            <div style="font-size:0.8rem;margin-top:4px;word-break:break-all;">
              <a href="${r.videoUrl}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
                Ouvrir la video
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            </div>
          </div>
        </div>

        <div>
          <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Description des faits</div>
          <div style="font-size:0.85rem;color:var(--text-main);line-height:1.5;background:var(--bg-main);border:1px solid var(--border-color);border-radius:6px;padding:10px 12px;white-space:pre-wrap;">${r.details || 'Aucune description additionnelle fournie.'}</div>
        </div>

        ${r.actionTaken ? `
          <div style="font-size:0.78rem;color:#10b981;background:rgba(16,185,129,0.1);padding:6px 12px;border-radius:6px;border:1px solid rgba(16,185,129,0.25);">
            Action effectuee : ${r.actionTaken} (le ${new Date(r.resolvedAt).toLocaleDateString('fr-FR')})
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function handleAdminDeleteReportVideo(reportId) {
  if (!confirm('Confirmez-vous la suppression de la video signalee ? Cette action est irreversible.')) return;
  try {
    const res = await fetch(`/api/admin/reports/${reportId}/delete-video`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur'); return; }
    showToast(data.message || 'Video supprimee et signalement resolu.');
    loadAdminReports();
    loadAdminStats();
  } catch (e) {
    showToast('Erreur de communication.');
  }
}

async function handleAdminResolveReport(reportId) {
  try {
    const res = await fetch(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur'); return; }
    showToast('Signalement marque comme traite.');
    loadAdminReports();
    loadAdminStats();
  } catch (e) {
    showToast('Erreur de communication.');
  }
}

async function handleAdminDismissReport(reportId) {
  try {
    const res = await fetch(`/api/admin/reports/${reportId}/dismiss`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur'); return; }
    showToast('Signalement classe sans suite.');
    loadAdminReports();
    loadAdminStats();
  } catch (e) {
    showToast('Erreur de communication.');
  }
}

// ---------------- ADMIN MESSAGES MANAGEMENT ----------------
async function loadAdminMessages() {
  if (!AUTH.isAdmin()) return;
  const container = document.getElementById('adminMessagesList');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Chargement des messages...</div>';

  try {
    const res = await fetch('/api/admin/messages', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    const data = await res.json();
    const messages = data.messages || [];
    window.adminMessagesList = messages;

    const badgeEl = document.getElementById('adminMessagesCountText');
    const statEl = document.getElementById('statTotalMessages');
    if (badgeEl) badgeEl.textContent = messages.length;
    if (statEl) statEl.textContent = messages.length;

    if (messages.length === 0) {
      container.innerHTML = `
        <div style="background:var(--bg-card);border:1px dashed var(--border-color);border-radius:12px;padding:60px 20px;text-align:center;">
          <p style="color:var(--text-muted);font-size:1rem;margin:0;">Aucun message recu via le formulaire de contact.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = messages.map(m => `
      <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:0.95rem;font-weight:700;color:var(--text-main);">${m.subject || 'Sans objet'}</span>
              ${m.replied ? '<span style="background:rgba(16,185,129,0.15);color:#10b981;font-size:0.72rem;padding:2px 8px;border-radius:12px;font-weight:700;">Répondu</span>' : ''}
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">
              De : <strong>${m.name}</strong> (<a href="mailto:${m.email}" style="color:var(--primary);">${m.email}</a>) • ${new Date(m.createdAt).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-sm btn-primary" onclick="openAdminReplyMessageModal('${m.id}')">
              ${m.replied ? 'Répondre à nouveau' : 'Répondre'}
            </button>
            <button class="btn btn-sm btn-danger-outline" onclick="handleAdminDeleteMessage('${m.id}')" style="border:1px solid #ef4444;color:#ef4444;background:transparent;">
              Supprimer
            </button>
          </div>
        </div>
        <div style="background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;font-size:0.86rem;color:var(--text-main);line-height:1.5;white-space:pre-wrap;">${m.message}</div>
        ${m.replied && m.lastReplyText ? `
          <div style="background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.25);border-radius:8px;padding:10px 14px;font-size:0.84rem;color:var(--text-main);">
            <div style="font-size:0.75rem;color:var(--primary);font-weight:700;margin-bottom:4px;">
              Dernière réponse envoyée (${m.repliedAt ? new Date(m.repliedAt).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : ''}) :
            </div>
            <div style="white-space:pre-wrap;line-height:1.4;">${m.lastReplyText}</div>
          </div>
        ` : ''}
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:#ef4444;">Erreur lors du chargement des messages.</div>';
  }
}

function openAdminReplyMessageModal(msgId) {
  const messages = window.adminMessagesList || [];
  const msg = messages.find(m => m.id === msgId);
  if (!msg) {
    showToast('Message introuvable.');
    return;
  }

  const modal = document.getElementById('adminReplyMessageModal');
  const targetIdInput = document.getElementById('replyTargetMsgId');
  const recipientEl = document.getElementById('replyTargetRecipientText');
  const subjectEl = document.getElementById('replyTargetSubjectText');
  const originalEl = document.getElementById('replyTargetOriginalText');
  const subjectInput = document.getElementById('replySubjectInput');
  const textInput = document.getElementById('replyTextInput');

  if (targetIdInput) targetIdInput.value = msg.id;
  if (recipientEl) recipientEl.textContent = `${msg.name} <${msg.email}>`;
  if (subjectEl) subjectEl.textContent = msg.subject || 'Sans objet';
  if (originalEl) originalEl.textContent = msg.message || '';
  if (subjectInput) subjectInput.value = `Re: ${msg.subject || 'Votre message sur VideoHub'}`;
  if (textInput) textInput.value = '';

  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { if (textInput) textInput.focus(); }, 100);
  }
}

function closeAdminReplyModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('adminReplyMessageModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

async function handleSendAdminReply(e) {
  if (e) e.preventDefault();
  const msgId = document.getElementById('replyTargetMsgId')?.value;
  const replySubject = document.getElementById('replySubjectInput')?.value?.trim();
  const replyText = document.getElementById('replyTextInput')?.value?.trim();
  const btn = document.getElementById('btnSubmitAdminReply');

  if (!msgId || !replyText) {
    showToast('Veuillez saisir votre réponse.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Envoi en cours...';
  }

  try {
    const res = await fetch(`/api/admin/messages/${encodeURIComponent(msgId)}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({ replySubject, replyText })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Erreur lors de l'envoi de la réponse.");
      return;
    }

    showToast(data.message || 'Réponse envoyée avec succès.');
    closeAdminReplyModal();
    loadAdminMessages();
  } catch (err) {
    showToast('Erreur de communication.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Envoyer la réponse par e-mail';
    }
  }
}

async function handleAdminDeleteMessage(msgId) {
  if (!confirm('Supprimer ce message ?')) return;
  try {
    const res = await fetch(`/api/admin/messages/${msgId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    showToast('Message supprime.');
    loadAdminMessages();
    loadAdminStats();
  } catch (e) {
    showToast('Erreur lors de la suppression.');
  }
}

// ---------------- ADMIN REVIEWS MANAGEMENT ----------------
async function loadAdminReviews() {
  if (!AUTH.isAdmin()) return;
  const container = document.getElementById('adminReviewsList');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Chargement des avis et commentaires...</div>';

  try {
    const res = await fetch('/api/admin/reviews', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    const data = await res.json();
    const reviews = data.reviews || [];

    const badgeEl = document.getElementById('adminReviewsCountText');
    if (badgeEl) badgeEl.textContent = reviews.length;

    if (reviews.length === 0) {
      container.innerHTML = `
        <div style="background:var(--bg-card);border:1px dashed var(--border-color);border-radius:12px;padding:60px 20px;text-align:center;">
          <p style="color:var(--text-muted);font-size:1rem;margin:0;">Aucun commentaire ou avis poste sur les videos.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = reviews.map(c => `
      <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <img src="${c.videoThumbnail || 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=300'}" style="width:70px;height:45px;object-fit:cover;border-radius:6px;flex-shrink:0;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong style="font-size:0.86rem;color:var(--text-main);">${c.authorName || c.userName || 'Utilisateur'}</strong>
            <span style="font-size:0.75rem;color:var(--text-muted);">sur "${c.videoTitle || 'Video'}"</span>
            <span style="font-size:0.72rem;color:var(--text-muted);">${new Date(c.createdAt).toLocaleDateString('fr-FR')}</span>
          </div>
          <p style="font-size:0.84rem;color:var(--text-main);margin:4px 0 0;line-height:1.4;">${c.text || c.comment || ''}</p>
        </div>
        <button class="btn btn-sm btn-danger-outline" onclick="handleAdminDeleteReview('${c.videoId}', '${c.id}')" style="border:1px solid #ef4444;color:#ef4444;background:transparent;">
          Supprimer
        </button>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:#ef4444;">Erreur lors du chargement des avis.</div>';
  }
}

async function handleAdminDeleteReview(videoId, commentId) {
  if (!confirm('Supprimer ce commentaire ?')) return;
  try {
    const res = await fetch(`/api/admin/reviews/${videoId}/${commentId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    showToast('Commentaire supprime.');
    loadAdminReviews();
    loadAdminStats();
  } catch (e) {
    showToast('Erreur lors de la suppression.');
  }
}

// ---------------- ADMIN ONLINE VIDEOS MANAGEMENT ----------------
let allAdminOnlineVideos = [];

async function loadAdminOnlineVideos() {
  if (!AUTH.isAdmin()) return;
  const container = document.getElementById('adminOnlineVideosList');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Chargement des videos en ligne...</div>';

  try {
    const res = await fetch('/api/admin/videos?status=approved', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) throw new Error('Erreur');
    const data = await res.json();
    allAdminOnlineVideos = data.videos || [];

    const badgeEl = document.getElementById('adminOnlineCountText');
    const statEl = document.getElementById('statApprovedVideos');
    if (badgeEl) badgeEl.textContent = allAdminOnlineVideos.length;
    if (statEl) statEl.textContent = allAdminOnlineVideos.length;

    renderAdminOnlineVideos(allAdminOnlineVideos);
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:#ef4444;">Erreur lors du chargement des videos en ligne.</div>';
  }
}

function filterAdminOnlineVideos() {
  const query = (document.getElementById('adminOnlineSearchInput')?.value || '').toLowerCase().trim();
  if (!query) {
    renderAdminOnlineVideos(allAdminOnlineVideos);
    return;
  }
  const filtered = allAdminOnlineVideos.filter(v =>
    (v.title && v.title.toLowerCase().includes(query)) ||
    (v.authorName && v.authorName.toLowerCase().includes(query)) ||
    (v.region && v.region.toLowerCase().includes(query))
  );
  renderAdminOnlineVideos(filtered);
}

function renderAdminOnlineVideos(videos) {
  const container = document.getElementById('adminOnlineVideosList');
  if (!container) return;

  if (videos.length === 0) {
    container.innerHTML = `
      <div style="background:var(--bg-card);border:1px dashed var(--border-color);border-radius:12px;padding:60px 20px;text-align:center;">
        <p style="color:var(--text-muted);font-size:1rem;margin:0;">Aucune video en ligne trouvee.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = videos.map(v => `
    <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <img src="${v.thumbnail || 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=300'}" style="width:110px;height:70px;object-fit:cover;border-radius:8px;cursor:pointer;" onclick="openVideoPlayerModal('${v.id}')">
      <div style="flex:1;min-width:220px;">
        <h4 style="margin:0 0 4px;font-size:0.95rem;color:var(--text-main);">${v.title}</h4>
        <div style="font-size:0.78rem;color:var(--text-muted);display:flex;gap:8px;flex-wrap:wrap;">
          <span>Par <strong>${v.authorName}</strong></span>
          <span>• ${v.region || 'France'}</span>
          <span>• ${(v.views||0).toLocaleString()} vues</span>
          <span>• ${v.likes||0} likes</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-sm btn-secondary" onclick="openVideoPlayerModal('${v.id}')">Voir</button>
        <button class="btn btn-sm btn-secondary" onclick="openAdminEditModal('${v.id}')">Modifier</button>
        <button class="btn btn-sm btn-danger" onclick="handleAdminDeleteVideo('${v.id}')">Supprimer</button>
      </div>
    </div>
  `).join('');
}


function initAdminEmailTester() {
  const input = document.getElementById('adminTestEmailTargetInput');
  if (input && (!input.value || !input.value.trim())) {
    if (AUTH.user && AUTH.user.email) {
      input.value = AUTH.user.email;
    } else {
      input.value = 'ia.project.pro2k26@gmail.com';
    }
  }
}

function checkAllTestEmails() {
  document.querySelectorAll('input[name="testEmailTpl"]').forEach(cb => {
    cb.checked = true;
  });
}

function uncheckAllTestEmails() {
  document.querySelectorAll('input[name="testEmailTpl"]').forEach(cb => {
    cb.checked = false;
  });
}

async function sendSelectedTestEmails() {
  if (!AUTH.isAdmin()) {
    showToast('Action réservée aux administrateurs.');
    return;
  }

  const selectedCbs = Array.from(document.querySelectorAll('input[name="testEmailTpl"]:checked'));
  const templateKeys = selectedCbs.map(cb => cb.value);
  const targetEmail = (document.getElementById('adminTestEmailTargetInput')?.value || '').trim();
  const btn = document.getElementById('btnSendSelectedTestEmails');

  if (templateKeys.length === 0) {
    showToast("Veuillez cocher au moins un modèle d'e-mail.");
    return;
  }

  if (!targetEmail || !targetEmail.includes('@')) {
    showToast('Veuillez renseigner une adresse e-mail valide.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = `Envoi de ${templateKeys.length} e-mail(s)...`;
  }

  try {
    const res = await fetch('/api/admin/test-emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({
        toEmail: targetEmail,
        templateKeys: templateKeys
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Erreur lors de l'envoi des e-mails.");
      return;
    }

    showToast(data.message || `${templateKeys.length} e-mail(s) de test envoyé(s) avec succès !`);
  } catch (err) {
    showToast("Erreur de connexion lors de l'envoi.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Envoyer les e-mails sélectionnés';
    }
  }
}

function filterAdminVideosFromKpi(status) {
  switchAdminSection('videos');
  const sel = document.getElementById('adminVideoStatusFilter');
  if (sel) {
    sel.value = status;
  }
  loadAdminVideos();
}

async function loadAdminStats() {
  if (!AUTH.isAdmin()) return;
  try {
    const res = await fetch('/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) return;
    const stats = await res.json();

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setVal('statPendingVideos', stats.pendingVideos || 0);
    setVal('statApprovedVideos', stats.approvedVideos || 0);
    setVal('statPendingReports', stats.pendingReports || 0);
    setVal('statTotalMessages', stats.totalMessages || 0);
    setVal('statTotalUsers', stats.totalUsers || 0);
    setVal('statTotalVips', stats.totalVips || 0);
    setVal('statTotalCategories', stats.totalCategories || 0);
    setVal('statTotalViews', (stats.totalViews || 0).toLocaleString());

    setVal('sidebarPendingBadge', stats.pendingVideos || 0);
    setVal('adminPendingCountText', stats.pendingVideos || 0);
    setVal('adminOnlineCountText', stats.approvedVideos || 0);
    setVal('adminReportsCountText', stats.pendingReports || 0);
    setVal('adminMessagesCountText', stats.totalMessages || 0);
    setVal('adminReviewsCountText', stats.totalComments || 0);
    setVal('reportCountPending', stats.pendingReports || 0);

    const logsContainer = document.getElementById('adminLogsContainer');
    if (logsContainer && stats.logs) {
      if (stats.logs.length === 0) {
        logsContainer.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">Aucun événement récent enregistré.</p>`;
      } else {
        logsContainer.innerHTML = stats.logs.map(log => `
          <div class="admin-log-item">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="log-action-badge">${log.action}</span>
              <span>${log.details}</span>
            </div>
            <span class="log-date">${new Date(log.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Error loading admin stats', err);
  }
}

let adminSearchTimer = null;
function debounceAdminVideoSearch() {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    loadAdminVideos();
  }, 250);
}

async function loadAdminVideos() {
  if (!AUTH.isAdmin()) return;
  const listContainer = document.getElementById('adminVideosList');
  if (!listContainer) return;

  const status = document.getElementById('adminVideoStatusFilter')?.value || 'pending';
  const category = document.getElementById('adminVideoCategoryFilter')?.value || 'all';
  const search = document.getElementById('adminVideoSearchInput')?.value || '';

  try {
    let url = `/api/admin/videos?status=${status}&category=${category}`;
    if (search.trim()) url += `&search=${encodeURIComponent(search.trim())}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    const list = data.videos || [];
    window.adminVideosList = list;

    if (list.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align:center;padding:34px;background:#f8fafc;border-radius:12px;border:1px dashed var(--border-color);">
          <p style="font-weight:700;color:var(--text-muted);">Aucune vidéo ne correspond à ce filtre.</p>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = list.map(v => {
      const cats = (v.categories && Array.isArray(v.categories) && v.categories.length > 0) ? v.categories : [v.category];
      return `
        <div class="pending-card">
          <div class="pending-thumb-wrap" onclick="openAdminEditModal('${v.id}')" style="cursor:pointer;" title="Cliquer pour changer la miniature de cette vidéo">
            <img src="${v.thumbnail}" alt="${v.title}">
            <div class="thumb-play-mini" title="Changer la miniature">
              
            </div>
          </div>

          <div class="pending-info">
            <div class="pending-title-row">
              <h4 style="cursor:pointer;" onclick="openVideoPlayerModal('${v.id}')">${v.title}</h4>
              <span class="badge-views-pill" title="Nombre total de vues">${(v.views || 0).toLocaleString()} vues</span>
              <span class="badge-status-pill ${v.status}">${v.status === 'approved' ? 'Validé' : 'En attente'}</span>
              ${v.isVipExclusive ? '<span class="vip-author-badge" style="background:#f59e0b;color:#000;font-weight:800;">VIP EXCLUSIF</span>' : ''}
              ${v.isVipAuthor ? '<span class="vip-author-badge">Auteur VIP</span>' : ''}
            </div>
            <div class="pending-meta">
              <span><strong>${v.authorEmail || v.authorName}</strong></span> • 
              <span>${v.region || 'France'}</span> • 
              <span style="color:var(--primary);font-weight:700;">${(v.views || 0).toLocaleString()} vues</span> • 
              <span>${v.likes || 0} likes</span> • 
              <span>${cats.map(c => `#${c}`).join(', ')}</span> • 
              <span>${new Date(v.createdAt).toLocaleDateString()}</span>
            </div>
            <p class="pending-desc">${v.description || 'Aucune description rédigée.'}</p>
          </div>

          <div class="pending-actions">
            ${v.status === 'pending' ? `
              <button class="btn btn-sm btn-success" onclick="approveVideo('${v.id}')">Valider</button>
            ` : ''}
            <button class="btn btn-sm ${v.isDailyFeatured ? 'btn-warning' : 'btn-secondary'}" onclick="toggleDailyFeatured('${v.id}')" title="Mettre en avant sur la page d'accueil">
              ${v.isDailyFeatured ? 'Retirer du Jour' : 'Sélection du Jour'}
            </button>
            <button class="btn btn-sm ${v.isVipExclusive ? 'btn-vip-pill' : 'btn-secondary'}" onclick="toggleAdminVipExclusive('${v.id}')" title="Bascule VIP Exclusif">
              ${v.isVipExclusive ? 'Exclusif VIP' : 'Passer en VIP'}
            </button>
            <button class="btn btn-sm btn-secondary" onclick="openAdminEditModal('${v.id}')" style="border-color:var(--primary);color:var(--primary);font-weight:700;">
              Miniature & Éditer
            </button>
            <button class="btn btn-sm btn-danger" onclick="rejectVideo('${v.id}')">Supprimer</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
  }
}

async function toggleAdminVipExclusive(id) {
  try {
    const res = await fetch(`/api/admin/videos/${id}/toggle-vip-exclusive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    showToast(data.message || 'Statut VIP mis à jour.');
    await loadAdminVideos();
    await loadVideos();
  } catch (err) {
    console.error(err);
    showToast('Erreur lors de la modification du statut VIP.');
  }
}

async function toggleDailyFeatured(id) {
  try {
    const res = await fetch(`/api/admin/videos/${id}/toggle-daily`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    showToast(data.message || 'Sélection mise à jour.');
    await loadAdminVideos();
    await loadVideos();
  } catch (err) {
    showToast('Erreur de mise à jour.');
  }
}

async function approveVideo(id) {
  try {
    const res = await fetch(`/api/admin/videos/${id}/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    showToast(data.message || 'Vidéo validée.');
    await loadAdminStats();
    await loadAdminVideos();
    await loadVideos();
    if (typeof loadExplorerData === 'function') loadExplorerData();
  } catch (err) {
    showToast('Erreur de validation.');
  }
}

async function rejectVideo(id) {
  if (!confirm('Confirmer le refus et la suppression définitive de cette vidéo ?')) return;
  try {
    const res = await fetch(`/api/admin/videos/${id}/reject`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    showToast(data.message || 'Vidéo supprimée.');
    await loadAdminStats();
    await loadAdminVideos();
    await loadVideos();
    if (typeof loadExplorerData === 'function') loadExplorerData();
  } catch (err) {
    showToast('Erreur.');
  }
}

// Edit video modal with live video frame capture & thumbnail studio
window._adminExtractedSnapshots = [];

async function openAdminEditModal(videoId) {
  let v = (allVideosList || []).find(item => item.id === videoId);
  if (!v && window.adminVideosList) {
    v = window.adminVideosList.find(item => item.id === videoId);
  }
  if (!v && typeof allAdminOnlineVideos !== 'undefined') {
    v = allAdminOnlineVideos.find(item => item.id === videoId);
  }
  if (!v && currentPlayingVideo && currentPlayingVideo.id === videoId) {
    v = currentPlayingVideo;
  }
  if (!v) {
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}`);
      if (res.ok) {
        const data = await res.json();
        v = data.video;
      }
    } catch (e) {}
  }
  if (!v) {
    showToast('Vidéo introuvable pour la modification.');
    return;
  }

  document.getElementById('editVideoId').value = v.id;
  document.getElementById('editVideoTitle').value = v.title;
  document.getElementById('editVideoDesc').value = v.description || '';

  // Setup current thumbnail preview
  const thumbHiddenInput = document.getElementById('editVideoSelectedThumbnail');
  const thumbPreviewImg = document.getElementById('adminCurrentThumbPreview');
  const thumbStatusBadge = document.getElementById('adminThumbStatusBadge');
  if (thumbHiddenInput) thumbHiddenInput.value = v.thumbnail || '';
  if (thumbPreviewImg) thumbPreviewImg.src = v.thumbnail || '';
  if (thumbStatusBadge) thumbStatusBadge.textContent = 'Miniature actuelle';

  // Load video player for frame grabbing
  const scrubberVideo = document.getElementById('adminScrubVideoPlayer');
  if (scrubberVideo) {
    scrubberVideo.src = v.videoUrl;
    scrubberVideo.load();
  }

  // Generate automated frame captures from the video
  generateAdminVideoThumbnails(v.videoUrl);

  const editCatsContainer = document.getElementById('editVideoCategoriesMultiSelect');
  const availableCats = allCategoriesList.filter(c => c.id !== 'all');
  const videoCats = (v.categories && Array.isArray(v.categories)) ? v.categories : [v.category];

  if (editCatsContainer) {
    editCatsContainer.innerHTML = availableCats.map(cat => {
      const isChecked = videoCats.includes(cat.id);
      return `
        <label class="multi-cat-item ${isChecked ? 'selected' : ''}" id="editCat_label_${cat.id}">
          <input type="checkbox" value="${cat.id}" ${isChecked ? 'checked' : ''} onchange="toggleCatCheckboxStyle(this, 'editCat')">
          <span>${cat.name}</span>
        </label>
      `;
    }).join('');
  }

  const modal = document.getElementById('adminEditVideoModal');
  if (modal) modal.classList.remove('hidden');
}
window.openEditVideoModal = openAdminEditModal;

function closeAdminEditModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('adminEditVideoModal');
  const scrubberVideo = document.getElementById('adminScrubVideoPlayer');
  if (scrubberVideo) {
    scrubberVideo.pause();
    scrubberVideo.src = '';
  }
  if (modal) modal.classList.add('hidden');
}

// Extract 4 high quality candidate frames from video for admin
async function generateAdminVideoThumbnails(videoUrl) {
  const gallery = document.getElementById('adminThumbGalleryGrid');
  if (!gallery) return;

  gallery.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;grid-column:1/-1;">Extraction des captures de la vidéo en cours...</div>';

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = videoUrl;

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
      gallery.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;grid-column:1/-1;">Utilisez le lecteur ci-dessus pour capturer une miniature à la seconde voulue.</div>';
      return;
    }

    window._adminExtractedSnapshots = snapshots;

    gallery.innerHTML = snapshots.map((s, idx) => `
      <div class="admin-thumb-item" onclick="selectAdminSuggestedThumbnail(${idx})" id="adminSnapItem-${idx}">
        <img src="${s.dataUrl}" alt="Capture ${idx + 1}" class="admin-thumb-img">
        <span class="admin-thumb-badge">Capture ${idx + 1}</span>
      </div>
    `).join('');
  };
}

// Capture currently displayed frame on admin video scrubber
function captureAdminVideoCurrentFrame() {
  const video = document.getElementById('adminScrubVideoPlayer');
  if (!video || !video.videoWidth) {
    showToast('Lancez la lecture de la vidéo ou mettez-la sur pause pour capturer l\'image.');
    return;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

    const thumbHiddenInput = document.getElementById('editVideoSelectedThumbnail');
    const thumbPreviewImg = document.getElementById('adminCurrentThumbPreview');
    const thumbStatusBadge = document.getElementById('adminThumbStatusBadge');

    if (thumbHiddenInput) thumbHiddenInput.value = dataUrl;
    if (thumbPreviewImg) thumbPreviewImg.src = dataUrl;
    if (thumbStatusBadge) thumbStatusBadge.textContent = 'Nouvelle capture prête !';

    document.querySelectorAll('.admin-thumb-item').forEach(el => el.classList.remove('active'));

    const curTime = Math.floor(video.currentTime);
    const min = Math.floor(curTime / 60);
    const sec = curTime % 60;
    const timeStr = `${min}:${sec < 10 ? '0' : ''}${sec}`;

    showToast(`Capture d'écran effectuée avec succès à ${timeStr} !`);
  } catch (e) {
    showToast('Impossible de capturer cette image.');
  }
}

// Select a suggested frame
function selectAdminSuggestedThumbnail(idx) {
  if (!window._adminExtractedSnapshots || !window._adminExtractedSnapshots[idx]) return;
  const snap = window._adminExtractedSnapshots[idx];

  const thumbHiddenInput = document.getElementById('editVideoSelectedThumbnail');
  const thumbPreviewImg = document.getElementById('adminCurrentThumbPreview');
  const thumbStatusBadge = document.getElementById('adminThumbStatusBadge');

  if (thumbHiddenInput) thumbHiddenInput.value = snap.dataUrl;
  if (thumbPreviewImg) thumbPreviewImg.src = snap.dataUrl;
  if (thumbStatusBadge) thumbStatusBadge.textContent = `Capture ${idx + 1} sélectionnée `;

  document.querySelectorAll('.admin-thumb-item').forEach((el, i) => {
    if (i === idx) el.classList.add('active');
    else el.classList.remove('active');
  });

  showToast(`Miniature n°${idx + 1} sélectionnée !`);
}

async function saveAdminVideoEdit(e) {
  e.preventDefault();
  const id = document.getElementById('editVideoId').value;
  const title = document.getElementById('editVideoTitle').value.trim();
  const description = document.getElementById('editVideoDesc').value.trim();
  const thumbnail = (document.getElementById('editVideoSelectedThumbnail')?.value || '').trim();

  const selectedCheckboxes = document.querySelectorAll('#editVideoCategoriesMultiSelect input[type="checkbox"]:checked');
  const categories = Array.from(selectedCheckboxes).map(cb => cb.value);

  if (categories.length === 0) {
    showToast('Veuillez sélectionner au moins une catégorie.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/videos/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({ title, categories, category: categories[0], description, thumbnail })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la modification'));
      return;
    }

    showToast('Modifications et miniature enregistrées !');
    closeAdminEditModal();

    // If currently playing in modal, update live view
    if (currentPlayingVideo && currentPlayingVideo.id === id) {
      currentPlayingVideo.title = title;
      currentPlayingVideo.description = description;
      currentPlayingVideo.categories = categories;
      currentPlayingVideo.category = categories[0];
      if (data.video && data.video.thumbnail) {
        currentPlayingVideo.thumbnail = data.video.thumbnail;
      }

      const modalTitle = document.getElementById('modalVideoTitle');
      const modalDesc = document.getElementById('modalVideoDesc');
      if (modalTitle) modalTitle.textContent = title;
      if (modalDesc) modalDesc.textContent = description;
      renderModalTags(categories);
      loadSimilarVideos(currentPlayingVideo.id);
    }

    await loadAdminVideos();
    await loadVideos();
    if (typeof loadExplorerData === 'function') loadExplorerData();
  } catch (err) {
    showToast('Erreur de sauvegarde.');
  }
}

// Admin Users Management
// ==================== ADMIN USERS & VIP CONTROLLER ====================
let adminUsersCache = [];
let currentAdminUsersFilter = 'all';

function setAdminUsersFilter(filter) {
  currentAdminUsersFilter = filter;
  ['all', 'vip', 'free'].forEach(f => {
    const btn = document.getElementById(`filterUsers${f.charAt(0).toUpperCase() + f.slice(1)}Btn`);
    if (btn) btn.classList.toggle('active', f === filter);
  });
  filterAndRenderAdminUsers();
}

function filterAndRenderAdminUsers() {
  const container = document.getElementById('adminUsersList');
  if (!container) return;

  const searchInput = document.getElementById('adminUserSearchInput');
  const search = searchInput ? searchInput.value.trim().toLowerCase() : '';

  let filtered = adminUsersCache;

  // 1. Filter by category (VIP / Free / All)
  if (currentAdminUsersFilter === 'vip') {
    filtered = filtered.filter(u => u.isVip);
  } else if (currentAdminUsersFilter === 'free') {
    filtered = filtered.filter(u => !u.isVip);
  }

  // 2. Filter by search query
  if (search) {
    filtered = filtered.filter(u => 
      (u.username && u.username.toLowerCase().includes(search)) ||
      (u.email && u.email.toLowerCase().includes(search)) ||
      (u.bio && u.bio.toLowerCase().includes(search))
    );
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box" style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; background: var(--bg-card); border-radius: 12px; border: 1px dashed var(--border-color); color: var(--text-muted);">
        <p style="margin:0; font-size:0.95rem; font-weight:600;">Aucun membre ne correspond à ce filtre.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(u => {
    const isUserVip = !!u.isVip;
    const isUserAdmin = u.role === 'admin' || (u.email && u.email.toLowerCase() === 'ia.project.pro2k26@gmail.com');

    return `
      <div class="admin-user-card ${isUserVip ? 'is-vip-user' : ''}">
        <div class="user-card-left" style="cursor:pointer;" onclick="openPublicUserProfile('${u.id}')" title="Cliquer pour afficher la fiche profil de ${u.username}">
          <img src="${u.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}" class="user-card-avatar" alt="${u.username}">
          <div class="user-card-details">
            <div class="user-card-header-row">
              <h4 class="user-card-username" style="display:flex; align-items:center; gap:6px;">
                ${u.username}
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </h4>
              ${isUserAdmin ? '<span class="admin-badge-pill">Admin</span>' : ''}
              ${isUserVip ? 
                '<span class="badge-vip-pill">MEMBRE VIP</span>' : 
                '<span class="badge-free-pill">MEMBRE GRATUIT (FREE)</span>'
              }
            </div>
            <p class="user-card-email">${u.email}</p>
            ${u.bio ? `<p class="user-card-bio">"${u.bio.length > 80 ? u.bio.slice(0, 80) + '...' : u.bio}"</p>` : ''}
            <p class="user-card-status-info ${isUserVip ? 'text-vip-active' : 'text-free-active'}">
              ${isUserVip ? `Privilèges VIP actifs (${u.vipExpiry || 'Permanent'})` : 'Option standard gratuite (Free)'}
            </p>
          </div>
        </div>

        <div class="user-card-actions">
          <button class="btn btn-sm ${isUserVip ? 'btn-secondary' : 'btn-vip-pill'}" onclick="toggleUserVip('${u.id}')" title="${isUserVip ? 'Rétrograder au compte standard Free' : 'Accorder les privilèges VIP à 9,99€'}">
            ${isUserVip ? 'Retirer VIP' : 'Passer VIP'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function openPublicUserProfile(userIdOrUsername) {
  if (!userIdOrUsername) return;
  const modal = document.getElementById('userProfileModal');
  if (!modal) return;

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userIdOrUsername)}/profile`);
    if (!res.ok) {
      showToast('Profil introuvable.');
      return;
    }
    const profile = await res.json();

    const avatarEl = document.getElementById('publicProfileAvatar');
    const usernameEl = document.getElementById('publicProfileUsername');
    const emailEl = document.getElementById('publicProfileEmail');
    const bioEl = document.getElementById('publicProfileBio');
    const badgesContainer = document.getElementById('publicProfileBadges');
    const videosCountEl = document.getElementById('publicProfileVideosCount');
    const viewsCountEl = document.getElementById('publicProfileViewsCount');
    const memberSinceEl = document.getElementById('publicProfileMemberSince');
    const videosListEl = document.getElementById('publicProfileVideosList');
    const actionsEl = document.getElementById('publicProfileActions');

    if (avatarEl) avatarEl.src = profile.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150';
    if (usernameEl) usernameEl.textContent = profile.username;
    
    // N'afficher l'email que pour l'admin ou le propriétaire du compte
    const canSeeEmail = AUTH.isAdmin() || (AUTH.user && AUTH.user.id === profile.id);
    if (emailEl) {
      if (canSeeEmail) {
        emailEl.textContent = profile.email;
        emailEl.style.display = 'block';
      } else {
        emailEl.style.display = 'none';
      }
    }

    if (bioEl) {
      bioEl.textContent = profile.bio ? `"${profile.bio}"` : 'Aucune description rédigée.';
    }

    if (badgesContainer) {
      let badgesHtml = '';
      if (profile.role === 'admin' || profile.email === 'ia.project.pro2k26@gmail.com') {
        badgesHtml += '<span class="admin-badge-pill">Admin</span>';
      }
      if (profile.isVip) {
        badgesHtml += '<span class="badge-vip-pill">MEMBRE VIP</span>';
      } else {
        badgesHtml += '<span class="badge-free-pill">MEMBRE GRATUIT</span>';
      }
      // Creator badge
      if (profile.creatorBadge) {
        const badgeColors = { 'Bronze': '#cd7f32', 'Argent': '#a8a9ad', 'Or': '#ffd700', 'Platine': '#e5e4e2' };
        const color = badgeColors[profile.creatorBadge] || '#94a3b8';
        badgesHtml += `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.3);border:1px solid ${color};color:${color};font-size:0.72rem;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:0.5px;">Createur ${profile.creatorBadge}</span>`;
      }
      badgesContainer.innerHTML = badgesHtml;
    }


    if (videosCountEl) videosCountEl.textContent = profile.videosCount || 0;
    if (viewsCountEl) viewsCountEl.textContent = (profile.totalViews || 0).toLocaleString();
    if (memberSinceEl) {
      const d = new Date(profile.createdAt || Date.now());
      memberSinceEl.textContent = d.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
    }

    if (videosListEl) {
      if (!profile.videos || profile.videos.length === 0) {
        videosListEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;margin:0;grid-column:1/-1;">Aucune vidéo publiée pour le moment.</p>';
      } else {
        videosListEl.innerHTML = profile.videos.map(v => `
          <div style="cursor:pointer; border-radius:8px; overflow:hidden; background:var(--bg-subtle); border:1px solid var(--border-color);" onclick="closeUserProfileModal(); openVideoPlayerModal('${v.id}')">
            <img src="${v.thumbnail || 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=300'}" style="width:100%; height:75px; object-fit:cover; display:block;">
            <div style="padding:6px 8px;">
              <div style="font-size:0.76rem; font-weight:700; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${v.title}</div>
              <div style="font-size:0.68rem; color:var(--text-muted);">${v.views || 0} vues</div>
            </div>
          </div>
        `).join('');
      }
    }

    if (actionsEl) {
      let actionsHtml = '';
      if (AUTH.isAdmin() && profile.email !== 'ia.project.pro2k26@gmail.com') {
        actionsHtml += `
          <button type="button" class="btn btn-sm ${profile.isVip ? 'btn-secondary' : 'btn-vip-pill'}" onclick="toggleUserVip('${profile.id}'); closeUserProfileModal();">
            ${profile.isVip ? 'Retirer VIP' : 'Passer VIP'}
          </button>
        `;
      }
      if (AUTH.isLoggedIn() && (!AUTH.user || AUTH.user.id !== profile.id)) {
        actionsHtml += `
          <button type="button" class="btn btn-sm btn-primary" onclick="closeUserProfileModal(); openDirectMessageModal({ username: '${profile.username}', avatar: '${profile.avatar}' })">
            Envoyer un message
          </button>
        `;
      }
      actionsHtml += `<button type="button" class="btn btn-secondary btn-sm" onclick="closeUserProfileModal()">Fermer</button>`;
      actionsEl.innerHTML = actionsHtml;
    }

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Update URL to /profil/:username for shareability
    window.history.pushState(null, '', `/profil/${encodeURIComponent(profile.username)}`);
  } catch (err) {
    showToast('Erreur lors du chargement du profil.');
  }
}

function closeUserProfileModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) return;
  const modal = document.getElementById('userProfileModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  // Restore URL if we came from a /profil/ path
  if (window.location.pathname.startsWith('/profil/')) {
    window.history.pushState(null, '', '/');
  }
}


async function loadAdminUsers() {
  if (!AUTH.isAdmin()) return;
  const container = document.getElementById('adminUsersList');
  if (!container) return;

  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    adminUsersCache = data.users || [];

    // Update Counts
    const totalCount = adminUsersCache.length;
    const vipCount = adminUsersCache.filter(u => u.isVip).length;
    const freeCount = totalCount - vipCount;

    const countAllEl = document.getElementById('statCountUsersAll');
    const countVipEl = document.getElementById('statCountUsersVip');
    const countFreeEl = document.getElementById('statCountUsersFree');

    if (countAllEl) countAllEl.textContent = totalCount;
    if (countVipEl) countVipEl.textContent = vipCount;
    if (countFreeEl) countFreeEl.textContent = freeCount;

    filterAndRenderAdminUsers();
  } catch (err) {
    console.error(err);
  }
}

async function toggleUserVip(userId) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/toggle-vip`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    showToast(data.message || 'Statut VIP modifié !');
    await loadAdminStats();
    await loadAdminUsers();
  } catch (err) {
    showToast('Erreur lors du changement de statut.');
  }
}

function renderAdminCategoriesManager() {
  const container = document.getElementById('adminCategoriesTable');
  if (!container) return;

  const adminFilterSel = document.getElementById('adminVideoCategoryFilter');
  if (adminFilterSel) {
    adminFilterSel.innerHTML = `<option value="all">Toutes les catégories</option>` + 
      allCategoriesList.filter(c => c.id !== 'all').map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  container.innerHTML = allCategoriesList.map(cat => `
    <div class="category-manager-item">
      <div class="cat-item-left">
        <div>
          <strong>${cat.name}</strong>
          ${cat.isSystem ? '<small style="color:var(--text-light);font-size:0.7rem;display:block;">(Système)</small>' : ''}
          ${cat.description ? `<small style="color:var(--text-muted);display:block;font-size:0.75rem;">${cat.description}</small>` : ''}
        </div>
      </div>
      <div class="cat-item-actions" style="display:flex;gap:6px;align-items:center;">
        ${!cat.isSystem ? `
          <button class="btn btn-sm btn-secondary" onclick="openAdminEditCategoryModal('${cat.id}')">Modifier</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCategory('${cat.id}')" title="Supprimer la catégorie">Supprimer</button>
        ` : '<span style="font-size:0.75rem;color:var(--text-light);">Protégée</span>'}
      </div>
    </div>
  `).join('');
}

// Category Edit Modal Handlers
function openAdminEditCategoryModal(catId) {
  const cat = allCategoriesList.find(c => c.id === catId);
  if (!cat) return;

  document.getElementById('editCatId').value = cat.id;
  document.getElementById('editCatName').value = cat.name || '';
  const descEl = document.getElementById('editCatDesc');
  if (descEl) descEl.value = cat.description || '';

  const modal = document.getElementById('adminEditCategoryModal');
  if (modal) modal.classList.remove('hidden');
}

function closeAdminEditCategoryModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn') && e.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('adminEditCategoryModal');
  if (modal) modal.classList.add('hidden');
}

async function saveAdminCategoryEdit(e) {
  e.preventDefault();
  const id = document.getElementById('editCatId').value;
  const name = document.getElementById('editCatName').value.trim();
  const description = (document.getElementById('editCatDesc')?.value || '').trim();
  const btnSubmit = document.getElementById('btnSaveCatEditSubmit');

  if (!name) {
    showToast('Le nom de la catégorie est obligatoire.');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Enregistrement...';
  }

  try {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({ name, description })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de la mise à jour');
      return;
    }

    showToast(data.message || 'Catégorie modifiée avec succès !');
    closeAdminEditCategoryModal();

    await loadCategories();
    if (typeof loadExplorerData === 'function') loadExplorerData();
    await loadAdminStats();
  } catch (err) {
    showToast('Erreur de modification.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Enregistrer la catégorie';
    }
  }
}

// ==================== PROFILE EDIT CONTROLLER ====================
function updateBioCounter(el) {
  const counter = document.getElementById('bioCharCounter');
  if (counter && el) {
    const len = el.value.length;
    counter.textContent = `${len} / 300`;
    if (len > 300) {
      counter.style.color = '#f59e0b';
    } else {
      counter.style.color = 'var(--text-muted)';
    }
  }
}
function openDeleteAccountModal() {
  if (AUTH && (AUTH.isAdmin() || (AUTH.user && (AUTH.user.role === 'admin' || AUTH.user.email?.toLowerCase() === 'ia.project.pro2k26@gmail.com')))) {
    showToast('Le compte administrateur est protégé et ne peut pas être supprimé.');
    return;
  }
  const modal = document.getElementById('deleteAccountModal');
  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const input = document.getElementById('deleteAccountConfirmInput');
    if (input) input.value = '';
  }
}

function closeDeleteAccountModal(e) {
  if (e && e.target !== e.currentTarget) return;
  const modal = document.getElementById('deleteAccountModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

async function handleDeleteAccount() {
  if (AUTH && (AUTH.isAdmin() || (AUTH.user && (AUTH.user.role === 'admin' || AUTH.user.email?.toLowerCase() === 'ia.project.pro2k26@gmail.com')))) {
    showToast('Le compte administrateur est protégé et ne peut pas être supprimé.');
    closeDeleteAccountModal();
    return;
  }
  const input = document.getElementById('deleteAccountConfirmInput');
  if (!input || input.value.trim() !== 'DELETE') {
    showToast('Tapez DELETE pour confirmer.');
    return;
  }
  if (!AUTH.isLoggedIn()) return;

  try {
    const res = await fetch('/api/user/account', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de la suppression.');
      return;
    }
    showToast('Votre compte a été supprimé.');
    closeDeleteAccountModal();
    AUTH.logout();
  } catch (err) {
    showToast('Erreur de communication.');
  }
}

function openEditProfileModal() {
  if (!AUTH || !AUTH.user) {
    showToast('Vous devez être connecté pour modifier votre profil.');
    switchTab('profil');
    return;
  }

  const user = AUTH.user;
  const usernameInput = document.getElementById('editProfileUsername');
  const bioInput = document.getElementById('editProfileBio');
  const avatarPreview = document.getElementById('editProfileAvatarPreview');
  const avatarFile = document.getElementById('editProfileAvatarFile');

  if (usernameInput) usernameInput.value = user.username || '';
  if (bioInput) {
    bioInput.value = user.bio || '';
    updateBioCounter(bioInput);
  }
  if (avatarPreview) avatarPreview.src = user.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150';
  if (avatarFile) avatarFile.value = '';

  const modal = document.getElementById('editProfileModal');
  if (modal) modal.classList.remove('hidden');
}

function closeEditProfileModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('editProfileModal');
  if (modal) modal.classList.add('hidden');
}

function previewEditAvatar(input) {
  const file = input.files[0];
  if (!file) return;

  const preview = document.getElementById('editProfileAvatarPreview');
  if (preview) {
    preview.src = URL.createObjectURL(file);
  }
}

async function handleSaveProfile(e) {
  e.preventDefault();
  if (!AUTH.isLoggedIn()) return;

  const username = document.getElementById('editProfileUsername').value.trim();
  const bio = document.getElementById('editProfileBio').value.trim();
  const avatarFile = document.getElementById('editProfileAvatarFile').files[0];

  if (!username) {
    showToast('Le surnom/pseudo est obligatoire.');
    return;
  }

  const btnSubmit = document.getElementById('btnSaveProfileSubmit');
  const origText = btnSubmit ? btnSubmit.innerHTML : 'Enregistrer';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = 'Enregistrement...';
  }

  const formData = new FormData();
  formData.append('username', username);
  formData.append('bio', bio);
  if (avatarFile) {
    formData.append('avatarFile', avatarFile);
  }

  try {
    const res = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de la modification');
      return;
    }

    AUTH.setAuth(data.token, data.user);
    showToast(data.message || 'Profil mis à jour avec succès !');
    closeEditProfileModal();

    // Refresh videos
    await loadVideos();
    if (typeof loadMyVideos === 'function') loadMyVideos();
  } catch (err) {
    console.error(err);
    showToast('Erreur de communication avec le serveur.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = origText;
    }
  }
}

async function resendMyWelcomeEmail() {
  if (!AUTH || !AUTH.isLoggedIn()) {
    showToast('Vous devez être connecté.');
    return;
  }
  const btn = document.getElementById('btnResendWelcomeEmail');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Envoi en cours...';
  }
  try {
    const res = await fetch('/api/auth/send-welcome-email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH.token}`
      }
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'E-mail de bienvenue envoyé ! Vérifiez votre boîte de réception.');
    } else {
      showToast(data.error || "Erreur lors de l'envoi de l'e-mail.");
    }
  } catch (err) {
    showToast("Erreur lors de l'envoi de l'e-mail.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Renvoyer l'e-mail de bienvenue";
    }
  }
}

// ==================== FORGOT & RESET PASSWORD CONTROLLER ====================
function openForgotPasswordModal() {
  const modal = document.getElementById('forgotPasswordModal');
  const step1 = document.getElementById('forgotStep1');
  const step2 = document.getElementById('forgotStep2');
  const emailInput = document.getElementById('forgotEmailInput');

  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
  if (emailInput) {
    const loginIdent = document.getElementById('loginIdentifier')?.value || '';
    if (loginIdent && loginIdent.includes('@')) {
      emailInput.value = loginIdent;
    } else {
      emailInput.value = '';
    }
  }

  if (modal) modal.classList.remove('hidden');
}

function closeForgotPasswordModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn') && e.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('forgotPasswordModal');
  if (modal) modal.classList.add('hidden');
}

function backToForgotStep1() {
  document.getElementById('forgotStep1')?.classList.remove('hidden');
  document.getElementById('forgotStep2')?.classList.add('hidden');
}

async function handleRequestResetCode(e) {
  e.preventDefault();
  const email = (document.getElementById('forgotEmailInput')?.value || '').trim();
  const btn = document.getElementById('btnRequestResetCode');

  if (!email) {
    showToast('Veuillez saisir votre adresse e-mail.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Envoi du code...';
  }

  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de la demande.');
      return;
    }

    showToast(data.message || 'Code envoyé ! Vérifiez votre boîte mail.');
    document.getElementById('resetEmailHidden').value = email;
    const subTitle = document.getElementById('forgotStep2Subtitle');
    if (subTitle) {
      subTitle.textContent = `Un code de sécurité à 6 chiffres a été envoyé à ${email}.`;
    }

    document.getElementById('forgotStep1')?.classList.add('hidden');
    document.getElementById('forgotStep2')?.classList.remove('hidden');
    document.getElementById('resetCodeInput')?.focus();
  } catch (err) {
    showToast('Erreur de communication avec le serveur.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Envoyer le code de sécurité';
    }
  }
}

async function handleConfirmResetPassword(e) {
  e.preventDefault();
  const email = document.getElementById('resetEmailHidden')?.value || document.getElementById('forgotEmailInput')?.value;
  const code = (document.getElementById('resetCodeInput')?.value || '').trim();
  const newPassword = document.getElementById('resetNewPasswordInput')?.value;
  const confirmPassword = document.getElementById('resetNewPasswordConfirm')?.value;
  const btn = document.getElementById('btnConfirmReset');

  if (!email || !code || !newPassword) {
    showToast('Veuillez renseigner tous les champs.');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('Les deux mots de passe ne correspondent pas.');
    return;
  }

  if (newPassword.length < 6) {
    showToast('Le mot de passe doit comporter au moins 6 caractères.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Modification...';
  }

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, newPassword })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Code invalide ou expiré.');
      return;
    }

    showToast(data.message || 'Mot de passe modifié avec succès !');
    closeForgotPasswordModal();

    if (data.token && data.user) {
      AUTH.setAuth(data.token, data.user);
      renderProfileView();
      switchTab('profil');
    }
  } catch (err) {
    showToast('Erreur de communication avec le serveur.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Changer mon mot de passe';
    }
  }
}

// ==================== CGU MODAL CONTROLLER ====================
function openCguModal() {
  const modal = document.getElementById('cguModal');
  if (modal) modal.classList.remove('hidden');
}

function closeCguModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('cguModal');
  if (modal) modal.classList.add('hidden');
}

// ==================== MENTIONS LÉGALES & BLOG MODAL ====================
function openMentionsLegalesModal() {
  const modal = document.getElementById('mentionsLegalesModal');
  if (modal) modal.classList.remove('hidden');
}

function closeMentionsLegalesModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('mentionsLegalesModal');
  if (modal) modal.classList.add('hidden');
}

// ==================== POLITIQUE DE CONFIDENTIALITÉ & RGPD MODAL ====================
function openPrivacyModal() {
  const modal = document.getElementById('privacyPolicyModal');
  if (modal) modal.classList.remove('hidden');
}

function closePrivacyModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('privacyPolicyModal');
  if (modal) modal.classList.add('hidden');
}

// ==================== POLITIQUE DE PLAINTES & DMCA MODAL ====================
function openComplaintsModal() {
  const modal = document.getElementById('complaintsPolicyModal');
  if (modal) modal.classList.remove('hidden');
}

function closeComplaintsModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('complaintsPolicyModal');
  if (modal) modal.classList.add('hidden');
}

// ==================== FORMULAIRE DE SIGNALEMENT DE CONTENU (DMCA / TAKEDOWN) ====================
function openReportModal(videoInfo = null) {
  const modal = document.getElementById('reportAbuseModal');
  const urlInput = document.getElementById('reportVideoUrl');
  const nameInput = document.getElementById('reportFullName');
  const emailInput = document.getElementById('reportEmail');

  if (videoInfo) {
    if (urlInput) urlInput.value = `${window.location.origin}/?video=${videoInfo.id}`;
  }


  if (AUTH.isLoggedIn()) {
    if (nameInput && !nameInput.value) nameInput.value = AUTH.user.username;
    if (emailInput && !emailInput.value) emailInput.value = AUTH.user.email;
  }

  if (modal) modal.classList.remove('hidden');
}

function openReportModalFromCurrentVideo() {
  if (!currentPlayingVideo) return;
  openReportModal(currentPlayingVideo);
}

function closeReportModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('reportAbuseModal');
  if (modal) modal.classList.add('hidden');
}

async function handleSendReport(e) {
  e.preventDefault();
  const btnSubmit = document.getElementById('btnSubmitReport');
  const fullName = document.getElementById('reportFullName').value.trim();
  const email = document.getElementById('reportEmail').value.trim();
  const videoUrl = document.getElementById('reportVideoUrl').value.trim();
  const reason = document.getElementById('reportReason').value;
  const details = document.getElementById('reportDetails').value.trim();
  const signature = document.getElementById('reportSignature').value.trim();

  if (!fullName || !email || !videoUrl || !reason || !signature) {
    showToast('Veuillez remplir tous les champs obligatoires (*).');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Transmission en cours...';
  }

  try {
    const res = await fetch('/api/reports/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName,
        email,
        videoUrl,
        videoTitle: currentPlayingVideo ? currentPlayingVideo.title : '',
        reason,
        details,
        signature
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast('' + (data.error || 'Erreur lors de la transmission du signalement'));
      return;
    }

    showToast('Signalement enregistré. Traitement d\'urgence sous 24h à 48h.');
    document.getElementById('reportAbuseForm').reset();
    closeReportModal();
  } catch (err) {
    showToast('Erreur de communication.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Transmettre le Signalement d\'Urgence';
    }
  }
}

// ==================== POLITIQUE CSAM & PROTECTION DES MINEURS ====================
function openCsamModal() {
  const modal = document.getElementById('csamPolicyModal');
  if (modal) modal.classList.remove('hidden');
}

function closeCsamModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('csamPolicyModal');
  if (modal) modal.classList.add('hidden');
}

// ==================== FAQ ACCORDION ====================
async function loadFaqs() {
  try {
    const res = await fetch('/api/faq');
    const data = await res.json();
    const accordion = document.getElementById('faqAccordion');
    if (!accordion) return;

    accordion.innerHTML = (data.faqs || []).map((f, idx) => `
      <div class="faq-item ${idx === 0 ? 'active' : ''}" id="faqItem-${f.id}">
        <div class="faq-question" onclick="toggleFaq('${f.id}')">
          <span>${f.question}</span>
          <span class="faq-arrow">▼</span>
        </div>
        <div class="faq-answer" style="${idx === 0 ? 'max-height: 200px;' : ''}">
          <div class="faq-answer-inner">${f.answer}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading FAQ', err);
  }
}

function toggleFaq(id) {
  const item = document.getElementById(`faqItem-${id}`);
  if (!item) return;

  const isActive = item.classList.contains('active');
  const answer = item.querySelector('.faq-answer');

  if (isActive) {
    item.classList.remove('active');
    answer.style.maxHeight = '0px';
  } else {
    item.classList.add('active');
    answer.style.maxHeight = answer.scrollHeight + 30 + 'px';
  }
}

// Toast System
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;

  toast.textContent = msg;
  toast.classList.remove('hidden');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3200);
}

// Adult Warning / Age Gate Handler (Valable 1 heure)
function acceptAdultWarning() {
  const ONE_HOUR_MS = 60 * 60 * 1000; // 1 heure
  try {
    localStorage.setItem('videohub_age_verified_until', (Date.now() + ONE_HOUR_MS).toString());
  } catch (e) {}

  document.documentElement.classList.add('age-verified');

  const overlay = document.getElementById('adultWarningOverlay');
  if (overlay) {
    overlay.classList.add('dismissed');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 350);
  }
}

// ==================== CONTACT FORM HANDLERS ====================
function openContactModal() {
  const modal = document.getElementById('contactModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Pre-fill user info if logged in
  if (AUTH && AUTH.user) {
    const nameInput = document.getElementById('contactName');
    const emailInput = document.getElementById('contactEmail');
    if (nameInput && !nameInput.value) nameInput.value = AUTH.user.username || '';
    if (emailInput && !emailInput.value) emailInput.value = AUTH.user.email || '';
  }
}

function closeContactModal(e) {
  if (e && e.target && e.target.id !== 'contactModal' && !e.target.classList.contains('modal-close-btn') && e.target.tagName !== 'BUTTON') {
    return;
  }
  const modal = document.getElementById('contactModal');
  if (modal) modal.classList.add('hidden');
}

async function handleSendContact(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('contactName')?.value || '').trim();
  const email = (document.getElementById('contactEmail')?.value || '').trim();
  const subject = (document.getElementById('contactSubject')?.value || '').trim();
  const message = (document.getElementById('contactMessage')?.value || '').trim();
  const btnSubmit = document.getElementById('btnSubmitContact');

  if (!name || !email || !subject || !message) {
    showToast('Veuillez remplir tous les champs obligatoires (*).');
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Envoi en cours...';
  }

  try {
    const res = await fetch('/api/contact/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, subject, message })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors de l\'envoi du message');
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Envoyer le message';
      }
      return;
    }

    showToast(data.message || 'Votre message a été envoyé avec succès !');
    const form = document.getElementById('contactForm');
    if (form) form.reset();
    closeContactModal();
  } catch (err) {
    showToast('Erreur de communication avec le serveur.');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Envoyer le message';
    }
  }
}

// ==================== PASSWORD VISIBILITY TOGGLE ====================
function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';

  if (btnEl) {
    if (isPass) {
      // Eye-off (currently visible, click to hide)
      btnEl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
      btnEl.title = "Masquer le mot de passe";
    } else {
      // Eye (currently hidden, click to show)
      btnEl.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      btnEl.title = "Afficher le mot de passe";
    }
  }
}




// --- WAVE 2 FEATURES ---

// FAVORITES LOGIC
async function toggleFavorite(videoId) {
  if (!AUTH.isLoggedIn()) {
    showToast('Connectez-vous pour ajouter des favoris.');
    return;
  }
  try {
    const res = await fetch(`/api/user/favorites/${videoId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur.'); return; }
    
    if (!AUTH.user.favorites) AUTH.user.favorites = [];
    if (data.added) {
      if (!AUTH.user.favorites.includes(videoId)) AUTH.user.favorites.push(videoId);
      showToast('Ajout aux favoris.');
    } else {
      AUTH.user.favorites = AUTH.user.favorites.filter(id => id !== videoId);
      showToast('Retiré des favoris.');
    }
    
    updateFavoriteButtonsUI(videoId, data.added);
  } catch(e) {
    showToast('Erreur de communication.');
  }
}

function isFavorite(videoId) {
  return AUTH.isLoggedIn() && AUTH.user.favorites && AUTH.user.favorites.includes(videoId);
}

function updateFavoriteButtonsUI(videoId, isFav) {
  document.querySelectorAll(`[data-fav-btn="${videoId}"]`).forEach(btn => {
    if (btn.id === 'modalFavBtn') {
      btn.classList.toggle('active', isFav);
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="${isFav ? '#ef4444' : 'none'}" stroke="${isFav ? '#ef4444' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        <span class="action-text">${isFav ? 'Ajouté' : 'Favori'}</span>
      `;
    } else {
      btn.innerHTML = isFav
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#ef4444" stroke="#ef4444" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    }
    btn.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  });
}

async function loadAndShowFavorites() {
  if (!AUTH.isLoggedIn()) return;
  try {
    const res = await fetch('/api/user/favorites', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    const data = await res.json();
    if (!res.ok) return;
    if (AUTH.user) AUTH.user.favorites = data.favorites || [];
    renderProfileFavorites(data.videos || []);
  } catch(e) {}
}

function renderProfileFavorites(videos) {
  const container = document.getElementById('profileFavoritesGrid');
  if (!container) return;
  if (!videos || videos.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Aucune vidéo dans vos favoris.</p>';
    return;
  }
  container.innerHTML = videos.map(v => renderVideoCard(v)).join('');
}

// CREATOR DASHBOARD LOGIC
async function loadCreatorDashboard() {
  if (!AUTH.isLoggedIn()) return;
  const container = document.getElementById('creatorDashboardContent');
  if (!container) return;

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(AUTH.user.id)}/profile`);
    if (!res.ok) return;
    const profile = await res.json();

    const videos = profile.videos || [];
    const totalViews = profile.totalViews || 0;
    const totalLikes = profile.totalLikes || 0;

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
        <div style="background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:10px;padding:14px;text-align:center;">
          <div style="font-size:1.4rem;font-weight:800;color:var(--primary);">${videos.length}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-top:4px;">Vidéos publiées</div>
        </div>
        <div style="background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:10px;padding:14px;text-align:center;">
          <div style="font-size:1.4rem;font-weight:800;color:var(--text-main);">${totalViews.toLocaleString()}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-top:4px;">Vues totales</div>
        </div>
        <div style="background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:10px;padding:14px;text-align:center;">
          <div style="font-size:1.4rem;font-weight:800;color:#ef4444;">${totalLikes.toLocaleString()}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-top:4px;">Likes totaux</div>
        </div>
      </div>
      <h4 style="font-size:0.9rem;font-weight:700;margin:0 0 10px;">Mes vidéos</h4>
      ${videos.length === 0 
        ? '<p style="color:var(--text-muted);font-size:0.85rem;">Aucune vidéo publiée.</p>'
        : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;max-height:260px;overflow-y:auto;">${videos.map(v => `
          <div style="cursor:pointer;border-radius:8px;overflow:hidden;background:var(--bg-subtle);border:1px solid var(--border-color);" onclick="openVideoPlayerModal('${v.id}')">
            <img src="${v.thumbnail || 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=300'}" style="width:100%;height:75px;object-fit:cover;display:block;">
            <div style="padding:6px 8px;">
              <div style="font-size:0.75rem;font-weight:700;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${v.title}</div>
              <div style="font-size:0.68rem;color:var(--text-muted);">${(v.views||0).toLocaleString()} vues · ${v.likes||0} likes</div>
            </div>
          </div>
        `).join('')}</div>`
      }
    `;
  } catch(e) {
    container.innerHTML = '<p style="color:var(--text-muted);">Erreur de chargement.</p>';
  }
}

// NOTIFICATIONS LOGIC
let notificationPanelOpen = false;

async function loadNotifications() {
  if (!AUTH.isLoggedIn()) return;
  const wrapper = document.getElementById('notifBellWrapper');
  if (wrapper) wrapper.classList.remove('hidden');
  
  try {
    const res = await fetch('/api/user/notifications', {
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    
    const badge = document.getElementById('notifBadge');
    if (badge) {
      if (data.unreadCount > 0) {
        badge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount;
        badge.classList.remove('hidden');
        badge.style.display = 'flex';
      } else {
        badge.classList.add('hidden');
        badge.style.display = 'none';
      }
    }
    
    renderNotifications(data.notifications || []);
  } catch(e) {}
}

function renderNotifications(notifications) {
  const list = document.getElementById('notificationList');
  if (!list) return;
  if (!notifications || notifications.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;font-size:0.85rem;">Aucune notification.</p>';
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div onclick="handleNotifClick('${n.id}', '${n.link || ''}')" style="padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border-color);background:${n.read ? 'transparent' : 'rgba(249,115,22,0.06)'};transition:background 0.2s;">
      <div style="font-size:0.82rem;color:var(--text-main);font-weight:${n.read ? '400' : '600'};">${n.message}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">${new Date(n.createdAt).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
    </div>
  `).join('');
}

async function handleNotifClick(notifId, link) {
  try {
    await fetch(`/api/user/notifications/${notifId}/read`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
  } catch(e) {}
  closeNotificationPanel();
  if (link) {
    const urlParams = new URLSearchParams(link.split('?')[1] || '');
    const videoId = urlParams.get('video');
    if (videoId) openVideoPlayerModal(videoId);
  }
  loadNotifications();
}

function toggleNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  if (!panel) return;
  notificationPanelOpen = !notificationPanelOpen;
  if (notificationPanelOpen) {
    panel.classList.remove('hidden');
    loadNotifications();
  } else {
    panel.classList.add('hidden');
  }
}

function closeNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  if (panel) panel.classList.add('hidden');
  notificationPanelOpen = false;
}

async function markAllNotificationsRead() {
  if (!AUTH.isLoggedIn()) return;
  try {
    await fetch('/api/user/notifications/read-all', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${AUTH.token}` }
    });
    loadNotifications();
    showToast('Toutes les notifications marquées comme lues.');
  } catch(e) {}
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('notificationPanel');
  const bell = document.getElementById('notifBellBtn');
  if (panel && bell && !panel.contains(e.target) && !bell.contains(e.target)) {
    closeNotificationPanel();
  }
});

// Periodic notification check & initial load
setInterval(() => {
  if (AUTH && AUTH.isLoggedIn()) {
    loadNotifications();
  }
}, 120000);

setTimeout(() => {
  if (AUTH && AUTH.isLoggedIn()) {
    loadNotifications();
  }
}, 2000);

