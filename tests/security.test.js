const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const databaseSrc = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const uploadJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/upload.js'), 'utf8');

test('database.js does not hardcode admin123 or store DB state in public thumbnails bucket', () => {
  assert.equal(databaseSrc.includes('"admin123"'), false);
  assert.equal(databaseSrc.includes("'admin123'"), false);
  assert.match(databaseSrc, /PRIVATE_STATE_BUCKET\s*=\s*'private-state'/);
  assert.match(databaseSrc, /from\(PRIVATE_STATE_BUCKET\)\.upload\(STATE_FILE_NAME/);
});

test('server.js does not contain hardcoded SMTP password fallback', () => {
  assert.equal(serverSrc.includes('rxcqdfrtywmzzaym'), false);
  assert.match(serverSrc, /if\s*\(!smtpPass\)/);
});

test('server.js protects /api/debug-supabase with requireAdmin and avoids GET ping writes', () => {
  assert.match(serverSrc, /app\.get\('\/api\/debug-supabase',\s*requireAdmin,/);
  assert.equal(serverSrc.includes("upload('test_ping.json'"), false);
});

test('server.js sets Content-Security-Policy and restricts CORS origins', () => {
  assert.match(serverSrc, /Content-Security-Policy/);
  assert.equal(/\bapp\.use\(cors\(\)\)/.test(serverSrc), false);
  assert.match(serverSrc, /ALLOWED_ORIGINS/);
});

test('Bunny Stream upload uses signed TUS without exposing apiKey to browser', () => {
  assert.match(serverSrc, /function getClientIp\(req\)/);
  const initBlockMatch = serverSrc.match(/app\.post\('\/api\/videos\/bunny-init'[\s\S]*?^\}\);/m);
  assert.ok(initBlockMatch, 'bunny-init route should exist');
  const initBlock = initBlockMatch[0];
  const jsonMatch = initBlock.match(/res\.json\(\{[\s\S]*?\}\);/);
  assert.ok(jsonMatch, 'bunny-init should call res.json');
  assert.equal(/\bapiKey\b/.test(jsonMatch[0]), false, 'bunny-init res.json must not expose apiKey');
  assert.match(jsonMatch[0], /tusSignature/);
  assert.match(jsonMatch[0], /tusUploadUrl/);
  assert.equal(uploadJsSrc.includes('bunnyData.apiKey'), false);
  assert.match(uploadJsSrc, /bunnyData\.tusSignature/);
});

test('daily spotlight automatically resets when date changes', () => {
  assert.match(databaseSrc, /v\.isDailyFeatured && v\.featuredDate && v\.featuredDate !== todayStr/);
  assert.match(serverSrc, /video\.featuredDate = new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
});

test('profile update persists changes to cloud database', () => {
  const profileRouteMatch = serverSrc.match(/app\.put\('\/api\/user\/profile'[\s\S]*?^\}\);/m);
  assert.ok(profileRouteMatch, 'profile route should exist');
  assert.match(profileRouteMatch[0], /await syncDbToCloud\(db\)/);
  assert.match(profileRouteMatch[0], /await syncDbFromCloud/);
  assert.match(profileRouteMatch[0], /isSafeHttpOrUploadUrl\(avatarUrl\)/);
  assert.match(profileRouteMatch[0], /user\.avatar = uploadedAvatar \|\| avatarBase64;/);
});

test('private messaging routes require strict authentication without query username IDOR', () => {
  assert.match(serverSrc, /app\.get\('\/api\/messages\/conversations',\s*authenticate,/);
  assert.match(serverSrc, /app\.get\('\/api\/messages\/with\/:username',\s*authenticate,/);
  assert.match(serverSrc, /app\.post\('\/api\/messages\/send',\s*authenticate,/);
  const convBlock = serverSrc.match(/app\.get\('\/api\/messages\/conversations'[\s\S]*?^\}\);/m);
  assert.ok(convBlock);
  assert.equal(convBlock[0].includes('req.query.username'), false);
  const withBlock = serverSrc.match(/app\.get\('\/api\/messages\/with\/:username'[\s\S]*?^\}\);/m);
  assert.ok(withBlock);
  assert.equal(withBlock[0].includes('req.query.username'), false);
});

test('legacy /api/auth/register bypass is disabled and auth codes use crypto.randomInt with rate limits', () => {
  const regBlock = serverSrc.match(/app\.post\('\/api\/auth\/register'[\s\S]*?^\}\);/m);
  assert.ok(regBlock);
  assert.match(regBlock[0], /status\(410\)/);
  assert.match(serverSrc, /crypto\.randomInt\(100000,\s*1000000\)/);
  assert.match(serverSrc, /checkIpRateLimit\(verifyCodeAttempts/);
  assert.match(serverSrc, /checkIpRateLimit\(resendCodeAttempts/);
  assert.match(serverSrc, /checkIpRateLimit\(resetConfirmAttempts/);
  assert.match(serverSrc, /user\.resetCode\s*=\s*bcrypt\.hashSync\(code/);
});

test('public video and profile endpoints strip private PII (emails and visitor IPs)', () => {
  assert.match(serverSrc, /function sanitizePublicVideo\(video\)/);
  assert.match(serverSrc, /const \{ authorEmail, likedBy, ratings, viewedBy, \.\.\.safeVideo \} = video/);
  const pubProfileBlock = serverSrc.match(/app\.get\('\/api\/users\/:id\/profile'[\s\S]*?^\}\);/m);
  assert.ok(pubProfileBlock);
  assert.match(pubProfileBlock[0], /isOwnerOrAdmin \? \{ email: user\.email/);
});

test('base64 uploads block SVG/HTML XSS and CORS restricts Vercel subdomains', () => {
  assert.match(serverSrc, /ALLOWED_BASE64_IMAGE_MIMES/);
  assert.equal(serverSrc.includes("'image/svg+xml'"), false);
  assert.equal(serverSrc.includes('/^https:\\/\\/[a-z0-9-]+\\.vercel\\.app$/i'), false);
  assert.match(serverSrc, /video-hub\|revedeq/);
});

test('Stripe verify-session validates session ownership and syncs cloud DB', () => {
  const stripeBlock = serverSrc.match(/app\.post\('\/api\/vip\/verify-session'[\s\S]*?^\}\);/m);
  assert.ok(stripeBlock);
  assert.match(stripeBlock[0], /session\.client_reference_id !== req\.user\.id/);
  assert.match(stripeBlock[0], /await syncDbToCloud\(db\)/);
});
