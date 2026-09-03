const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { supabase } = require('./supabase');

const LOCAL_DB_PATH = path.join(__dirname, 'data.json');
const TMP_DB_PATH = path.join('/tmp', 'data.json');

function getDbPath() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return TMP_DB_PATH;
  }
  return LOCAL_DB_PATH;
}

const defaultData = {
  users: [
    {
      id: "user_admin_main",
      username: "Administrateur",
      email: "ia.project.pro2k26@gmail.com",
      passwordHash: bcrypt.hashSync("admin123", 10),
      role: "admin",
      isVip: true,
      vipExpiry: "2030-01-01",
      avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
      bio: "Administrateur principal de la plateforme",
      createdAt: new Date().toISOString()
    }
  ],
  categories: [
    { id: "all", name: "Tous les flux", icon: "", isSystem: true, description: "Flux général de toutes les vidéos" }
  ],
  videos: [],
  logs: [
    {
      id: "log_reset",
      action: "Initialisation",
      details: "Plateforme initialisée.",
      date: new Date().toISOString()
    }
  ],
  faqs: [
    {
      id: "faq_1",
      question: "Comment ajouter une nouvelle catégorie ?",
      answer: "L'administrateur peut créer de nouvelles catégories thématiques en direct depuis l'Espace Administrateur (onglet Catégories) ou via le bouton '+ Catégorie'."
    },
    {
      "id": "faq_2",
      question: "Comment poster une vidéo ?",
      answer: "Rendez-vous dans l'onglet 'Ta vidéo'. Vous pouvez sélectionner un fichier vidéo, renseigner votre email, votre région de France et une description."
    },
    {
      "id": "faq_3",
      question: "Que contient l'abonnement VIP à 9,99€ ?",
      answer: "L'accès VIP à 9,99€ vous octroie : la publication en ultra haute définition (4K/HD), le badge VIP officiel, la mise en avant de vos vidéos en tête de flux et une navigation sans publicité."
    }
  ]
};

function normalizeData(db) {
  if (db && db.categories) {
    const seen = new Set();
    db.categories = db.categories.filter(c => {
      const key = (c.name || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (db && db.videos) {
    db.videos.forEach(v => {
      if (!v.categories || !Array.isArray(v.categories)) {
        v.categories = v.category ? [v.category] : [];
      }
    });
  }
  return db;
}

let memoryDb = null;

async function syncDbFromCloud() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage.from('thumbnails').download('videohub_db_state.json');
    if (error || !data) {
      return null;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const text = buf.toString('utf-8');
    if (!text || text.trim().length === 0) return null;
    const remoteDb = JSON.parse(text);
    if (remoteDb && Array.isArray(remoteDb.users) && remoteDb.users.length > 0) {
      memoryDb = normalizeData(remoteDb);
      const targetPath = getDbPath();
      try {
        fs.writeFileSync(targetPath, JSON.stringify(memoryDb, null, 2), 'utf-8');
      } catch (e) {}
      return memoryDb;
    }
  } catch (err) {
    // Ignore if not present yet
  }
  return null;
}

async function syncDbToCloud(data) {
  if (!supabase || !data) return;
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    const { error } = await supabase.storage.from('thumbnails').upload('videohub_db_state.json', jsonStr, {
      contentType: 'application/json',
      upsert: true
    });
    if (error) {
      console.error('[Database Cloud Upload Error]:', error.message);
    }
  } catch (err) {
    console.error('[Database Cloud Save Error]:', err.message);
  }
}

function loadDb() {
  if (memoryDb) return memoryDb;

  const targetPath = getDbPath();

  // Try /tmp/data.json first on serverless
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, 'utf-8');
      const data = JSON.parse(raw);
      memoryDb = normalizeData(data);
      return memoryDb;
    } catch (e) {}
  }

  // Check bundled data.json
  if (fs.existsSync(LOCAL_DB_PATH)) {
    try {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
      const data = JSON.parse(raw);
      memoryDb = normalizeData(data);
      try {
        fs.writeFileSync(targetPath, JSON.stringify(memoryDb, null, 2), 'utf-8');
      } catch (err) {}
      return memoryDb;
    } catch (e) {}
  }

  memoryDb = normalizeData(JSON.parse(JSON.stringify(defaultData)));
  try {
    fs.writeFileSync(targetPath, JSON.stringify(memoryDb, null, 2), 'utf-8');
  } catch (err) {}
  return memoryDb;
}

function saveDb(data) {
  memoryDb = data;
  const targetPath = getDbPath();
  try {
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    try {
      fs.writeFileSync(TMP_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {}
  }
  syncDbToCloud(data).catch(() => {});
}

module.exports = {
  loadDb,
  saveDb,
  syncDbFromCloud,
  syncDbToCloud
};
