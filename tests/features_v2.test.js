const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const authJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');

test('D11: Dedicated regional SEO pages are configured in server, sitemap, footer, and SPA router', () => {
  assert.match(serverSrc, /const SEO_REGIONS\s*=\s*\[/);
  assert.match(serverSrc, /'\/region\/:slug'/);
  assert.match(serverSrc, /req\.path\.startsWith\('\/region\/'\)/);
  assert.match(serverSrc, /const regionUrls = SEO_REGIONS\.map/);
  assert.match(indexHtmlSrc, /footer-regions-seo/);
  assert.match(indexHtmlSrc, /href="\/region\/ile-de-france"/);
  assert.match(appJsSrc, /function navigateToRegion\(slug/);
});

test('A2: Server-side pagination is supported on GET /api/videos and loadMoreVideos exists', () => {
  assert.match(serverSrc, /const hasPagination = req\.query\.page !== undefined \|\| req\.query\.limit !== undefined/);
  assert.match(serverSrc, /totalPages,\s*hasMore/);
  assert.match(appJsSrc, /async function loadMoreVideos\(\)/);
  assert.match(indexHtmlSrc, /id="loadMoreVideosWrap"/);
});

test('A3: Animated Bunny Stream hover preview is wired on video cards', () => {
  assert.match(appJsSrc, /function getBunnyPreviewUrl\(/);
  assert.match(appJsSrc, /function startCardHoverPreview\(/);
  assert.match(appJsSrc, /preview\.webp/);
});

test('B5: Watch history and private playlists API & UI are implemented', () => {
  assert.match(serverSrc, /app\.get\('\/api\/user\/history',\s*authenticate,/);
  assert.match(serverSrc, /app\.post\('\/api\/user\/history\/:videoId',\s*authenticate,/);
  assert.match(serverSrc, /app\.get\('\/api\/user\/playlists',\s*authenticate,/);
  assert.match(serverSrc, /app\.post\('\/api\/user\/playlists',\s*authenticate,/);
  assert.match(indexHtmlSrc, /id="profileHistorySection"/);
  assert.match(indexHtmlSrc, /id="profilePlaylistsSection"/);
  assert.match(indexHtmlSrc, /id="playlistPickerModal"/);
  assert.match(appJsSrc, /async function openPlaylistPicker\(/);
});

test('C8 & C9: Admin 2FA by email and persistent cloud rate-limiting are active', () => {
  assert.match(serverSrc, /function checkPersistentLock\(db, key\)/);
  assert.match(serverSrc, /app\.post\('\/api\/auth\/verify-admin-2fa'/);
  assert.match(serverSrc, /requires2FA:\s*true/);
  assert.match(indexHtmlSrc, /id="admin2faForm"/);
  assert.match(authJsSrc, /async function handleVerifyAdmin2FA\(/);
  assert.equal(authJsSrc.includes("'admin123'"), false);
});
