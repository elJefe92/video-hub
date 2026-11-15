const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const styleCssSrc = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const authJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/auth.js'), 'utf8');

test('Schema.org WebSite site name is cleanly defined as Rêve de Q', () => {
  const schemaMatch = indexHtmlSrc.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(schemaMatch, 'Schema.org JSON-LD must be present');
  const schemaData = JSON.parse(schemaMatch[1]);
  const website = schemaData['@graph'].find(item => item['@type'] === 'WebSite');
  assert.ok(website, 'WebSite entry should exist in JSON-LD');
  assert.equal(website.name, 'Rêve de Q', 'WebSite name should be strictly "Rêve de Q"');
  assert.ok(Array.isArray(website.alternateName));
  assert.ok(website.alternateName.includes('Reve de Q'));
});

test('Homepage contains accessible H1 and brand logo with textual Q for Google crawlers', () => {
  assert.match(indexHtmlSrc, /<h1 class="visually-hidden"[^>]*>Rêve de Q/);
  assert.match(indexHtmlSrc, /class="brand-logo"[\s\S]*?<span class="brand-text-prefix">Rêve&nbsp;de<\/span>[\s\S]*?<span class="text-orange">Q<\/span>/);
});

test('Mobile header hides VIP button and caps auth label to avoid overflow', () => {
  // Check style.css hides .btn-header-vip-top on <= 768px even when body.is-admin is active
  assert.match(styleCssSrc, /@media\s*\(max-width:\s*768px\)[\s\S]*?body\.is-admin\s+\.btn-header-vip-top[\s\S]*?display:\s*none\s*!important/);
  // Check auth button is capped on mobile
  assert.match(styleCssSrc, /#headerAuthBtn\s*\{[\s\S]*?max-width:\s*(?:95px|100px)\s*!important;/);
  // Check auth.js shortens admin label to Admin
  assert.match(authJsSrc, /isAdmin\s*\?\s*['"]Admin['"]/);
  assert.equal(authJsSrc.includes('Administrateur (Admin)'), false);
});
