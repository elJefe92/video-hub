// Blog des Régions de France Manager
let activeRegionFilter = 'all';
let allRegions = [];
let allBlogPosts = [];

async function loadBlogData() {
  try {
    const res = await fetch('/api/blog');
    const data = await res.json();
    allRegions = data.regions || [];
    allBlogPosts = data.posts || [];

    renderRegionPills();
    renderBlogPosts();
  } catch (err) {
    console.error('Error loading blog data', err);
  }
}

function renderRegionPills() {
  const container = document.getElementById('regionPills');
  if (!container) return;

  let html = `
    <button class="region-btn ${activeRegionFilter === 'all' ? 'active' : ''}" onclick="filterBlogRegion('all')">
      🗺️ Toutes les Régions
    </button>
  `;

  html += allRegions.map(reg => `
    <button class="region-btn ${activeRegionFilter === reg.id ? 'active' : ''}" onclick="filterBlogRegion('${reg.id}')">
      ${reg.name}
    </button>
  `).join('');

  container.innerHTML = html;
}

function filterBlogRegion(regionId) {
  activeRegionFilter = regionId;
  renderRegionPills();
  renderBlogPosts();
}

function renderBlogPosts() {
  const container = document.getElementById('blogPostsContainer');
  if (!container) return;

  let filtered = allBlogPosts;
  if (activeRegionFilter !== 'all') {
    filtered = allBlogPosts.filter(p => p.regionId === activeRegionFilter);
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;background:#fff;border-radius:16px;border:1px solid var(--border-color);">
        <p style="font-size:1.1rem;color:var(--text-muted);margin-bottom:12px;">Aucun article de blog pour cette région pour le moment.</p>
        <button class="btn btn-primary" onclick="switchTab('upload')">Soyez le premier à poster une vidéo !</button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(post => `
    <article class="blog-post-card">
      <div class="blog-post-cover">
        <img src="${post.coverImage}" alt="${post.title}" loading="lazy">
        <span class="blog-region-badge">📍 ${post.regionName || 'France'}</span>
      </div>
      <div class="blog-post-content">
        <div>
          <div class="blog-post-meta">
            <img src="${post.authorAvatar}" alt="${post.author}">
            <span><strong>${post.author}</strong></span>
            <span>•</span>
            <span>${post.date}</span>
            <span>•</span>
            <span>⏱️ ${post.readingTime} de lecture</span>
          </div>

          <h3 class="blog-post-title">${post.title}</h3>
          <p class="blog-post-summary">${post.summary}</p>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;">
          ${post.video ? `
            <button class="blog-embedded-video-btn" onclick="openVideoPlayerModal('${post.video.id}')">
              <span>▶️</span> Voir le reportage vidéo (${post.video.duration || 'HD'})
            </button>
          ` : '<span></span>'}

          <span style="font-size:0.82rem;color:var(--text-muted);">
            ❤️ ${post.likes} mentions j'aime
          </span>
        </div>
      </div>
    </article>
  `).join('');
}
