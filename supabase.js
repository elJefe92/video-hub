const { createClient } = require('@supabase/supabase-js');

function cleanAscii(str) {
  if (!str) return '';
  return str
    .replace(/\u0430/g, 'a')
    .replace(/\u0435/g, 'e')
    .replace(/\u043e/g, 'o')
    .replace(/\u0440/g, 'p')
    .replace(/\u0441/g, 'c')
    .replace(/\u0443/g, 'y')
    .replace(/\u0445/g, 'x')
    .replace(/\u0456/g, 'i')
    .replace(/\u0458/g, 'j')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

const rawUrl = process.env.SUPABASE_URL;
const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabaseUrl = cleanAscii(rawUrl);
const supabaseKey = cleanAscii(rawKey);

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase Client initialisé avec succès.');
  } catch (e) {
    console.error('Failed to initialize Supabase client:', e.message);
  }
} else {
  console.log('ℹ️ Supabase non configuré dans .env, fonctionnement avec stockage local data.json.');
}

module.exports = { supabase };
