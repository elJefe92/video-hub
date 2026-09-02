require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { loadDb, saveDb } = require('./database');
const { supabase } = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ia_project_video_hub_secret_2026';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'public', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (e) {}

// Helper to upload files to Supabase Storage if configured
async function uploadToSupabaseStorage(bucket, localFilePath, filename, contentType) {
  if (!supabase) return null;
  try {
    const fileBuffer = fs.readFileSync(localFilePath);
    const { data, error } = await supabase.storage.from(bucket).upload(filename, fileBuffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: true
    });
    if (error) {
      console.error(`Supabase storage upload error (${bucket}):`, error);
      return null;
    }
    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(filename);
    return publicData ? publicData.publicUrl : null;
  } catch (err) {
    console.error(`Error uploading to Supabase (${bucket}):`, err);
    return null;
  }
}

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'media-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Middleware for Auth
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié. Veuillez vous connecter.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = loadDb();
    const user = db.users.find(u => u.id === decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable.' });
    }
    // Auto grant admin role if email matches official admin email
    if (user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
      user.role = 'admin';
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expirée ou jeton invalide.' });
  }
}

// Middleware for Admin only
function requireAdmin(req, res, next) {
  authenticate(req, res, () => {
    if (req.user.role !== 'admin' && req.user.email.toLowerCase() !== 'ia.project.pro2k26@gmail.com') {
      return res.status(403).json({ error: 'Accès strictement réservé aux administrateurs.' });
    }
    next();
  });
}

function addLog(action, details) {
  const db = loadDb();
  if (!db.logs) db.logs = [];
  db.logs.unshift({
    id: 'log_' + Date.now(),
    action,
    details,
    date: new Date().toISOString()
  });
  if (db.logs.length > 50) db.logs.pop();
  saveDb(db);
}

// ---------------- AUTH ROUTES (Direct, No Google) ----------------
app.post('/api/auth/register', (req, res) => {
  const { username, email, password, avatar } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }

  const db = loadDb();
  const existingUser = db.users.find(u => u.email.toLowerCase() === email.toLowerCase() || u.username.toLowerCase() === username.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: 'Cet email ou nom d’utilisateur est déjà utilisé.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const isAdminEmail = email.trim().toLowerCase() === 'ia.project.pro2k26@gmail.com';

  const newUser = {
    id: 'user_' + Date.now(),
    username: username.trim(),
    email: email.trim().toLowerCase(),
    passwordHash,
    role: isAdminEmail ? "admin" : "user",
    isVip: isAdminEmail,
    vipExpiry: isAdminEmail ? "2030-01-01" : null,
    avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
    bio: 'Membre créateur sur la plateforme !',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveDb(db);

  addLog('Inscription Utilisateur', `Nouveau compte: ${newUser.username} (${newUser.email})`);

  const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = newUser;

  res.status(201).json({
    message: 'Compte créé avec succès !',
    token,
    user: userSafe
  });
});

app.post('/api/auth/login', (req, res) => {
  const { emailOrUsername, password } = req.body;
  if (!emailOrUsername || !password) {
    return res.status(400).json({ error: 'Veuillez renseigner votre identifiant et mot de passe.' });
  }

  const db = loadDb();
  const query = emailOrUsername.trim().toLowerCase();
  const user = db.users.find(u => u.email.toLowerCase() === query || u.username.toLowerCase() === query);

  if (!user) {
    return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }

  const isMatch = bcrypt.compareSync(password, user.passwordHash);
  if (!isMatch) {
    return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }

  if (user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
    user.role = 'admin';
    user.isVip = true;
    saveDb(db);
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = user;

  res.json({
    message: 'Connexion réussie !',
    token,
    user: userSafe
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const { passwordHash: _, ...userSafe } = req.user;
  res.json({ user: userSafe });
});

// Update Profile (Nickname, Bio, Avatar)
app.put('/api/user/profile', authenticate, upload.single('avatarFile'), (req, res) => {
  const { username, bio, avatarUrl } = req.body;
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  if (username && username.trim()) {
    const trimmedUser = username.trim();
    const existing = db.users.find(u => u.id !== user.id && u.username.toLowerCase() === trimmedUser.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Ce surnom/pseudo est déjà utilisé.' });
    }
    user.username = trimmedUser;
  }

  if (typeof bio === 'string') {
    user.bio = bio.trim();
  }

  if (req.file) {
    user.avatar = `/uploads/${req.file.filename}`;
  } else if (avatarUrl && avatarUrl.trim()) {
    user.avatar = avatarUrl.trim();
  }

  // Synchronize author name and avatar on user's videos
  db.videos.forEach(v => {
    if (v.authorId === user.id) {
      v.authorName = user.username;
      v.authorAvatar = user.avatar;
    }
  });

  saveDb(db);
  addLog('Profil Modifié', `Utilisateur "${user.username}" a mis à jour son profil`);

  const { passwordHash: _, ...userSafe } = user;
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    message: 'Profil mis à jour avec succès ! ',
    token,
    user: userSafe
  });
});

// ---------------- CATEGORIES ROUTES ----------------
app.get('/api/categories', (req, res) => {
  const db = loadDb();
  res.json({ categories: db.categories || [] });
});

// Users and Admin can add categories
app.post('/api/categories', authenticate, (req, res) => {
  const { name, icon, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Le nom de la catégorie est obligatoire.' });
  }

  const db = loadDb();
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  if (db.categories.some(c => c.id === id || c.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Cette catégorie existe déjà.' });
  }

  const newCat = {
    id,
    name: name.trim(),
    icon: icon || '️',
    description: (description || '').trim(),
    createdBy: req.user.username,
    createdAt: new Date().toISOString()
  };

  db.categories.push(newCat);
  saveDb(db);

  addLog('Ajout Catégorie', `Catégorie "${newCat.name}" ajoutée par ${req.user.username}`);

  res.status(201).json({
    message: `La catégorie "${newCat.name}" a été ajoutée avec succès ! `,
    category: newCat,
    categories: db.categories
  });
});

// Admin can edit categories
app.put('/api/categories/:id', requireAdmin, (req, res) => {
  const { name, icon } = req.body;
  const db = loadDb();
  const catId = req.params.id;

  const cat = db.categories.find(c => c.id === catId);
  if (!cat) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  if (name && name.trim()) {
    cat.name = name.trim();
  }
  if (icon && icon.trim()) {
    cat.icon = icon.trim();
  }

  saveDb(db);
  addLog('Modification Catégorie', `Catégorie "${cat.name}" modifiée par Admin`);

  res.json({
    message: `Catégorie "${cat.name}" modifiée avec succès ! `,
    category: cat,
    categories: db.categories
  });
});

// Admin can delete categories (except system ones)
app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  const db = loadDb();
  const catId = req.params.id;

  if (catId === 'all') {
    return res.status(400).json({ error: 'Impossible de supprimer la catégorie système principale.' });
  }

  const index = db.categories.findIndex(c => c.id === catId);
  if (index === -1) {
    return res.status(404).json({ error: 'Catégorie non trouvée.' });
  }

  const deleted = db.categories.splice(index, 1)[0];
  saveDb(db);

  addLog('Suppression Catégorie', `Catégorie "${deleted.name}" supprimée par Admin`);

  res.json({
    message: `Catégorie "${deleted.name}" supprimée avec succès.`,
    categories: db.categories
  });
});

// ---------------- VIDEOS & EXPLORER ROUTES ----------------
app.get('/api/videos', (req, res) => {
  const { category, categories, region, search, userId } = req.query;
  const db = loadDb();
  let list = [...db.videos];

  if (userId) {
    list = list.filter(v => v.authorId === userId);
  } else {
    list = list.filter(v => v.status === 'approved');
  }

  // Multi-categories filter (e.g. ?categories=tech,gaming or single ?category=tech)
  let targetCats = [];
  if (categories) {
    targetCats = categories.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
  } else if (category && category !== 'all') {
    targetCats = [category.trim().toLowerCase()];
  }

  if (targetCats.length > 0 && !targetCats.includes('all')) {
    list = list.filter(v => {
      const vCats = (v.categories && Array.isArray(v.categories) ? v.categories : [v.category]).map(c => (c || '').toLowerCase());
      return targetCats.some(tc => vCats.includes(tc));
    });
  }

  // Region filter
  if (region && region !== 'all') {
    list = list.filter(v => v.region && v.region.toLowerCase() === region.toLowerCase());
  }

  if (search) {
    const s = search.toLowerCase();
    list = list.filter(v => {
      const titleMatch = v.title && v.title.toLowerCase().includes(s);
      const descMatch = v.description && v.description.toLowerCase().includes(s);
      const authorMatch = v.authorName && v.authorName.toLowerCase().includes(s);
      const regionMatch = v.region && v.region.toLowerCase().includes(s);
      const catMatch = (v.categories || [v.category]).some(c => (c || '').toLowerCase().includes(s));
      return titleMatch || descMatch || authorMatch || regionMatch || catMatch;
    });
  }

  list.sort((a, b) => {
    if (a.isVipAuthor && !b.isVipAuthor) return -1;
    if (!a.isVipAuthor && b.isVipAuthor) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({ videos: list });
});

// Explorer Directory : group videos by category for fast search
app.get('/api/explorer', (req, res) => {
  const db = loadDb();
  const approved = db.videos.filter(v => v.status === 'approved');

  const categoriesWithVideos = db.categories
    .filter(c => c.id !== 'all')
    .map(c => {
      const matchingVideos = approved.filter(v => {
        const vCats = v.categories || [v.category];
        return vCats.includes(c.id);
      });
      return {
        id: c.id,
        name: c.name,
        icon: c.icon || '️',
        description: c.description || '',
        count: matchingVideos.length,
        videos: matchingVideos.slice(0, 6)
      };
    });

  res.json({
    totalVideos: approved.length,
    categories: categoriesWithVideos
  });
});

// Optional Auth Helper for upload
function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const db = loadDb();
      const user = db.users.find(u => u.id === decoded.userId);
      if (user) {
        if (user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
          user.role = 'admin';
        }
        req.user = user;
      }
    } catch (e) {}
  }
  next();
}

app.post('/api/videos/upload', optionalAuthenticate, upload.fields([
  { name: 'videoFile', maxCount: 1 },
  { name: 'thumbnailFile', maxCount: 1 }
]), async (req, res) => {
  const { title, description, category, categories, email, uploaderEmail, region, uploaderRegion, externalVideoUrl, customThumbnailUrl } = req.body;

  const resolvedEmail = (req.user ? req.user.email : (uploaderEmail || email || '')).trim().toLowerCase();
  const resolvedRegion = (region || uploaderRegion || 'Île-de-France').trim();

  if (!resolvedEmail) {
    return res.status(400).json({ error: 'L\'adresse e-mail est obligatoire pour déposer une vidéo.' });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedEmail)) {
    return res.status(400).json({ error: 'Veuillez saisir une adresse e-mail valide.' });
  }

  const finalTitle = (title || '').trim() || `Vidéo partagée depuis ${resolvedRegion}`;

  let videoUrl = '';
  if (req.files && req.files['videoFile'] && req.files['videoFile'][0]) {
    const videoFile = req.files['videoFile'][0];
    const supabaseUrl = await uploadToSupabaseStorage('videos', videoFile.path, videoFile.filename, videoFile.mimetype);
    videoUrl = supabaseUrl || `/uploads/${videoFile.filename}`;
  } else if (externalVideoUrl) {
    videoUrl = externalVideoUrl;
  } else {
    videoUrl = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  }

  let thumbnail = '';
  if (req.files && req.files['thumbnailFile'] && req.files['thumbnailFile'][0]) {
    const thumbFile = req.files['thumbnailFile'][0];
    const supabaseThumbUrl = await uploadToSupabaseStorage('thumbnails', thumbFile.path, thumbFile.filename, thumbFile.mimetype);
    thumbnail = supabaseThumbUrl || `/uploads/${thumbFile.filename}`;
  } else if (customThumbnailUrl) {
    thumbnail = customThumbnailUrl;
  } else {
    thumbnail = "https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=600&auto=format&fit=crop&q=80";
  }

  // Parse categories list
  let parsedCategories = [];
  if (Array.isArray(categories)) {
    parsedCategories = categories;
  } else if (typeof categories === 'string') {
    try {
      const arr = JSON.parse(categories);
      if (Array.isArray(arr)) parsedCategories = arr;
    } catch (e) {
      parsedCategories = categories.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  if (parsedCategories.length === 0 && category) {
    parsedCategories = [category];
  }
  if (parsedCategories.length === 0) {
    parsedCategories = ['tech'];
  }

  const db = loadDb();
  const isAdminUser = req.user && (req.user.role === 'admin' || req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com');
  const authorName = req.user ? req.user.username : resolvedEmail.split('@')[0];
  const authorAvatar = req.user ? req.user.avatar : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authorName)}`;

  const newVideo = {
    id: 'vid_' + Date.now(),
    title: finalTitle,
    description: (description || '').trim(),
    videoUrl,
    thumbnail,
    authorId: req.user ? req.user.id : 'guest_' + Date.now(),
    authorName,
    authorEmail: resolvedEmail,
    authorAvatar,
    region: resolvedRegion,
    isGuest: !req.user,
    isVipAuthor: Boolean(req.user && req.user.isVip),
    category: parsedCategories[0],
    categories: parsedCategories,
    status: isAdminUser ? 'approved' : 'pending',
    views: 1,
    likes: 0,
    duration: "0:30",
    createdAt: new Date().toISOString()
  };

  db.videos.unshift(newVideo);
  saveDb(db);

  addLog('Dépôt Vidéo (Sans connexion)', `Vidéo "${newVideo.title}" (${newVideo.region}) déposée par ${resolvedEmail}`);

  res.status(201).json({
    message: isAdminUser 
      ? 'Votre vidéo a été publiée directement ! ' 
      : 'Votre vidéo a été envoyée avec succès ! Elle sera vérifiée et mise en ligne très rapidement par notre équipe. ',
    video: newVideo
  });
});

app.post('/api/videos/:id/like', (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo non trouvée.' });
  }
  video.likes = (video.likes || 0) + 1;

  let convertedToVip = false;
  // Threshold: reaching 5 likes automatically converts free video to VIP Exclusive
  const VIP_LIKE_THRESHOLD = 5;
  if (video.likes >= VIP_LIKE_THRESHOLD && !video.isVipExclusive) {
    video.isVipExclusive = true;
    convertedToVip = true;
    addLog('Conversion VIP Automatique', `La vidéo "${video.title}" a atteint ${video.likes} mentions J'aime et est automatiquement passée en Contenu Exclusif VIP.`);
  }

  saveDb(db);
  res.json({
    likes: video.likes,
    isVipExclusive: !!video.isVipExclusive,
    convertedToVip,
    message: convertedToVip ? "Cette vidéo populaire a atteint 5 mentions J'aime et est désormais passée en Contenu Exclusif VIP !" : null
  });
});

app.post('/api/admin/videos/:id/toggle-vip-exclusive', requireAdmin, (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }
  video.isVipExclusive = !video.isVipExclusive;
  saveDb(db);
  addLog('Modération VIP', `Vidéo "${video.title}" statut VIP Exclusif : ${video.isVipExclusive}`);
  res.json({
    message: video.isVipExclusive ? 'Vidéo désormais réservée aux membres VIP.' : 'Vidéo remise en accès gratuit.',
    isVipExclusive: video.isVipExclusive
  });
});

// Rate video (0 to 5 stars)
app.post('/api/videos/:id/rate', (req, res) => {
  const ratingValue = parseFloat(req.body.rating);
  if (isNaN(ratingValue) || ratingValue < 0 || ratingValue > 5) {
    return res.status(400).json({ error: 'La note doit être comprise entre 0 et 5.' });
  }

  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  video.ratingCount = (video.ratingCount || 0) + 1;
  video.ratingSum = (video.ratingSum || (video.rating ? video.rating * (video.ratingCount - 1) : 0)) + ratingValue;
  video.rating = parseFloat((video.ratingSum / video.ratingCount).toFixed(1));

  saveDb(db);

  res.json({
    rating: video.rating,
    ratingCount: video.ratingCount,
    message: `Merci pour votre note de ${ratingValue}/5 !`
  });
});

// ---------------- COMMENTS & SIMILAR VIDEOS & TAG EDIT ENDPOINTS ----------------
// Get comments for a video
app.get('/api/videos/:id/comments', (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }
  const comments = video.comments || [];
  res.json({ comments });
});

// Post a comment on a video
app.post('/api/videos/:id/comments', optionalAuthenticate, (req, res) => {
  const { text, authorName } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Veuillez saisir un texte de commentaire valide.' });
  }

  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const resolvedAuthorName = (req.user ? req.user.username : (authorName || 'Visiteur')).trim();
  const resolvedAvatar = req.user ? req.user.avatar : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(resolvedAuthorName)}`;

  const newComment = {
    id: 'comm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    videoId: video.id,
    authorId: req.user ? req.user.id : null,
    authorName: resolvedAuthorName,
    authorAvatar: resolvedAvatar,
    isVip: Boolean(req.user && req.user.isVip),
    isAdmin: Boolean(req.user && (req.user.role === 'admin' || req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com')),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };

  video.comments = video.comments || [];
  video.comments.unshift(newComment);
  saveDb(db);

  addLog('Nouveau Commentaire', `Commentaire ajouté sur "${video.title}" par ${resolvedAuthorName}`);

  res.status(201).json({
    message: 'Commentaire publié avec succès ! ',
    comment: newComment,
    comments: video.comments
  });
});

// Delete a comment (SEUL L'ADMINISTRATEUR PEUT SUPPRIMER)
app.delete('/api/videos/:id/comments/:commentId', requireAdmin, (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video || !video.comments) {
    return res.status(404).json({ error: 'Commentaire introuvable.' });
  }

  const commentIndex = video.comments.findIndex(c => c.id === req.params.commentId);
  if (commentIndex === -1) {
    return res.status(404).json({ error: 'Commentaire introuvable.' });
  }

  const removed = video.comments.splice(commentIndex, 1)[0];
  saveDb(db);

  addLog('Suppression Commentaire', `Commentaire de "${removed.authorName}" sur "${video.title}" supprimé par Admin (${req.user.username})`);

  res.json({
    message: 'Commentaire supprimé par l\'administrateur avec succès.',
    comments: video.comments
  });
});

// ---------------- INTERNAL MESSAGING SYSTEM (MESSAGERIE PRIVÉE) ----------------
// Get conversations list
app.get('/api/messages/conversations', optionalAuthenticate, (req, res) => {
  const db = loadDb();
  db.messages = db.messages || [];

  const myUsername = (req.user ? req.user.username : (req.query.username || '')).trim().toLowerCase();
  if (!myUsername) {
    return res.json({ conversations: [] });
  }

  // Filter messages involving this user
  const userMessages = db.messages.filter(m => 
    (m.senderName && m.senderName.toLowerCase() === myUsername) ||
    (m.recipientName && m.recipientName.toLowerCase() === myUsername)
  );

  // Group by conversation partner
  const conversationsMap = new Map();
  userMessages.forEach(m => {
    const isSender = m.senderName.toLowerCase() === myUsername;
    const partnerName = isSender ? m.recipientName : m.senderName;
    const partnerAvatar = isSender ? m.recipientAvatar : m.senderAvatar;

    if (!conversationsMap.has(partnerName.toLowerCase())) {
      conversationsMap.set(partnerName.toLowerCase(), {
        partnerName,
        partnerAvatar: partnerAvatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(partnerName)}`,
        lastMessage: m.text,
        lastMessageTime: m.createdAt,
        unreadCount: (!isSender && !m.read) ? 1 : 0
      });
    } else {
      const conv = conversationsMap.get(partnerName.toLowerCase());
      if (new Date(m.createdAt) > new Date(conv.lastMessageTime)) {
        conv.lastMessage = m.text;
        conv.lastMessageTime = m.createdAt;
      }
      if (!isSender && !m.read) {
        conv.unreadCount++;
      }
    }
  });

  const list = Array.from(conversationsMap.values()).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
  res.json({ conversations: list });
});

// Get messages with a specific user
app.get('/api/messages/with/:username', optionalAuthenticate, (req, res) => {
  const db = loadDb();
  db.messages = db.messages || [];

  const myUsername = (req.user ? req.user.username : (req.query.username || '')).trim().toLowerCase();
  const targetUsername = req.params.username.trim().toLowerCase();

  if (!myUsername) {
    return res.status(400).json({ error: 'Identifiant utilisateur requis.' });
  }

  const thread = db.messages.filter(m => 
    (m.senderName.toLowerCase() === myUsername && m.recipientName.toLowerCase() === targetUsername) ||
    (m.senderName.toLowerCase() === targetUsername && m.recipientName.toLowerCase() === myUsername)
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Mark messages from partner as read
  let updated = false;
  thread.forEach(m => {
    if (m.recipientName.toLowerCase() === myUsername && !m.read) {
      m.read = true;
      updated = true;
    }
  });
  if (updated) saveDb(db);

  res.json({
    partnerUsername: req.params.username,
    messages: thread
  });
});

// Send a direct message
app.post('/api/messages/send', optionalAuthenticate, (req, res) => {
  const { recipientUsername, text, senderName } = req.body;
  if (!recipientUsername || !recipientUsername.trim()) {
    return res.status(400).json({ error: 'Destinataire manquant.' });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
  }

  const db = loadDb();
  db.messages = db.messages || [];

  const mySenderName = (req.user ? req.user.username : (senderName || 'Visiteur')).trim();
  const myAvatar = req.user ? req.user.avatar : `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(mySenderName)}`;

  // Find recipient avatar if registered
  const recipientUser = db.users.find(u => u.username.toLowerCase() === recipientUsername.trim().toLowerCase());
  const recipientAvatar = recipientUser ? recipientUser.avatar : `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(recipientUsername)}`;

  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    senderId: req.user ? req.user.id : null,
    senderName: mySenderName,
    senderAvatar: myAvatar,
    recipientId: recipientUser ? recipientUser.id : null,
    recipientName: recipientUsername.trim(),
    recipientAvatar: recipientAvatar,
    text: text.trim(),
    read: false,
    createdAt: new Date().toISOString()
  };

  db.messages.push(newMsg);
  saveDb(db);

  addLog('Message Envoyé', `Message de "${mySenderName}" à "${newMsg.recipientName}"`);

  res.status(201).json({
    message: 'Message envoyé avec succès ! ️',
    msg: newMsg
  });
});

// Get similar videos based on shared categories/tags
app.get('/api/videos/:id/similar', (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.json({ similar: [] });
  }

  const videoCats = (video.categories || [video.category] || []).map(c => (c || '').toLowerCase());
  const approved = db.videos.filter(v => v.status === 'approved' && v.id !== video.id);

  const scored = approved.map(v => {
    const vCats = (v.categories || [v.category] || []).map(c => (c || '').toLowerCase());
    const commonCount = vCats.filter(c => videoCats.includes(c)).length;
    return { video: v, score: commonCount };
  });

  scored.sort((a, b) => b.score - a.score || new Date(b.video.createdAt) - new Date(a.video.createdAt));
  const result = scored.slice(0, 6).map(s => s.video);

  res.json({ similar: result });
});

// Admin update video tags
app.put('/api/admin/videos/:id/tags', requireAdmin, (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const { categories } = req.body;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: 'Veuillez spécifier au moins une catégorie/tag.' });
  }

  video.categories = categories;
  video.category = categories[0];
  saveDb(db);

  addLog('Modification Tags Vidéo', `Tags de la vidéo "${video.title}" mis à jour par Admin: ${categories.join(', ')}`);

  res.json({
    message: 'Tags mis à jour avec succès ! ',
    video
  });
});

// ---------------- ADMIN ADVANCED MODERATION ROUTES (Shop Ton Partiel Style) ----------------
app.get('/api/admin/videos', requireAdmin, (req, res) => {
  const { status, category, search } = req.query;
  const db = loadDb();
  let list = [...db.videos];

  if (status && status !== 'all') {
    list = list.filter(v => v.status === status);
  }
  if (category && category !== 'all') {
    list = list.filter(v => (v.categories || [v.category]).includes(category));
  }
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(v => v.title.toLowerCase().includes(s) || v.authorName.toLowerCase().includes(s));
  }

  res.json({ videos: list });
});

app.post('/api/admin/videos/:id/approve', requireAdmin, (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  video.status = 'approved';
  video.publishedAt = new Date().toISOString();
  saveDb(db);

  addLog('Validation Vidéo', `Vidéo "${video.title}" validée et publiée par Admin`);

  res.json({
    message: `La vidéo "${video.title}" a été validée et mise en ligne ! `,
    video
  });
});

app.post('/api/admin/videos/:id/toggle-daily', requireAdmin, (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  video.isDailyFeatured = !video.isDailyFeatured;
  if (video.isDailyFeatured) {
    video.featuredDate = new Date().toISOString().split('T')[0];
  }

  saveDb(db);
  addLog('Sélection du Jour', `Vidéo "${video.title}" ${video.isDailyFeatured ? 'marquée comme Vidéo du Jour ' : 'retirée de la sélection du jour'}`);

  res.json({
    message: video.isDailyFeatured 
      ? ` "${video.title}" a été ajoutée à la Sélection du Jour !` 
      : `"${video.title}" a été retirée de la Sélection du Jour.`,
    isDailyFeatured: video.isDailyFeatured,
    video
  });
});

app.post('/api/admin/videos/:id/reject', requireAdmin, (req, res) => {
  const db = loadDb();
  const index = db.videos.findIndex(v => v.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const removed = db.videos.splice(index, 1)[0];
  saveDb(db);

  addLog('Refus Vidéo', `Vidéo "${removed.title}" refusée/supprimée par Admin`);

  res.json({
    message: `La vidéo "${removed.title}" a été supprimée. `
  });
});

app.put('/api/admin/videos/:id', requireAdmin, (req, res) => {
  const { title, description, category, categories, thumbnail } = req.body;
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  if (title) video.title = title.trim();
  if (description !== undefined) video.description = description.trim();
  
  if (Array.isArray(categories) && categories.length > 0) {
    video.categories = categories;
    video.category = categories[0];
  } else if (category) {
    video.category = category;
    if (!video.categories || video.categories.length === 0) {
      video.categories = [category];
    }
  }

  // Process and save thumbnail captured by admin
  if (thumbnail && typeof thumbnail === 'string') {
    if (thumbnail.startsWith('data:image')) {
      try {
        const matches = thumbnail.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const buffer = Buffer.from(matches[2], 'base64');
          const filename = `thumb_admin_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.jpg`;
          const filepath = path.join(uploadsDir, filename);
          fs.writeFileSync(filepath, buffer);
          video.thumbnail = `/uploads/${filename}`;
        }
      } catch (e) {
        console.error('Error saving base64 thumbnail:', e);
      }
    } else if (thumbnail.trim()) {
      video.thumbnail = thumbnail.trim();
    }
  }

  saveDb(db);
  addLog('Modification Vidéo', `Métadonnées et miniature de "${video.title}" mises à jour par Admin`);

  res.json({ message: 'Vidéo et miniature mises à jour avec succès ! ', video });
});

// ---------------- CONTENT ABUSE REPORTS (SIGNALEMENTS DE CONTENU ABUSIF / DMCA) ----------------
app.post('/api/reports/submit', (req, res) => {
  const { fullName, email, videoUrl, videoTitle, reason, details, signature } = req.body;
  if (!fullName || !email || !reason || !signature) {
    return res.status(400).json({ error: 'Veuillez remplir tous les champs obligatoires (*).' });
  }

  const db = loadDb();
  db.reports = db.reports || [];

  const newReport = {
    id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    fullName: fullName.trim(),
    email: email.trim(),
    videoUrl: (videoUrl || '').trim(),
    videoTitle: (videoTitle || '').trim(),
    reason: reason.trim(),
    details: (details || '').trim(),
    signature: signature.trim(),
    status: 'pending', // pending, reviewed, resolved
    createdAt: new Date().toISOString()
  };

  db.reports.unshift(newReport);
  saveDb(db);

  addLog('Signalement Abus', `Signalement reçu pour "${newReport.videoTitle || newReport.videoUrl}" (Motif : ${newReport.reason}) par ${newReport.fullName}`);

  res.status(201).json({
    message: 'Votre signalement a été enregistré avec succès et transmis à notre équipe de modération. Il sera traité sous 24h à 48h.',
    report: newReport
  });
});

// ---------------- CONTACT FORM MESSAGES ----------------
app.post('/api/contact/submit', (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'Veuillez remplir tous les champs obligatoires (*).' });
  }

  const db = loadDb();
  db.contactMessages = db.contactMessages || [];

  const newContact = {
    id: 'contact_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    name: name.trim(),
    email: email.trim(),
    subject: subject.trim(),
    message: message.trim(),
    createdAt: new Date().toISOString()
  };

  db.contactMessages.unshift(newContact);
  saveDb(db);

  addLog('Contact', `Nouveau message de ${newContact.name} (${newContact.email}) - Objet: ${newContact.subject}`);

  res.status(201).json({
    message: 'Votre message a été envoyé avec succès ! Notre équipe vous répondra dans les plus brefs délais.',
    contact: newContact
  });
});

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const db = loadDb();
  res.json({ reports: db.reports || [] });
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, (req, res) => {
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  rep.status = 'resolved';
  rep.resolvedAt = new Date().toISOString();
  saveDb(db);

  addLog('Signalement Traité', `Signalement #${rep.id} marqué comme résolu par Admin`);
  res.json({ message: 'Signalement marqué comme traité.', report: rep });
});

// Admin Users Management
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = loadDb();
  const safeUsers = db.users.map(({ passwordHash, ...u }) => u);
  res.json({ users: safeUsers });
});

app.post('/api/admin/users/:id/toggle-vip', requireAdmin, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  user.isVip = !user.isVip;
  if (user.isVip) {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);
    user.vipExpiry = expiry.toISOString().split('T')[0];
  } else {
    user.vipExpiry = null;
  }

  db.videos.forEach(v => {
    if (v.authorId === user.id) v.isVipAuthor = user.isVip;
  });

  saveDb(db);
  addLog('Gestion VIP', `Statut VIP de ${user.username} défini à ${user.isVip ? 'ACTIF' : 'INACTIF'}`);

  const { passwordHash: _, ...userSafe } = user;
  res.json({ message: `Statut VIP mis à jour pour ${user.username}`, user: userSafe });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = loadDb();
  const totalViews = db.videos.reduce((acc, v) => acc + (v.views || 0), 0);
  const totalLikes = db.videos.reduce((acc, v) => acc + (v.likes || 0), 0);
  const totalVips = db.users.filter(u => u.isVip).length;

  res.json({
    totalUsers: db.users.length,
    totalVideos: db.videos.length,
    approvedVideos: db.videos.filter(v => v.status === 'approved').length,
    pendingVideos: db.videos.filter(v => v.status === 'pending').length,
    totalCategories: db.categories.length,
    totalViews,
    totalLikes,
    totalVips,
    logs: db.logs || []
  });
});

// ---------------- VIP SUBSCRIPTION (9,99€) ----------------
app.post('/api/vip/subscribe', authenticate, (req, res) => {
  const { durationMonths } = req.body;
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const months = durationMonths || 1;
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + months);

  user.isVip = true;
  user.vipExpiry = expiry.toISOString().split('T')[0];

  db.videos.forEach(v => {
    if (v.authorId === user.id) {
      v.isVipAuthor = true;
    }
  });

  saveDb(db);
  addLog('Abonnement VIP', `${user.username} a souscrit au Pass VIP 9,99€`);

  const { passwordHash: _, ...userSafe } = user;
  res.json({
    message: 'Félicitations ! Vous êtes désormais Membre VIP  (9,99€)',
    user: userSafe,
    amount: "9.99€",
    validUntil: user.vipExpiry
  });
});

// ---------------- FAQ ROUTE ----------------
app.get('/api/faq', (req, res) => {
  const db = loadDb();
  res.json({ faqs: db.faqs });
});

// ---------------- ADMIN DEDICATED ROUTE ----------------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'production' || require.main === module) {
  app.listen(PORT, () => {
    console.log(` Serveur démarré avec succès sur http://localhost:${PORT}`);
  });
}

module.exports = app;
