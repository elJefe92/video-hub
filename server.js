require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { loadDb, saveDb, syncDbFromCloud, syncDbToCloud } = require('./database');
const { supabase } = require('./supabase');
const { isBunnyConfigured, uploadToBunnyStream } = require('./bunnyStream');
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ia_project_video_hub_secret_2026';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Automatically sync latest cloud state on every API request across all serverless lambdas
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/api/')) {
    syncDbFromCloud()
      .then(() => next())
      .catch(() => next());
  } else {
    next();
  }
});

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

async function uploadBase64ToSupabaseStorage(bucket, base64Data, filename) {
  if (!supabase || !base64Data || !base64Data.startsWith('data:')) return null;
  try {
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    const contentType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = contentType.split('/')[1] || 'jpg';
    const cleanFilename = (filename || ('thumb-' + Date.now())) + '.' + ext;

    const { data, error } = await supabase.storage.from(bucket).upload(cleanFilename, buffer, {
      contentType: contentType,
      upsert: true
    });
    if (error) {
      console.error(`Supabase base64 upload error (${bucket}):`, error);
      return null;
    }
    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(cleanFilename);
    return publicData ? publicData.publicUrl : null;
  } catch (err) {
    console.error(`Error uploading base64 to Supabase (${bucket}):`, err);
    return null;
  }
}

app.get('/api/debug-supabase', async (req, res) => {
  if (!supabase) {
    return res.json({ supabaseConfigured: false, envUrl: !!process.env.SUPABASE_URL, envKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY });
  }
  try {
    const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
    const testUpload = await supabase.storage.from('thumbnails').upload('test_ping.json', JSON.stringify({ ping: Date.now() }), { upsert: true, contentType: 'application/json' });
    const { data: dlData, error: dlErr } = await supabase.storage.from('thumbnails').download('videohub_db_state.json');
    res.json({
      supabaseConfigured: true,
      buckets: buckets || [],
      bucketError: bErr ? bErr.message : null,
      testUploadError: testUpload.error ? testUpload.error.message : null,
      downloadError: dlErr ? dlErr.message : null,
      hasStateFile: !!dlData
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Mail Transporter for Welcome & Notification Emails
let mailTransporter = null;

function getMailTransporter() {
  if (mailTransporter) return mailTransporter;

  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER || 'ia.project.pro2k26@gmail.com';
  const smtpPass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || 'rxcqdfrtywmzzaym').replace(/\s+/g, '');

  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });

  return mailTransporter;
}

async function sendRobustEmail({ to, subject, html, text, replyTo, category }) {
  if (!to) return false;
  const senderAddress = process.env.SMTP_USER || 'ia.project.pro2k26@gmail.com';
  const transporter = getMailTransporter();
  const cleanId = `vh-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@gmail.com`;

  const mailOptions = {
    from: `"VideoHub Support" <${senderAddress}>`,
    to: to.trim(),
    replyTo: replyTo || senderAddress,
    subject: subject,
    html: html,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    messageId: `<${cleanId}>`,
    date: new Date(),
    headers: {
      'List-Unsubscribe': `<mailto:${senderAddress}?subject=Desinscription>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Entity-Ref-ID': `VH-${Date.now()}`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'Auto-Submitted': 'auto-generated',
      'Feedback-ID': `VID_HUB:${category || 'TRANSACTIONAL'}:1:GMAIL`
    }
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Email Delivered] ${subject} successfully sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email Delivery Error] Failed sending to ${to}:`, err.message);
    return false;
  }
}

// Helper: add a notification to a user
function addNotificationToUser(db, userId, { type, message, link }) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return;
  if (!user.notifications) user.notifications = [];
  user.notifications.unshift({
    id: 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type,
    message,
    link: link || null,
    read: false,
    createdAt: new Date().toISOString()
  });
  // Keep last 30 notifications
  if (user.notifications.length > 30) user.notifications = user.notifications.slice(0, 30);
}

async function sendWelcomeEmail(toEmail, username) {
  if (!toEmail) return false;
  const siteUrl = 'https://video-hub-mu-nine.vercel.app';
  const tpl = generateEmailTemplate('welcome', { username, toEmail });
  return await sendRobustEmail({
    to: toEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    category: 'WELCOME'
  });
}

async function sendVerificationEmail(toEmail, username, verificationCode) {
  if (!toEmail) return false;
  const tpl = generateEmailTemplate('verify_email', { username, toEmail, code: verificationCode });
  return await sendRobustEmail({
    to: toEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    category: 'SECURITY'
  });
}

// In-memory store for password reset codes: email -> { code, expiresAt, userId }
const passwordResetCodes = new Map();

// In-memory rate limiting: IP -> { count, firstAttempt, lockedUntil }
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_LOCK_MS = 15 * 60 * 1000; // 15 minutes lock

async function sendPasswordResetEmail(toEmail, username, resetCode) {
  if (!toEmail) return false;
  const tpl = generateEmailTemplate('reset_pwd', { username, toEmail, code: resetCode });
  return await sendRobustEmail({
    to: toEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    category: 'SECURITY'
  });
}

// Unified Email Templates Generator for VideoHub
function generateEmailTemplate(type, data = {}) {
  const siteUrl = 'https://video-hub-mu-nine.vercel.app';
  const username = data.username || 'Cher Membre';
  const toEmail = data.toEmail || 'contact@exemple.fr';

  const baseHeader = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155;">
      <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px 24px; text-align: center;">
        <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">Video<span style="color: #0f172a; background: #ffffff; padding: 2px 8px; border-radius: 6px; margin-left: 4px;">Hub</span></h1>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600;">Plateforme & Hub Vidéo Communautaire</p>
      </div>
      <div style="padding: 30px 24px; line-height: 1.6;">
  `;

  const baseFooter = `
        <div style="margin-top: 30px; text-align: center;">
          <a href="${siteUrl}" style="background-color: #f97316; color: #ffffff; text-decoration: none; padding: 13px 26px; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block;">
            Accéder à VideoHub
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; border-top: 1px solid #334155; padding-top: 18px; margin-top: 25px; margin-bottom: 0;">
          E-mail de notification officiel • Destinataire : <strong>${toEmail}</strong><br>
          VideoHub - Tous droits réservés.
        </p>
      </div>
    </div>
  `;

  switch(type) {
    case 'verify_email':
      const verifyCode = data.code || '123456';
      return {
        name: 'Vérification d\'inscription (Code 6 chiffres)',
        subject: 'Confirmation de votre adresse e-mail - VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Merci de rejoindre <strong>VideoHub</strong>. Pour valider votre adresse e-mail et finaliser la création de votre compte, veuillez saisir le code de vérification ci-dessous :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 22px; text-align: center; margin: 24px 0; border: 1px dashed #f97316;">
            <span style="font-size: 34px; font-weight: 900; letter-spacing: 8px; color: #f97316; font-family: monospace;">${verifyCode}</span>
            <p style="color: #94a3b8; font-size: 12px; margin: 8px 0 0 0;">Ce code de sécurité expire dans 15 minutes.</p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité. Aucun compte ne sera créé.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVotre code de confirmation VideoHub est : ${verifyCode}\nCe code expire dans 15 minutes.\n\nAccéder à VideoHub : ${siteUrl}`
      };

    case 'welcome':
      return {
        name: 'Bienvenue & Inscription',
        subject: 'Bienvenue sur VideoHub - Votre compte a été créé avec succès',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bienvenue sur VideoHub, ${username} !</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Votre compte a bien été créé avec succès. Vous pouvez dès à présent vous connecter et profiter de tous nos services :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #334155;">
            <ul style="color: #cbd5e1; font-size: 14px; margin: 0; padding-left: 18px; line-height: 1.9;">
              <li><strong>Partager vos vidéos</strong> en haute définition avec la communauté</li>
              <li><strong>Interagir :</strong> likes, commentaires et retours en direct</li>
              <li><strong>Accéder aux sélections exclusives</strong> et profils créateurs</li>
            </ul>
          </div>
        ` + baseFooter,
        text: `Bienvenue sur VideoHub, ${username} !\n\nVotre compte a bien été créé avec succès. Vous pouvez dès à présent vous connecter et partager vos vidéos avec la communauté.\n\nAccéder au site : ${siteUrl}\nDestinataire : ${toEmail}`
      };

    case 'reset_pwd':
      const code = data.code || '849201';
      return {
        name: 'Mot de passe oublié (Code 6 chiffres)',
        subject: 'Réinitialisation de votre mot de passe VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Vous avez demandé la réinitialisation de votre mot de passe sur <strong>VideoHub</strong>.
          </p>
          <p style="color: #cbd5e1; font-size: 15px;">
            Voici votre code de sécurité temporaire (valable 15 minutes) :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0; border: 1px dashed #f97316;">
            <span style="font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #f97316; font-family: monospace;">${code}</span>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Entrez ce code sur le site pour définir votre nouveau mot de passe.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVotre code de réinitialisation temporaire VideoHub est : ${code}\n(Valable 15 minutes)\n\nEntrez ce code sur le site pour définir votre nouveau mot de passe : ${siteUrl}`
      };

    case 'video_approved':
      return {
        name: 'Vidéo validée & publiée',
        subject: 'Votre vidéo a été validée et publiée sur VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Félicitations ${username} !</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            L'équipe de modération a examiné et validé votre vidéo intitulée :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #22c55e;">
            <strong style="color: #22c55e; font-size: 16px;">${data.videoTitle || 'Ma Nouvelle Vidéo HD'}</strong>
            <p style="color: #94a3b8; font-size: 13px; margin: 6px 0 0 0;">Catégorie : ${data.videoCategory || 'Général'} • Statut : En ligne</p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Votre vidéo est désormais visible par tous les utilisateurs de la plateforme et commence à accumuler des vues !
          </p>
        ` + baseFooter,
        text: `Félicitations ${username} !\n\nVotre vidéo "${data.videoTitle || 'Ma Nouvelle Vidéo HD'}" a été validée par la modération et est désormais publiée en ligne sur VideoHub : ${siteUrl}`
      };

    case 'video_rejected':
      return {
        name: 'Vidéo refusée (motif modération)',
        subject: 'Notification de modération - Votre vidéo sur VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Après examen par notre équipe de modération, votre vidéo intitulée <strong>"${data.videoTitle || 'Vidéo soumise'}"</strong> n'a pas pu être validée pour publication.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #ef4444;">
            <strong style="color: #ef4444; font-size: 15px;">Motif de modération :</strong>
            <p style="color: #cbd5e1; font-size: 13px; margin: 6px 0 0 0;">${data.reason || 'Non-respect des critères de qualité ou doublon détecté dans la catégorie.'}</p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Vous pouvez à tout moment soumettre une nouvelle vidéo conforme aux conditions d'utilisation.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVotre vidéo "${data.videoTitle || 'Vidéo soumise'}" n'a pas été validée. Motif : ${data.reason || 'Critères de qualité'}.\n\nVous pouvez déposer une nouvelle vidéo sur : ${siteUrl}`
      };

    case 'vip_activated':
      return {
        name: 'Abonnement VIP activé (9,99€)',
        subject: 'Confirmation d\'adhésion - Votre Pass VIP VideoHub est actif',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bienvenue dans le Club VIP, ${username} !</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Votre abonnement <strong>Membre VIP (9,99€ / mois)</strong> a bien été activé avec succès.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #f59e0b;">
            <strong style="color: #f59e0b; font-size: 15px;">Vos avantages VIP actifs :</strong>
            <ul style="color: #cbd5e1; font-size: 13px; margin: 8px 0 0 0; padding-left: 18px; line-height: 1.8;">
              <li>Accès immédiat et illimité à toutes les vidéos exclusives VIP</li>
              <li>Badge VIP doré affiché sur votre profil et vos vidéos</li>
              <li>Navigation fluide sans interruptions publicitaires</li>
              <li>Traitement prioritaire de vos dépôts de vidéos</li>
            </ul>
          </div>
        ` + baseFooter,
        text: `Bienvenue dans le Club VIP, ${username} !\n\nVotre abonnement VIP VideoHub (9,99€ / mois) est actif avec succès.\nProfitez dès maintenant de vos avantages exclusifs sur : ${siteUrl}`
      };

    case 'new_message':
      return {
        name: 'Nouveau message privé reçu',
        subject: 'Nouveau message privé reçu sur VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Vous avez reçu un nouveau message privé sur <strong>VideoHub</strong> de la part de <strong>${data.senderName || 'Alex'}</strong>.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #334155; font-style: italic; color: #cbd5e1;">
            "${data.messagePreview || 'Salut ! J\'ai adoré ta dernière vidéo, bravo !'}"
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Connectez-vous à votre espace messagerie pour lui répondre.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVous avez reçu un nouveau message privé de ${data.senderName || 'Alex'} sur VideoHub :\n"${data.messagePreview || 'Salut !'}"\n\nRépondez sur : ${siteUrl}`
      };

    case 'report_received':
      return {
        name: 'Signalement pris en compte (Takedown)',
        subject: 'Prise en charge de votre signalement VideoHub',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Nous vous confirmons la bonne réception de votre signalement concernant le contenu :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #334155;">
            <strong style="color: #f8fafc; font-size: 14px;">Référence : #${data.reportId || 'SIG-' + Math.floor(10000 + Math.random() * 90000)}</strong>
            <p style="color: #94a3b8; font-size: 13px; margin: 6px 0 0 0;">Motif : ${data.reportReason || 'Demande de vérification de contenu'}</p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Notre équipe de modération traite votre demande dans les plus brefs délais conformément à la législation.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nNous vous confirmons la prise en charge de votre signalement réf #${data.reportId || 'SIG-12345'}.\nNotre équipe de modération traite votre demande dans les plus brefs délais.\n\nVideoHub Support : ${siteUrl}`
      };

    default:
      return {
        name: 'Notification générale',
        subject: 'Notification VideoHub',
        html: baseHeader + `<p>Notification VideoHub</p>` + baseFooter,
        text: `Notification VideoHub\n\nAccéder au site : ${siteUrl}`
      };
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

// Compute and update creator badge level for a user (Bronze/Argent/Or/Platine)
function computeCreatorBadge(userId, db) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return;

  const userVideos = (db.videos || []).filter(v =>
    (v.authorId && v.authorId === userId) || (v.authorEmail && v.authorEmail === user.email)
  );

  const videoCount = userVideos.length;
  const totalViews = userVideos.reduce((s, v) => s + (v.views || 0), 0);
  const totalLikes = userVideos.reduce((s, v) => s + (v.likes || 0), 0);

  let badge = null;
  let badgeLevel = 0;

  if (videoCount >= 25 || totalViews >= 10000 || totalLikes >= 500) {
    badge = 'Platine';
    badgeLevel = 4;
  } else if (videoCount >= 10 || totalViews >= 1000 || totalLikes >= 100) {
    badge = 'Or';
    badgeLevel = 3;
  } else if (videoCount >= 5 || totalViews >= 100 || totalLikes >= 20) {
    badge = 'Argent';
    badgeLevel = 2;
  } else if (videoCount >= 1) {
    badge = 'Bronze';
    badgeLevel = 1;
  }

  user.creatorBadge = badge;
  user.creatorBadgeLevel = badgeLevel;
}

// Reserved admin keywords protected for official administration only
const RESERVED_ADMIN_TERMS = [
  'admin', 'administrateur', 'administrator', 'moderateur', 'modérateur',
  'moderation', 'modération', 'staff', 'root', 'support', 'videohub', 'officiel'
];

function isReservedAdminUsername(username, userEmail) {
  if (!username) return false;
  const lowerUser = username.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, '');
  const isOfficialAdmin = (userEmail || '').trim().toLowerCase() === 'ia.project.pro2k26@gmail.com';
  if (isOfficialAdmin) return false;

  return RESERVED_ADMIN_TERMS.some(term => lowerUser.includes(term.toLowerCase()));
}

// ---------------- AUTH ROUTES (Direct, No Google) ----------------

// 1. Étape 1 : Demande de code de vérification pour inscription
app.post('/api/auth/send-verification-code', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }

  const trimmedUsername = username.trim();
  const trimmedEmail = email.trim().toLowerCase();

  // Validation format email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

  // Vérification pseudo admin réservé
  if (isReservedAdminUsername(trimmedUsername, trimmedEmail)) {
    return res.status(400).json({ 
      error: `Le pseudo "${trimmedUsername}" et les termes associés à l'administration sont strictement réservés au compte administrateur officiel.` 
    });
  }

  await syncDbFromCloud();
  const db = loadDb();

  // Vérification pseudo unique
  const existingUsername = db.users.find(u => u.username && u.username.trim().toLowerCase() === trimmedUsername.toLowerCase());
  if (existingUsername) {
    return res.status(400).json({ error: `Le nom d'utilisateur "${trimmedUsername}" est déjà utilisé. Veuillez en choisir un autre.` });
  }

  // Vérification email unique
  const existingEmail = db.users.find(u => u.email && u.email.trim().toLowerCase() === trimmedEmail);
  if (existingEmail) {
    return res.status(400).json({ error: `L'adresse e-mail "${trimmedEmail}" est déjà associée à un compte.` });
  }

  // Génération du code à 6 chiffres
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const codeHash = bcrypt.hashSync(verificationCode, 8);
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  // Envoi immédiat du code par e-mail
  const emailSent = await sendVerificationEmail(trimmedEmail, trimmedUsername, verificationCode);
  if (!emailSent) {
    return res.status(400).json({ 
      error: "Impossible d'envoyer le code de vérification sur cette adresse e-mail. Veuillez vérifier l'adresse saisie." 
    });
  }

  addLog('Code Vérification Envoyé', `Code d'inscription envoyé à ${trimmedEmail}`);

  // Jeton sécurisé temporaire (15 minutes) contenant les données prêtes à être validées
  const pendingToken = jwt.sign(
    {
      username: trimmedUsername,
      email: trimmedEmail,
      passwordHash,
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedUsername)}`,
      codeHash,
      type: 'registration_pending'
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  res.json({
    success: true,
    message: `Un code de confirmation à 6 chiffres a été envoyé à ${trimmedEmail}.`,
    pendingToken,
    email: trimmedEmail
  });
});

// 2. Étape 2 : Validation du code et création effective du compte
app.post('/api/auth/verify-and-register', async (req, res) => {
  const { pendingToken, code } = req.body;
  if (!pendingToken || !code) {
    return res.status(400).json({ error: 'Code de vérification requis.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(pendingToken, JWT_SECRET);
    if (decoded.type !== 'registration_pending') {
      return res.status(400).json({ error: 'Jeton de vérification invalide.' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Votre code de vérification a expiré (délai de 15 minutes). Veuillez recommencer.' });
  }

  // Vérification de la correspondance du code 6 chiffres
  const cleanCode = code.toString().trim();
  const isMatch = bcrypt.compareSync(cleanCode, decoded.codeHash);
  if (!isMatch) {
    return res.status(400).json({ error: 'Code de vérification incorrect. Veuillez vérifier votre boîte e-mail.' });
  }

  await syncDbFromCloud();
  const db = loadDb();

  // Re-vérification de sécurité de l'unicité
  const existingEmail = db.users.find(u => u.email && u.email.trim().toLowerCase() === decoded.email.toLowerCase());
  if (existingEmail) {
    return res.status(400).json({ error: `L'adresse e-mail "${decoded.email}" est déjà associée à un compte.` });
  }
  const existingUsername = db.users.find(u => u.username && u.username.trim().toLowerCase() === decoded.username.toLowerCase());
  if (existingUsername) {
    return res.status(400).json({ error: `Le nom d'utilisateur "${decoded.username}" est déjà utilisé.` });
  }

  const isAdminEmail = decoded.email === 'ia.project.pro2k26@gmail.com';

  const newUser = {
    id: 'user_' + Date.now(),
    username: decoded.username,
    email: decoded.email,
    passwordHash: decoded.passwordHash,
    role: isAdminEmail ? "admin" : "user",
    isVip: isAdminEmail,
    vipExpiry: isAdminEmail ? "2030-01-01" : null,
    avatar: decoded.avatar,
    bio: 'Membre créateur sur la plateforme !',
    emailVerified: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  if (!db.logs) db.logs = [];
  db.logs.unshift({
    id: 'log_' + Date.now(),
    action: 'Inscription Validée',
    details: `Nouveau compte certifié: ${newUser.username} (${newUser.email})`,
    date: new Date().toISOString()
  });
  if (db.logs.length > 50) db.logs.pop();
  saveDb(db);
  await syncDbToCloud(db);

  // Envoi de l'e-mail de bienvenue
  try {
    await sendWelcomeEmail(newUser.email, newUser.username);
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }

  const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = newUser;

  res.status(201).json({
    message: 'Compte validé et créé avec succès !',
    token,
    user: userSafe
  });
});

// 3. Renvoyer un nouveau code de confirmation
app.post('/api/auth/resend-verification-code', async (req, res) => {
  const { pendingToken } = req.body;
  if (!pendingToken) {
    return res.status(400).json({ error: 'Jeton de vérification manquant.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(pendingToken, JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Session de vérification expirée. Veuillez recommencer.' });
  }

  const newCode = Math.floor(100000 + Math.random() * 900000).toString();
  const newCodeHash = bcrypt.hashSync(newCode, 8);

  const sent = await sendVerificationEmail(decoded.email, decoded.username, newCode);
  if (!sent) {
    return res.status(400).json({ error: "Impossible d'envoyer le nouvel e-mail. Veuillez réessayer plus tard." });
  }

  const refreshedToken = jwt.sign(
    {
      ...decoded,
      codeHash: newCodeHash
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  res.json({
    success: true,
    message: `Nouveau code envoyé à ${decoded.email}.`,
    pendingToken: refreshedToken
  });
});

// Ancien endpoint d'inscription direct (redirige vers le nouveau flux avec code)
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, avatar } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }

  const trimmedUsername = username.trim();
  const trimmedEmail = email.trim().toLowerCase();

  // 1. Reserved admin usernames check
  if (isReservedAdminUsername(trimmedUsername, trimmedEmail)) {
    return res.status(400).json({ 
      error: `Le pseudo "${trimmedUsername}" et les termes associés à l'administration sont strictement réservés au compte administrateur officiel.` 
    });
  }

  await syncDbFromCloud();
  const db = loadDb();

  // 2. Strict unique username check (case-insensitive)
  const existingUsername = db.users.find(u => u.username && u.username.trim().toLowerCase() === trimmedUsername.toLowerCase());
  if (existingUsername) {
    return res.status(400).json({ error: `Le nom d'utilisateur "${trimmedUsername}" est déjà utilisé. Veuillez en choisir un autre.` });
  }

  // 3. Strict unique email check (case-insensitive)
  const existingEmail = db.users.find(u => u.email && u.email.trim().toLowerCase() === trimmedEmail);
  if (existingEmail) {
    return res.status(400).json({ error: `L'adresse e-mail "${trimmedEmail}" est déjà associée à un compte.` });
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const isAdminEmail = trimmedEmail === 'ia.project.pro2k26@gmail.com';

  const newUser = {
    id: 'user_' + Date.now(),
    username: trimmedUsername,
    email: trimmedEmail,
    passwordHash,
    role: isAdminEmail ? "admin" : "user",
    isVip: isAdminEmail,
    vipExpiry: isAdminEmail ? "2030-01-01" : null,
    avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedUsername)}`,
    bio: 'Membre créateur sur la plateforme !',
    emailVerified: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  if (!db.logs) db.logs = [];
  db.logs.unshift({
    id: 'log_' + Date.now(),
    action: 'Inscription Utilisateur',
    details: `Nouveau compte: ${newUser.username} (${newUser.email})`,
    date: new Date().toISOString()
  });
  if (db.logs.length > 50) db.logs.pop();
  saveDb(db);
  await syncDbToCloud(db);

  try {
    await sendWelcomeEmail(newUser.email, newUser.username);
  } catch (err) {
    console.error('Welcome email sending error:', err.message);
  }

  const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = newUser;

  res.status(201).json({
    message: 'Compte créé avec succès ! Un e-mail de bienvenue vous a été envoyé.',
    token,
    user: userSafe
  });
});

// Endpoint to send/resend welcome email to logged-in user
app.post('/api/auth/send-welcome-email', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const ok = await sendWelcomeEmail(user.email, user.username);
    addLog('E-mail Bienvenue', `E-mail de bienvenue envoyé à ${user.email}`);
    res.json({
      success: true,
      message: `E-mail de bienvenue envoyé à ${user.email} ! Vérifiez votre boîte de réception.`
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de l'envoi de l'e-mail." });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { emailOrUsername, password } = req.body;
  if (!emailOrUsername || !password) {
    return res.status(400).json({ error: 'Veuillez renseigner votre identifiant et mot de passe.' });
  }

  // Rate limiting by IP
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(clientIp);
  
  if (attempts) {
    if (attempts.lockedUntil && now < attempts.lockedUntil) {
      const remaining = Math.ceil((attempts.lockedUntil - now) / 60000);
      return res.status(429).json({ 
        error: `Trop de tentatives de connexion. Réessayez dans ${remaining} minute(s).`,
        retryAfter: attempts.lockedUntil
      });
    }
    if (now - attempts.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(clientIp);
    }
  }

  await syncDbFromCloud();
  const db = loadDb();
  const query = emailOrUsername.trim().toLowerCase();
  const user = db.users.find(u => u.email.toLowerCase() === query || u.username.toLowerCase() === query);

  if (!user) {
    // Track failed attempts
    const cur = loginAttempts.get(clientIp) || { count: 0, firstAttempt: Date.now() };
    cur.count += 1;
    if (cur.count >= RATE_LIMIT_MAX) {
      cur.lockedUntil = Date.now() + RATE_LIMIT_LOCK_MS;
    }
    loginAttempts.set(clientIp, cur);
    return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }

  const isMatch = bcrypt.compareSync(password, user.passwordHash);
  if (!isMatch) {
    // Track failed attempts
    const cur = loginAttempts.get(clientIp) || { count: 0, firstAttempt: Date.now() };
    cur.count += 1;
    if (cur.count >= RATE_LIMIT_MAX) {
      cur.lockedUntil = Date.now() + RATE_LIMIT_LOCK_MS;
    }
    loginAttempts.set(clientIp, cur);
    return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }

  loginAttempts.delete(clientIp);

  if (user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
    user.role = 'admin';
    user.isVip = true;
    saveDb(db);
    await syncDbToCloud(db);
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = user;

  res.json({
    message: 'Connexion réussie !',
    token,
    user: userSafe
  });
});

// DELETE account (RGPD - authenticated user)
app.delete('/api/user/account', authenticate, async (req, res) => {
  const user = req.user;
  
  // Admin cannot delete their own account
  const isAdminUser = (user.role === 'admin') || 
                      (user.email && user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') ||
                      (user.username && user.username.toLowerCase() === 'administrateur');

  if (isAdminUser) {
    return res.status(403).json({ error: 'Le compte administrateur est protégé et ne peut pas être supprimé.' });
  }

  const db = loadDb();
  
  // Remove user
  db.users = db.users.filter(u => u.id !== user.id);
  
  // Remove user videos
  const videoCount = (db.videos || []).filter(v => v.authorId === user.id || v.authorEmail === user.email).length;
  db.videos = (db.videos || []).filter(v => v.authorId !== user.id && v.authorEmail !== user.email);
  
  saveDb(db);
  await syncDbToCloud(db);
  
  addLog('Suppression Compte', `Compte supprime: ${user.username} (${user.email}) + ${videoCount} video(s)`);

  // Send farewell email
  try {
    await sendRobustEmail({
      to: user.email,
      subject: 'VideoHub - Votre compte a ete supprime',
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #334155;"><div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:30px 24px;text-align:center;"><h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">VideoHub</h1></div><div style="padding:30px 24px;"><h2>Votre compte a ete supprime</h2><p>Bonjour ${user.username},</p><p>Votre compte VideoHub (${user.email}) ainsi que l'ensemble de vos donnees ont ete definitvement supprimes de notre plateforme, conformement au RGPD.</p><p style="color:#94a3b8;font-size:12px;margin-top:30px;">Si vous n'avez pas fait cette demande, contactez-nous immediatement.</p></div></div>`,
      category: 'ACCOUNT'
    });
  } catch (e) {}

  res.json({ success: true, message: 'Votre compte a ete supprime definitvement.' });
});

// Forgot Password - Request 6-digit Reset Code by Email
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'Veuillez saisir votre adresse e-mail.' });
  }

  const db = loadDb();
  const cleanEmail = email.trim().toLowerCase();
  const user = db.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);

  if (!user) {
    return res.status(404).json({ error: `Aucun compte n'est associé à l'adresse "${cleanEmail}".` });
  }

  // Generate 6-digit code valid for 15 minutes
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 15 * 60 * 1000;

  user.resetCode = code;
  user.resetExpiresAt = expiresAt;
  saveDb(db);

  // Send reset code email
  const sent = await sendPasswordResetEmail(user.email, user.username, code);
  addLog('Demande Mot de Passe Oublié', `Code de réinitialisation généré pour ${user.email}`);

  res.json({
    success: true,
    message: `Un code de sécurité à 6 chiffres a été envoyé à ${user.email}. Pensez à vérifier votre dossier Spam ou Courrier indésirable si l'e-mail tarde à arriver.`
  });
});

// Profil public / membre avec statistiques et vidéos publiées
app.get('/api/users/:id/profile', async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const targetIdOrUsername = (req.params.id || '').trim().toLowerCase();

  const user = db.users.find(u => 
    (u.id && u.id.toLowerCase() === targetIdOrUsername) || 
    (u.username && u.username.toLowerCase() === targetIdOrUsername)
  );

  if (!user) {
    return res.status(404).json({ error: 'Membre introuvable.' });
  }

  // Récupération des vidéos de l'utilisateur
  const userVideos = (db.videos || []).filter(v => 
    (v.authorId && v.authorId === user.id) || 
    (v.authorName && v.authorName.toLowerCase() === user.username.toLowerCase()) ||
    (v.authorEmail && v.authorEmail.toLowerCase() === user.email.toLowerCase())
  );

  const totalViews = userVideos.reduce((sum, v) => sum + (v.views || 0), 0);
  const totalLikes = userVideos.reduce((sum, v) => sum + (v.likes || 0), 0);

  // Recompute badge on profile fetch to keep it fresh
  computeCreatorBadge(user.id, db);

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.username)}`,
    bio: user.bio || 'Membre createur sur la plateforme VideoHub.',
    role: user.role || 'user',
    isVip: Boolean(user.isVip),
    vipExpiry: user.vipExpiry,
    createdAt: user.createdAt || new Date().toISOString(),
    videosCount: userVideos.length,
    totalViews,
    totalLikes,
    creatorBadge: user.creatorBadge || null,
    creatorBadgeLevel: user.creatorBadgeLevel || 0,
    videos: userVideos.map(v => ({
      id: v.id,
      title: v.title,
      thumbnail: v.thumbnail,
      views: v.views || 0,
      likes: v.likes || 0,
      createdAt: v.createdAt
    }))
  });
});

// Toggle favorite video
app.post('/api/user/favorites/:videoId', authenticate, async (req, res) => {
  const videoId = req.params.videoId;
  const user = req.user;
  const db = loadDb();

  const userRecord = db.users.find(u => u.id === user.id);
  if (!userRecord) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  if (!userRecord.favorites) userRecord.favorites = [];

  const idx = userRecord.favorites.indexOf(videoId);
  let added = false;
  if (idx === -1) {
    userRecord.favorites.push(videoId);
    added = true;
  } else {
    userRecord.favorites.splice(idx, 1);
    added = false;
  }

  saveDb(db);
  await syncDbToCloud(db);

  res.json({ success: true, added, favorites: userRecord.favorites });
});

// Get favorites list
app.get('/api/user/favorites', authenticate, async (req, res) => {
  const user = req.user;
  const db = loadDb();
  const userRecord = db.users.find(u => u.id === user.id);
  const favoriteIds = userRecord?.favorites || [];
  const favoriteVideos = (db.videos || []).filter(v => favoriteIds.includes(v.id));
  res.json({ favorites: favoriteIds, videos: favoriteVideos });
});

// GET notifications
app.get('/api/user/notifications', authenticate, (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);
  const notifications = (user?.notifications || []).slice(0, 20);
  const unreadCount = notifications.filter(n => !n.read).length;
  res.json({ notifications, unreadCount });
});

// Mark notification(s) as read
app.put('/api/user/notifications/read-all', authenticate, async (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);
  if (user && user.notifications) {
    user.notifications.forEach(n => { n.read = true; });
    saveDb(db);
    await syncDbToCloud(db);
  }
  res.json({ success: true });
});

app.put('/api/user/notifications/:notifId/read', authenticate, async (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);
  if (user && user.notifications) {
    const notif = user.notifications.find(n => n.id === req.params.notifId);
    if (notif) notif.read = true;
    saveDb(db);
    await syncDbToCloud(db);
  }
  res.json({ success: true });
});

// Reset Password - Verify 6-digit code and set new password
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Veuillez renseigner tous les champs obligatoires.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit comporter au moins 6 caractères.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.toString().trim();

  const db = loadDb();
  const user = db.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);

  if (!user) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  if (!user.resetCode || !user.resetExpiresAt) {
    return res.status(400).json({ error: 'Aucune demande de réinitialisation active pour ce compte.' });
  }

  if (Date.now() > user.resetExpiresAt) {
    user.resetCode = null;
    user.resetExpiresAt = null;
    saveDb(db);
    return res.status(400).json({ error: 'Ce code a expiré. Veuillez refaire une demande.' });
  }

  if (user.resetCode !== cleanCode) {
    return res.status(400).json({ error: 'Code de sécurité incorrect. Vérifiez vos e-mails.' });
  }

  // Hash new password and save
  const salt = bcrypt.genSaltSync(10);
  user.passwordHash = bcrypt.hashSync(newPassword, salt);
  user.resetCode = null;
  user.resetExpiresAt = null;
  saveDb(db);

  addLog('Mot de Passe Réinitialisé', `Nouveau mot de passe défini pour ${user.email}`);

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  const { passwordHash: _, ...userSafe } = user;

  res.json({
    success: true,
    message: 'Votre mot de passe a été modifié avec succès ! Connexion automatique...',
    token,
    user: userSafe
  });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const { passwordHash: _, ...userSafe } = req.user;
  res.json({ user: userSafe });
});

// Update Profile (Nickname, Bio, Avatar)
app.put('/api/user/profile', authenticate, upload.single('avatarFile'), async (req, res) => {
  const { username, bio, avatarUrl } = req.body;
  const db = loadDb();
  const user = db.users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  if (username && username.trim()) {
    const trimmedUser = username.trim();
    if (isReservedAdminUsername(trimmedUser, user.email)) {
      return res.status(400).json({ 
        error: `Le pseudo "${trimmedUser}" et les termes associés à l'administration sont strictement réservés au compte administrateur officiel.` 
      });
    }
    const existing = db.users.find(u => u.id !== user.id && u.username && u.username.trim().toLowerCase() === trimmedUser.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: `Ce nom d'utilisateur/pseudo "${trimmedUser}" est déjà utilisé.` });
    }
    user.username = trimmedUser;
  }

  if (typeof bio === 'string') {
    user.bio = bio.trim().slice(0, 600);
  }

  if (req.file) {
    const supabaseAvatar = await uploadToSupabaseStorage('thumbnails', req.file.path, req.file.filename, req.file.mimetype);
    user.avatar = supabaseAvatar || `/uploads/${req.file.filename}`;
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
  addLog('Profil Modifié', `Utilisateur "${user.username}" a mis à jour son profil (avatar & bio)`);

  const { passwordHash: _, ...userSafe } = user;
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    message: 'Votre profil a été mis à jour avec succès !',
    token,
    user: userSafe
  });
});

// ---------------- CATEGORIES ROUTES ----------------
// Public: only approved categories
app.get('/api/categories', (req, res) => {
  const db = loadDb();
  const approved = (db.categories || []).filter(c => c.status !== 'pending');
  res.json({ categories: approved });
});

// Admin: all categories including pending user suggestions
app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const all = db.categories || [];
  const pending = all.filter(c => c.status === 'pending');
  const approved = all.filter(c => c.status !== 'pending');
  res.json({ categories: all, pending, approved });
});

// Users propose, Admin approves (users proposals require admin approval)
app.post('/api/categories', authenticate, async (req, res) => {
  const { name, icon, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Le nom de la catégorie est obligatoire.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  const cleanName = name.trim();
  const id = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  if ((db.categories || []).some(c => c.id === id || (c.name || '').toLowerCase() === cleanName.toLowerCase())) {
    return res.status(400).json({ error: 'Cette catégorie existe déjà ou est déjà en attente de validation.' });
  }

  const isAdmin = req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com');
  const newCat = {
    id,
    name: cleanName,
    icon: icon || '',
    description: (description || '').trim(),
    createdBy: req.user.username,
    createdById: req.user.id,
    status: isAdmin ? 'approved' : 'pending',
    createdAt: new Date().toISOString()
  };

  db.categories.push(newCat);
  saveDb(db);
  await syncDbToCloud(db);

  if (isAdmin) {
    addLog('Ajout Catégorie', `Catégorie "${newCat.name}" créée directement par Admin (${req.user.username})`);
    res.status(201).json({
      success: true,
      message: `La catégorie "${newCat.name}" a été ajoutée avec succès !`,
      category: newCat,
      status: 'approved'
    });
  } else {
    addLog('Proposition Catégorie', `Catégorie "${newCat.name}" proposée par ${req.user.username} (en attente de validation admin)`);
    res.status(201).json({
      success: true,
      message: `Votre proposition de catégorie "${newCat.name}" a été soumise avec succès. Elle sera visible sur la plateforme dès sa validation par un administrateur.`,
      category: newCat,
      status: 'pending'
    });
  }
});

// Admin: approve user-proposed category
app.post('/api/admin/categories/:id/approve', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const cat = (db.categories || []).find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable.' });

  cat.status = 'approved';
  cat.approvedAt = new Date().toISOString();
  cat.approvedBy = req.user.username;

  if (cat.createdById) {
    addNotificationToUser(db, cat.createdById, {
      type: 'category_approved',
      message: `Votre suggestion de catégorie "${cat.name}" a été validée par l'administrateur !`,
      link: `/?cat=${encodeURIComponent(cat.id)}`
    });
  }

  saveDb(db);
  await syncDbToCloud(db);
  addLog('Validation Catégorie', `Catégorie "${cat.name}" (proposée par ${cat.createdBy || 'un membre'}) validée par Admin`);

  res.json({ success: true, message: `Catégorie "${cat.name}" validée et publiée avec succès.`, category: cat });
});

// Admin: reject user-proposed category
app.post('/api/admin/categories/:id/reject', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const cat = (db.categories || []).find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable.' });
  if (cat.isSystem) return res.status(400).json({ error: 'Impossible de refuser une catégorie système.' });

  db.categories = (db.categories || []).filter(c => c.id !== req.params.id);
  saveDb(db);
  await syncDbToCloud(db);
  addLog('Refus Catégorie', `Proposition de catégorie "${cat.name}" refusée par Admin`);

  res.json({ success: true, message: `Proposition de catégorie "${cat.name}" refusée.` });
});

// Admin can edit categories and their thumbnails
app.put('/api/categories/:id', requireAdmin, upload.single('thumbnailFile'), async (req, res) => {
  const { name, description } = req.body;
  await syncDbFromCloud();
  const db = loadDb();
  const cat = (db.categories || []).find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Catégorie non trouvée.' });

  if (name && name.trim()) cat.name = name.trim();
  if (description !== undefined) cat.description = description.trim();

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Modification Catégorie', `Catégorie "${cat.name}" modifiée par Admin`);

  res.json({
    message: 'Catégorie mise à jour avec succès.',
    category: cat
  });
});

// Admin can delete categories (except system ones)
app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  const catId = req.params.id;
  if (catId === 'all') {
    return res.status(400).json({ error: 'Impossible de supprimer la catégorie système principale.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  const index = (db.categories || []).findIndex(c => c.id === catId);
  if (index === -1) {
    return res.status(404).json({ error: 'Catégorie non trouvée.' });
  }

  const deleted = db.categories.splice(index, 1)[0];
  saveDb(db);
  await syncDbToCloud(db);

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

  // Full-text search via ?q= param (also supports legacy ?search=)
  const qParam = req.query.q || req.query.search;
  if (qParam) {
    const s = qParam.toLowerCase();
    list = list.filter(v => {
      const titleMatch = v.title && v.title.toLowerCase().includes(s);
      const descMatch = v.description && v.description.toLowerCase().includes(s);
      const authorMatch = v.authorName && v.authorName.toLowerCase().includes(s);
      const regionMatch = v.region && v.region.toLowerCase().includes(s);
      const catMatch = (v.categories || [v.category]).some(c => (c || '').toLowerCase().includes(s));
      return titleMatch || descMatch || authorMatch || regionMatch || catMatch;
    });
  }

  // Sort: recent (default), views, likes
  const sort = req.query.sort || 'recent';
  if (sort === 'views') {
    list.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else if (sort === 'likes') {
    list.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  } else {
    // Default: VIP authors first, then by date
    list.sort((a, b) => {
      if (a.isVipAuthor && !b.isVipAuthor) return -1;
      if (!a.isVipAuthor && b.isVipAuthor) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  // Enrich videos with author's creator badge
  const userMap = {};
  (db.users || []).forEach(u => { if (u.id) userMap[u.id] = u; });
  list = list.map(v => {
    const author = v.authorId ? userMap[v.authorId] : null;
    return {
      ...v,
      creatorBadge: author?.creatorBadge || v.creatorBadge || null
    };
  });

  res.json({ videos: list });
});

// Single video lookup
app.get('/api/videos/:id', async (req, res) => {
  const db = loadDb();
  const video = (db.videos || []).find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vidéo introuvable.' });

  // Enrich with creator badge
  const author = video.authorId ? (db.users || []).find(u => u.id === video.authorId) : null;
  res.json({
    video: {
      ...video,
      creatorBadge: author?.creatorBadge || video.creatorBadge || null
    }
  });
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
  let isBunny = false;
  let bunnyVideoId = null;
  let iframeUrl = null;
  let previewAnimationUrl = null;

  if (req.files && req.files['videoFile'] && req.files['videoFile'][0]) {
    const videoFile = req.files['videoFile'][0];
    
    // Si Bunny Stream est configuré, on l'utilise en priorité pour le transcodage 4K et le CDN
    if (isBunnyConfigured()) {
      const bunnyRes = await uploadToBunnyStream(videoFile.path, finalTitle);
      if (bunnyRes) {
        videoUrl = bunnyRes.directPlayUrl;
        isBunny = true;
        bunnyVideoId = bunnyRes.videoId;
        iframeUrl = bunnyRes.iframeUrl;
        previewAnimationUrl = bunnyRes.previewAnimationUrl;
      }
    }

    // Si Bunny n'est pas encore configuré ou en cas de secours, stockage Supabase / Local
    if (!videoUrl) {
      const supabaseUrl = await uploadToSupabaseStorage('videos', videoFile.path, videoFile.filename, videoFile.mimetype);
      videoUrl = supabaseUrl || `/uploads/${videoFile.filename}`;
    }
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
  } else if (isBunny && bunnyVideoId) {
    const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
    const libId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
    const hlsHost = customCdn || `vz-${libId}.b-cdn.net`;
    thumbnail = `https://${hlsHost}/${bunnyVideoId}/thumbnail.jpg`;
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
    isBunnyStream: isBunny,
    bunnyVideoId,
    iframeUrl,
    previewAnimationUrl,
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

  // Notify author of the like (if different user)
  if (video.authorId && video.authorId !== req.user?.id) {
    addNotificationToUser(db, video.authorId, {
      type: 'like',
      message: `Votre video "${video.title.slice(0, 40)}" a recu un nouveau j'aime.`,
      link: `/?video=${video.id}`
    });
  }

  // Recompute creator badge level
  if (video.authorId) computeCreatorBadge(video.authorId, db);

  saveDb(db);
  res.json({
    likes: video.likes,
    isVipExclusive: !!video.isVipExclusive,
    convertedToVip,
    message: convertedToVip ? "Cette video populaire a atteint 5 mentions J'aime et est desormais passee en Contenu Exclusif VIP !" : null
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
    return res.json({ videos: [], similar: [] });
  }

  const videoCats = new Set(
    (video.categories || [video.category]).filter(Boolean).map(c => c.toLowerCase())
  );

  const approved = (db.videos || []).filter(v => v.status === 'approved' && v.id !== video.id);

  const scored = approved.map(v => {
    let score = 0;
    // Same categories: 3 pts each
    const vCats = (v.categories || [v.category]).filter(Boolean).map(c => c.toLowerCase());
    vCats.forEach(c => { if (videoCats.has(c)) score += 3; });
    // Same region: 1 pt
    if (v.region && video.region && v.region.toLowerCase() === video.region.toLowerCase()) score += 1;
    // Same author: 2 pts
    if (v.authorId && video.authorId && v.authorId === video.authorId) score += 2;
    // Popularity boost
    if ((v.views || 0) >= 10) score += 0.5;
    if ((v.likes || 0) >= 5) score += 0.5;
    return { ...v, _score: score };
  })
    .filter(v => v._score > 0)
    .sort((a, b) => b._score - a._score || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 6)
    .map(({ _score, ...v }) => v);

  // Fill remaining slots with recent videos if needed
  if (scored.length < 6) {
    const scoredIds = new Set([...scored.map(v => v.id), video.id]);
    const recent = approved
      .filter(v => !scoredIds.has(v.id))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 6 - scored.length);
    scored.push(...recent);
  }

  res.json({ videos: scored, similar: scored });
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

  // Update creator badge level
  if (video.authorId) computeCreatorBadge(video.authorId, db);

  saveDb(db);

  addLog('Validation Video', `Video "${video.title}" validee et publiee par Admin`);

  res.json({
    message: `La video "${video.title}" a ete validee et mise en ligne !`,
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
app.post('/api/reports/submit', async (req, res) => {
  const { fullName, email, videoUrl, videoTitle, reason, details, signature } = req.body;
  if (!fullName || !email || !reason || !signature) {
    return res.status(400).json({ error: 'Veuillez remplir tous les champs obligatoires (*).' });
  }

  await syncDbFromCloud();
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
    status: 'pending', // pending, resolved, dismissed
    createdAt: new Date().toISOString()
  };

  db.reports.unshift(newReport);
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Signalement Abus', `Signalement recu pour "${newReport.videoTitle || newReport.videoUrl}" (Motif : ${newReport.reason}) par ${newReport.fullName}`);

  // Send alert email to Admin
  try {
    await sendRobustEmail({
      to: 'ia.project.pro2k26@gmail.com',
      subject: `Nouveau Signalement : ${newReport.reason} - VideoHub`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #334155;">
          <div style="background:linear-gradient(135deg,#ef4444,#b91c1c);padding:24px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Nouveau Signalement Recu</h1>
          </div>
          <div style="padding:24px;">
            <p><strong>Signaleur :</strong> ${newReport.fullName} (${newReport.email})</p>
            <p><strong>Motif :</strong> ${newReport.reason}</p>
            <p><strong>Video / URL :</strong> <a href="${newReport.videoUrl}" style="color:#f97316;">${newReport.videoUrl || 'Lien fourni'}</a></p>
            <p><strong>Details :</strong> ${newReport.details || 'Aucun detail supplementaire'}</p>
            <p><strong>Signature :</strong> ${newReport.signature}</p>
            <p style="margin-top:20px;font-size:13px;color:#94a3b8;">Consultez votre Espace Administrateur pour traiter ce signalement.</p>
          </div>
        </div>
      `,
      category: 'REPORT'
    });
  } catch (e) {
    console.error('Error sending report email notification', e);
  }

  res.status(201).json({
    message: 'Votre signalement a ete enregistre avec succes et transmis a notre equipe de moderation. Il sera traite sous 24h a 48h.',
    report: newReport
  });
});


// ---------------- CONTACT FORM MESSAGES & REAL EMAIL NOTIFICATION ----------------
app.post('/api/contact/submit', async (req, res) => {
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
  await syncDbToCloud(db);

  addLog('Contact', `Nouveau message de ${newContact.name} (${newContact.email}) - Objet: ${newContact.subject}`);

  const adminEmail = process.env.SMTP_USER || 'ia.project.pro2k26@gmail.com';

  // 1. Send direct notification email to Admin (ia.project.pro2k26@gmail.com)
  const adminContactHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155;">
      <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
        <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800;">Nouveau Message de Contact</h1>
        <p style="margin: 6px 0 0; color: rgba(255,255,255,0.95); font-size: 13px;">Formulaire Nous Contacter - VideoHub</p>
      </div>
      <div style="padding: 24px; line-height: 1.6;">
        <p style="margin: 0 0 12px 0;"><strong style="color:#f97316;">Expéditeur :</strong> ${newContact.name} (<a href="mailto:${newContact.email}" style="color:#38bdf8;">${newContact.email}</a>)</p>
        <p style="margin: 0 0 16px 0;"><strong style="color:#f97316;">Objet :</strong> ${newContact.subject}</p>
        <div style="background: #1e293b; border-radius: 8px; padding: 18px; border: 1px solid #334155; margin-bottom: 20px;">
          <strong style="color:#cbd5e1; font-size:13px; display:block; margin-bottom:8px;">Message :</strong>
          <p style="color: #f8fafc; font-size: 14px; margin: 0; white-space: pre-wrap;">${newContact.message}</p>
        </div>
        <div style="text-align: center;">
          <a href="mailto:${newContact.email}?subject=Re: ${encodeURIComponent(newContact.subject)}" style="background-color: #f97316; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 700; font-size: 14px; display: inline-block;">
            Répondre directement à ${newContact.name}
          </a>
        </div>
      </div>
    </div>
  `;
  const adminContactText = `Nouveau message de contact VideoHub\n\nDe : ${newContact.name} (${newContact.email})\nObjet : ${newContact.subject}\n\nMessage :\n${newContact.message}`;

  await sendRobustEmail({
    to: adminEmail,
    replyTo: newContact.email,
    subject: `[VideoHub Contact] ${newContact.subject} (de ${newContact.name})`,
    html: adminContactHtml,
    text: adminContactText,
    category: 'CONTACT_ADMIN'
  });

  // 2. Send automatic confirmation email to the user who submitted the form
  if (newContact.email.toLowerCase() !== adminEmail.toLowerCase()) {
    const userConfirmationHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155;">
        <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800;">VideoHub</h1>
          <p style="margin: 6px 0 0; color: rgba(255,255,255,0.95); font-size: 13px;">Accusé de réception - Support</p>
        </div>
        <div style="padding: 24px; line-height: 1.6;">
          <h2 style="color: #ffffff; font-size: 18px; margin-top: 0;">Bonjour ${newContact.name},</h2>
          <p style="color: #cbd5e1; font-size: 14px;">
            Nous vous confirmons la bonne réception de votre message concernant : <strong>"${newContact.subject}"</strong>.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; margin: 18px 0; color: #94a3b8; font-size: 13px; font-style: italic;">
            "${newContact.message}"
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Notre équipe de support traite votre demande et vous répondra dans les plus brefs délais.
          </p>
        </div>
      </div>
    `;
    const userConfirmationText = `Bonjour ${newContact.name},\n\nNous avons bien reçu votre message concernant "${newContact.subject}".\nNotre équipe vous répondra dans les plus brefs délais.\n\nVideoHub Support`;

    await sendRobustEmail({
      to: newContact.email,
      subject: `Confirmation de réception de votre message - VideoHub`,
      html: userConfirmationHtml,
      text: userConfirmationText,
      category: 'CONTACT_CONFIRM'
    });
  }

  res.status(201).json({
    message: 'Votre message a été envoyé avec succès ! Notre équipe a été notifiée par e-mail.',
    contact: newContact
  });
});

// ---------------- ADMIN REPORTS (SIGNALEMENTS) ----------------
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  res.json({ reports: db.reports || [] });
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  rep.status = 'resolved';
  rep.resolvedAt = new Date().toISOString();
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Signalement Traite', `Signalement #${rep.id} marque comme resolu par Admin`);
  res.json({ message: 'Signalement marque comme traite.', report: rep });
});

app.post('/api/admin/reports/:id/delete-video', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  // Try to find video by ID in videoUrl
  const videoIdMatch = (rep.videoUrl || '').match(/vid_[a-zA-Z0-9_-]+/);
  let deletedVideo = null;
  if (videoIdMatch) {
    const vId = videoIdMatch[0];
    const idx = (db.videos || []).findIndex(v => v.id === vId);
    if (idx !== -1) {
      deletedVideo = db.videos.splice(idx, 1)[0];
    }
  } else if (rep.videoTitle) {
    const idx = (db.videos || []).findIndex(v => (v.title || '').toLowerCase() === rep.videoTitle.toLowerCase());
    if (idx !== -1) {
      deletedVideo = db.videos.splice(idx, 1)[0];
    }
  }

  rep.status = 'resolved';
  rep.resolvedAt = new Date().toISOString();
  rep.actionTaken = deletedVideo ? `Video "${deletedVideo.title}" supprimee.` : 'Video supprimee.';

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Suppression Video Signalement', `Video supprimee suite au signalement #${rep.id} (${rep.reason})`);
  res.json({ message: 'Video supprimee et signalement resolu.', report: rep, deleted: !!deletedVideo });
});

app.post('/api/admin/reports/:id/dismiss', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  rep.status = 'dismissed';
  rep.resolvedAt = new Date().toISOString();
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Signalement Classe', `Signalement #${rep.id} classe sans suite.`);
  res.json({ message: 'Signalement classe sans suite.', report: rep });
});

// ---------------- ADMIN CONTACT MESSAGES ----------------
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  res.json({ messages: db.contactMessages || [] });
});

app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const targetId = req.params.id;
  const targetMsg = (db.contactMessages || []).find(m => m.id === targetId);
  db.contactMessages = (db.contactMessages || []).filter(m => m.id !== targetId);
  if (targetMsg) {
    addLog('Suppression Message', `Message de "${targetMsg.name}" (${targetMsg.email}) supprimé par Admin`);
  }
  saveDb(db);
  await syncDbToCloud(db);
  res.json({ success: true, message: 'Message supprimé avec succès.' });
});

// Purger l'historique des logs admin
app.delete('/api/admin/logs', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const count = (db.logs || []).length;
  db.logs = [
    {
      id: 'log_' + Date.now(),
      action: 'Historique Réinitialisé',
      details: `Historique purgé par ${req.user.username} (${count} entrée(s) archivée(s)).`,
      date: new Date().toISOString()
    }
  ];
  saveDb(db);
  await syncDbToCloud(db);
  res.json({ success: true, message: 'Historique des logs réinitialisé.' });
});

app.post('/api/admin/messages/:id/reply', requireAdmin, async (req, res) => {
  const { replySubject, replyText } = req.body;
  if (!replyText || !replyText.trim()) {
    return res.status(400).json({ error: 'Veuillez saisir votre message de réponse.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  db.contactMessages = db.contactMessages || [];
  const msg = db.contactMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message introuvable.' });

  const subject = (replySubject && replySubject.trim()) || `Re: ${msg.subject || 'Votre message sur VideoHub'}`;

  // Send real email to the user
  try {
    await sendRobustEmail({
      to: msg.email,
      from: 'ia.project.pro2k26@gmail.com',
      replyTo: 'ia.project.pro2k26@gmail.com',
      subject: subject,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #334155;">
          <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:24px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">VideoHub Support</h1>
          </div>
          <div style="padding:24px;">
            <p>Bonjour <strong>${msg.name || 'Membre'}</strong>,</p>
            <p style="margin-top:14px;white-space:pre-wrap;line-height:1.6;color:#e2e8f0;">${replyText.trim()}</p>
            <div style="margin-top:24px;padding:14px;background:#1e293b;border-radius:8px;border-left:3px solid #f97316;font-size:13px;color:#94a3b8;">
              <p style="margin:0 0 6px;font-weight:700;color:#cbd5e1;">Rappel de votre message :</p>
              <p style="margin:0;white-space:pre-wrap;">${msg.message}</p>
            </div>
            <p style="margin-top:24px;font-size:12px;color:#64748b;">Support officiel VideoHub • Contact : ia.project.pro2k26@gmail.com</p>
          </div>
        </div>
      `,
      category: 'CONTACT'
    });
  } catch (err) {
    console.error('Error sending contact reply email', err);
    return res.status(500).json({ error: "Échec de l'envoi de l'e-mail. Vérifiez la configuration SMTP." });
  }

  msg.replied = true;
  msg.repliedAt = new Date().toISOString();
  msg.lastReplyText = replyText.trim();
  msg.lastReplySubject = subject;

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Réponse Contact', `Réponse envoyée à ${msg.email} (Sujet: ${subject}) par Admin`);

  res.json({ success: true, message: `Réponse envoyée avec succès à ${msg.email}`, messageRecord: msg });
});

// ---------------- ADMIN REVIEWS & RATINGS ----------------
app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const reviews = [];
  (db.videos || []).forEach(v => {
    (v.comments || []).forEach(c => {
      reviews.push({
        ...c,
        videoId: v.id,
        videoTitle: v.title,
        videoThumbnail: v.thumbnail,
        authorName: v.authorName
      });
    });
  });
  reviews.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ reviews });
});

app.delete('/api/admin/reviews/:videoId/:commentId', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const video = (db.videos || []).find(v => v.id === req.params.videoId);
  if (video && video.comments) {
    video.comments = video.comments.filter(c => c.id !== req.params.commentId);
    saveDb(db);
    await syncDbToCloud(db);
  }
  res.json({ message: 'Commentaire supprime avec succes.' });
});


// Admin Users Management
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const safeUsers = db.users.map(({ passwordHash, ...u }) => u);
  res.json({ users: safeUsers });
});

app.post('/api/admin/users/:id/toggle-vip', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
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
  await syncDbToCloud(db);
  addLog('Gestion VIP', `Statut VIP de ${user.username} défini à ${user.isVip ? 'ACTIF' : 'INACTIF'}`);

  const { passwordHash: _, ...userSafe } = user;
  res.json({ message: `Statut VIP mis à jour pour ${user.username}`, user: userSafe });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const totalViews = db.videos.reduce((acc, v) => acc + (v.views || 0), 0);
  const totalLikes = db.videos.reduce((acc, v) => acc + (v.likes || 0), 0);
  const totalVips = db.users.filter(u => u.isVip).length;
  const pendingReports = (db.reports || []).filter(r => r.status === 'pending').length;
  const pendingCategories = (db.categories || []).filter(c => c.status === 'pending').length;
  const totalReports = (db.reports || []).length;
  const totalMessages = (db.contactMessages || []).length;
  const totalComments = (db.videos || []).reduce((acc, v) => acc + (v.comments ? v.comments.length : 0), 0);

  res.json({
    totalUsers: db.users.length,
    totalVideos: db.videos.length,
    approvedVideos: db.videos.filter(v => v.status === 'approved').length,
    pendingVideos: db.videos.filter(v => v.status === 'pending').length,
    totalCategories: db.categories.length,
    pendingCategories,
    totalViews,
    totalLikes,
    totalVips,
    pendingReports,
    totalReports,
    totalMessages,
    totalComments,
    logs: db.logs || []
  });
});


// ---------------- ADMIN EMAIL TEST & PREVIEW SUITE ----------------
app.get('/api/admin/email-templates', requireAdmin, (req, res) => {
  const templates = [
    {
      key: 'welcome',
      title: 'Bienvenue & Inscription',
      description: 'Envoyé automatiquement à chaque nouvel utilisateur dès la création de son compte.',
      subject: 'Bienvenue sur VideoHub - Votre compte a été créé avec succès'
    },
    {
      key: 'reset_pwd',
      title: 'Mot de passe oublié (Code 6 chiffres)',
      description: 'Envoyé lorsqu\'un utilisateur demande la réinitialisation de son mot de passe.',
      subject: 'Réinitialisation de votre mot de passe VideoHub'
    },
    {
      key: 'video_approved',
      title: 'Vidéo validée & publiée',
      description: 'Notification au créateur confirmant que sa vidéo a été approuvée par la modération.',
      subject: 'Votre vidéo a été validée et publiée sur VideoHub'
    },
    {
      key: 'video_rejected',
      title: 'Vidéo refusée (motif modération)',
      description: 'Notification au créateur expliquant le motif de rejet de sa vidéo.',
      subject: 'Notification de modération - Votre vidéo sur VideoHub'
    },
    {
      key: 'vip_activated',
      title: 'Abonnement VIP activé (9,99€)',
      description: 'Confirmation officielle de l\'activation du Pass VIP après paiement Stripe.',
      subject: 'Confirmation d\'adhésion - Votre Pass VIP VideoHub est actif'
    },
    {
      key: 'new_message',
      title: 'Nouveau message privé reçu',
      description: 'Notification par e-mail lors de la réception d\'un message dans la boîte privée.',
      subject: 'Nouveau message privé reçu sur VideoHub'
    },
    {
      key: 'report_received',
      title: 'Signalement pris en compte (Takedown)',
      description: 'Accusé de réception officiel suite à un signalement de contenu par un utilisateur.',
      subject: 'Prise en charge de votre signalement VideoHub'
    }
  ];

  res.json({ templates });
});

app.post('/api/admin/test-emails', requireAdmin, async (req, res) => {
  const { toEmail, templateKeys } = req.body;
  if (!toEmail || !templateKeys || !Array.isArray(templateKeys) || templateKeys.length === 0) {
    return res.status(400).json({ error: 'Veuillez sélectionner au moins un modèle et renseigner une adresse e-mail valide.' });
  }

  const results = [];

  for (const key of templateKeys) {
    const template = generateEmailTemplate(key, {
      username: req.user.username || 'Administrateur',
      toEmail: toEmail.trim(),
      videoTitle: 'Vortex Électronique (Exemple)',
      videoCategory: 'Electronique',
      reason: 'Qualité audio insuffisante ou doublon dans la thématique.',
      senderName: 'Alex Créateur',
      messagePreview: 'Bonjour, super contenu sur votre chaîne ! Au plaisir d\'échanger.',
      code: Math.floor(100000 + Math.random() * 900000).toString(),
      reportId: 'SIG-' + Math.floor(10000 + Math.random() * 90000),
      reportReason: 'Demande de vérification de droits d\'auteur'
    });

    const sent = await sendRobustEmail({
      to: toEmail.trim(),
      subject: `[TEST] ${template.subject}`,
      html: template.html,
      text: template.text,
      category: 'TEST_ADMIN'
    });

    if (sent) {
      results.push({ key, name: template.name, status: 'sent' });
    } else {
      results.push({ key, name: template.name, status: 'error' });
    }
  }

  const successCount = results.filter(r => r.status === 'sent').length;
  addLog('Test E-mails Admin', `${successCount} e-mail(s) de test expédié(s) à ${toEmail} par Admin`);

  res.json({
    success: true,
    sentCount: successCount,
    total: templateKeys.length,
    results,
    message: `${successCount} e-mail(s) de test expédié(s) avec succès à ${toEmail} !`
  });
});

// ---------------- VIP SUBSCRIPTION (9,99€) & STRIPE ----------------
app.post('/api/vip/create-checkout-session', authenticate, async (req, res) => {
  const user = req.user;
  const siteUrl = 'https://video-hub-mu-nine.vercel.app';

  if (!stripe) {
    // If Stripe is not configured with a secret key yet, allow simulation fallback
    return res.json({ simulation: true });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Abonnement VIP VideoHub (9,99€ / mois)',
              description: 'Accès illimité aux vidéos exclusives VIP, badge certifié, suppression des pubs et priorité',
            },
            unit_amount: 999, // 9.99 EUR
            recurring: {
              interval: 'month'
            }
          },
          quantity: 1,
        }
      ],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: {
        userId: user.id,
        username: user.username
      },
      success_url: `${siteUrl}/?vip_status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?vip_status=cancelled`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session error:', err);
    res.status(500).json({ error: "Erreur lors de la création de la session Stripe." });
  }
});

// Verify Stripe Checkout Session and grant VIP
app.post('/api/vip/verify-session', authenticate, async (req, res) => {
  const { sessionId } = req.body;
  if (!stripe || !sessionId) {
    return res.status(400).json({ error: 'Session Stripe introuvable.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' || session.status === 'complete') {
      const db = loadDb();
      const user = db.users.find(u => u.id === req.user.id || u.id === session.client_reference_id);
      if (user) {
        const expiry = new Date();
        expiry.setMonth(expiry.getMonth() + 1);
        user.isVip = true;
        user.vipExpiry = expiry.toISOString().split('T')[0];

        db.videos.forEach(v => {
          if (v.authorId === user.id) v.isVipAuthor = true;
        });

        saveDb(db);
        addLog('Abonnement VIP Stripe', `${user.username} a souscrit au Pass VIP 9,99€ via Stripe`);

        const { passwordHash: _, ...userSafe } = user;
        return res.json({
          success: true,
          message: 'Paiement validé ! Vous êtes désormais Membre VIP (9,99€/mois).',
          user: userSafe
        });
      }
    }
    res.status(400).json({ error: 'Paiement non confirmé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur de vérification du paiement Stripe.' });
  }
});

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
    message: 'Félicitations ! Vous êtes désormais Membre VIP (9,99€/mois)',
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

// Auto-generated XML Sitemap for SEO
app.get('/sitemap.xml', async (req, res) => {
  const db = loadDb();
  const siteUrl = 'https://video-hub-mu-nine.vercel.app';
  const today = new Date().toISOString().split('T')[0];

  const staticUrls = [
    { loc: siteUrl, priority: '1.0', changefreq: 'daily' },
    { loc: `${siteUrl}/#explorer`, priority: '0.9', changefreq: 'daily' },
    { loc: `${siteUrl}/#vip`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${siteUrl}/#faq`, priority: '0.6', changefreq: 'monthly' },
  ];

  const categoryUrls = (db.categories || []).filter(c => !c.isSystem).map(c => ({
    loc: `${siteUrl}/?cat=${encodeURIComponent(c.id)}`,
    priority: '0.8',
    changefreq: 'daily'
  }));

  const videoUrls = (db.videos || []).filter(v => v.status !== 'pending').slice(0, 500).map(v => ({
    loc: `${siteUrl}/?video=${encodeURIComponent(v.id)}`,
    priority: '0.7',
    lastmod: v.createdAt ? v.createdAt.split('T')[0] : today,
    changefreq: 'weekly'
  }));

  const allUrls = [...staticUrls, ...categoryUrls, ...videoUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod || today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(xml);
});

// Direct public profile URL - serves SPA with username in path
app.get('/profil/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
