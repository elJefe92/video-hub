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
const RAW_SITE_URL = process.env.SITE_URL || 'https://www.revedeq.fr';
const SITE_URL = RAW_SITE_URL.replace('://revedeq.fr', '://www.revedeq.fr');

// Security Hardening: Disable technology fingerprinting
app.disable('x-powered-by');

// Security Hardening: HTTP Response Headers (OWASP)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Automatically sync latest cloud state on every API request across all serverless lambdas
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const smtpSecure = process.env.SMTP_SECURE !== undefined ? (process.env.SMTP_SECURE === 'true') : (smtpPort === 465);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER || 'ia.project.pro2k26@gmail.com';
  const smtpPass = (process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || 'rxcqdfrtywmzzaym').replace(/\s+/g, '');

  if (smtpHost) {
    mailTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      tls: {
        rejectUnauthorized: true
      }
    });
  } else {
    // Gmail fallback
    mailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  }

  return mailTransporter;
}

async function sendRobustEmail({ to, subject, html, text, replyTo, category }) {
  if (!to) return false;
  const senderAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'ia.project.pro2k26@gmail.com';
  const transporter = getMailTransporter();
  const domainPart = senderAddress.includes('@') ? senderAddress.split('@')[1] : 'revedeq.fr';
  const cleanId = `rdq-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@${domainPart}`;

  const mailOptions = {
    from: `"Rêve de Q Support" <${senderAddress}>`,
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
      'X-Entity-Ref-ID': `RDQ-${Date.now()}`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'Auto-Submitted': 'auto-generated',
      'Feedback-ID': `REVE_DE_Q:${category || 'TRANSACTIONAL'}:1:${domainPart.toUpperCase()}`
    }
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Email Delivered] ${subject} successfully sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email Delivery Error] Failed sending to ${to}:`, err.message);
    // Automatic fallback to backup transporter if primary SMTP fails
    if (process.env.SMTP_HOST) {
      console.log(`[Email Fallback] Retrying delivery via backup transporter...`);
      try {
        const fallbackTransporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: 'ia.project.pro2k26@gmail.com',
            pass: 'rxcqdfrtywmzzaym'
          }
        });
        await fallbackTransporter.sendMail({
          ...mailOptions,
          from: `"Rêve de Q Support" <ia.project.pro2k26@gmail.com>`
        });
        console.log(`[Email Fallback Delivered] Sent to ${to} via backup transporter`);
        return true;
      } catch (fbErr) {
        console.error(`[Email Fallback Error]:`, fbErr.message);
      }
    }
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
  const siteUrl = SITE_URL;
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

// In-memory rate limiting maps
const loginAttempts = new Map();
const registerAttempts = new Map();
const resetPwdAttempts = new Map();
const contactAttempts = new Map();

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_LOCK_MS = 15 * 60 * 1000; // 15 minutes lock

function checkIpRateLimit(map, clientIp, maxAttempts = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS, lockMs = RATE_LIMIT_LOCK_MS) {
  const now = Date.now();
  const entry = map.get(clientIp);
  if (entry) {
    if (entry.lockedUntil && now < entry.lockedUntil) {
      const remaining = Math.ceil((entry.lockedUntil - now) / 60000);
      return { allowed: false, remaining, retryAfter: entry.lockedUntil };
    }
    if (now - entry.firstAttempt > windowMs) {
      map.delete(clientIp);
    }
  }
  return { allowed: true };
}

function recordIpAttempt(map, clientIp, maxAttempts = RATE_LIMIT_MAX, lockMs = RATE_LIMIT_LOCK_MS) {
  const cur = map.get(clientIp) || { count: 0, firstAttempt: Date.now() };
  cur.count += 1;
  if (cur.count >= maxAttempts) {
    cur.lockedUntil = Date.now() + lockMs;
  }
  map.set(clientIp, cur);
}

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

// Unified Email Templates Generator for Rêve de Q
function generateEmailTemplate(type, data = {}) {
  const siteUrl = SITE_URL;
  const username = data.username || 'Cher Membre';
  const toEmail = data.toEmail || 'contact@exemple.fr';
  const isMessaging = type === 'new_message' || type === 'message';
  const emblemUrl = isMessaging ? `${siteUrl}/revedeq-emblem-messages.png` : `${siteUrl}/revedeq-emblem.png`;
  const subTitle = isMessaging ? 'Messagerie Privée Sécurisée' : 'Tes rêves, tes délires.';

  const baseHeader = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0b1120; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid rgba(249, 115, 22, 0.25); box-shadow: 0 20px 50px rgba(0,0,0,0.6);">
      <div style="background: radial-gradient(circle at 50% 30%, #1e1b4b 0%, #090d16 70%, #030712 100%); padding: 32px 24px 26px; text-align: center; border-bottom: 1px solid rgba(249, 115, 22, 0.2); position: relative;">
        <div style="display: inline-block; margin-bottom: 12px;">
          <img src="${emblemUrl}" alt="Rêve de Q" width="68" height="68" style="display: block; margin: 0 auto; filter: drop-shadow(0 0 18px rgba(249, 115, 22, 0.7));">
        </div>
        <div style="margin: 0; font-size: 26px; font-weight: 900; letter-spacing: -0.5px; line-height: 1.1;">
          <span style="color: #ffffff;">Rêve de </span><span style="color: #fbbf24; text-shadow: 0 0 18px rgba(249, 115, 22, 0.75);">Q</span>
        </div>
        <p style="margin: 8px 0 0; color: #94a3b8; font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;">${subTitle}</p>
        <div style="height: 2px; width: 60px; background: linear-gradient(90deg, transparent, #f59e0b, transparent); margin: 16px auto 0;"></div>
      </div>
      <div style="padding: 32px 26px; line-height: 1.6; background-color: #0b1120;">
  `;

  const baseFooter = `
        <div style="margin-top: 30px; text-align: center;">
          <a href="${siteUrl}" style="background-color: #f97316; color: #ffffff; text-decoration: none; padding: 13px 26px; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block;">
            Accéder à Rêve de Q
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; border-top: 1px solid #334155; padding-top: 18px; margin-top: 25px; margin-bottom: 0;">
          E-mail de notification officiel • Destinataire : <strong>${toEmail}</strong><br>
          Rêve de Q - Tous droits réservés.
        </p>
      </div>
    </div>
  `;

  switch(type) {
    case 'verify_email':
      const verifyCode = data.code || '123456';
      return {
        name: 'Vérification d\'inscription (Code 6 chiffres)',
        subject: 'Confirmation de votre adresse e-mail - Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Merci de rejoindre <strong>Rêve de Q</strong>. Pour valider votre adresse e-mail et finaliser la création de votre compte, veuillez saisir le code de vérification ci-dessous :
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 22px; text-align: center; margin: 24px 0; border: 1px dashed #f97316;">
            <span style="font-size: 34px; font-weight: 900; letter-spacing: 8px; color: #f97316; font-family: monospace;">${verifyCode}</span>
            <p style="color: #94a3b8; font-size: 12px; margin: 8px 0 0 0;">Ce code de sécurité expire dans 15 minutes.</p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité. Aucun compte ne sera créé.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVotre code de confirmation Rêve de Q est : ${verifyCode}\nCe code expire dans 15 minutes.\n\nAccéder à Rêve de Q : ${siteUrl}`
      };

    case 'welcome':
      return {
        name: 'Bienvenue & Inscription',
        subject: 'Bienvenue sur Rêve de Q - Votre compte a été créé avec succès',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bienvenue sur Rêve de Q, ${username} !</h2>
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
        text: `Bienvenue sur Rêve de Q, ${username} !\n\nVotre compte a bien été créé avec succès. Vous pouvez dès à présent vous connecter et partager vos vidéos avec la communauté.\n\nAccéder au site : ${siteUrl}\nDestinataire : ${toEmail}`
      };

    case 'reset_pwd':
      const code = data.code || '849201';
      return {
        name: 'Mot de passe oublié (Code 6 chiffres)',
        subject: 'Réinitialisation de votre mot de passe Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Vous avez demandé la réinitialisation de votre mot de passe sur <strong>Rêve de Q</strong>.
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
        text: `Bonjour ${username},\n\nVotre code de réinitialisation temporaire Rêve de Q est : ${code}\n(Valable 15 minutes)\n\nEntrez ce code sur le site pour définir votre nouveau mot de passe : ${siteUrl}`
      };

    case 'video_approved':
      return {
        name: 'Vidéo validée & publiée',
        subject: 'Votre vidéo a été validée et publiée sur Rêve de Q',
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
        text: `Félicitations ${username} !\n\nVotre vidéo "${data.videoTitle || 'Ma Nouvelle Vidéo HD'}" a été validée par la modération et est désormais publiée en ligne sur Rêve de Q : ${siteUrl}`
      };

    case 'video_rejected':
      return {
        name: 'Vidéo refusée (motif modération)',
        subject: 'Notification de modération - Votre vidéo sur Rêve de Q',
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
        subject: 'Confirmation d\'adhésion - Votre Pass VIP Rêve de Q est actif',
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
        text: `Bienvenue dans le Club VIP, ${username} !\n\nVotre abonnement VIP Rêve de Q (9,99€ / mois) est actif avec succès.\nProfitez dès maintenant de vos avantages exclusifs sur : ${siteUrl}`
      };

    case 'account_deleted':
      return {
        name: 'Suppression définitive de compte (RGPD)',
        subject: 'Confirmation de clôture définitive de votre compte - Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Compte clôturé définitivement</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Bonjour ${username},
          </p>
          <p style="color: #cbd5e1; font-size: 15px;">
            Votre compte <strong>Rêve de Q</strong> (${toEmail}) ainsi que vos identifiants de connexion, préférences et données personnelles de profil ont été <strong>définitivement supprimés</strong>, conformément au Règlement Général sur la Protection des Données (RGPD).
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #f97316;">
            <strong style="color: #f97316; font-size: 14px;">Information légale concernant vos vidéos publiées :</strong>
            <p style="color: #cbd5e1; font-size: 13px; margin: 6px 0 0 0; line-height: 1.5;">
              Conformément à l'article 5 de nos Conditions Générales d'Utilisation (CGU), les vidéos déjà mises en ligne et publiées restent hébergées sur la plateforme sous forme anonymisée afin de garantir la continuité du service communautaire.
            </p>
            <p style="color: #cbd5e1; font-size: 13px; margin: 8px 0 0 0; line-height: 1.5;">
              <strong>Demande de retrait de vidéo :</strong> Si vous souhaitez obtenir le déréférencement ou la suppression d'une ou plusieurs de vos vidéos, il vous suffit d'adresser une demande expresse et motivée à notre équipe de modération par e-mail à <a href="mailto:ia.project.pro2k26@gmail.com" style="color:#f97316; text-decoration: underline;">ia.project.pro2k26@gmail.com</a> ou via la rubrique Réclamations du site.
            </p>
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Nous vous remercions pour le temps passé au sein de la communauté Rêve de Q.
          </p>
        ` + baseFooter,
        text: `Compte clôturé définitivement\n\nBonjour ${username},\n\nVotre compte Rêve de Q (${toEmail}) et vos données personnelles ont été supprimés.\n\nConformément à nos CGU, vos vidéos publiées restent hébergées. Pour demander le retrait d'une vidéo spécifique, formulez une demande à ia.project.pro2k26@gmail.com.\n\nRêve de Q Support : ${siteUrl}`
      };

    case 'custom_announcement':
      return {
        name: 'Annonce officielle / Message personnalisé',
        subject: data.subject || 'Communication officielle - Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">${data.heading || `Bonjour ${username},`}</h2>
          <div style="color: #cbd5e1; font-size: 15px; line-height: 1.7; margin: 18px 0; white-space: pre-wrap;">
${(data.customMessage || 'Nous avons le plaisir de vous informer des dernières nouveautés disponibles sur la plateforme Rêve de Q.').trim()}
          </div>
          ${data.callToActionText ? `
            <div style="text-align: center; margin: 26px 0;">
              <a href="${data.callToActionUrl || siteUrl}" style="background-color: #f97316; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block;">
                ${data.callToActionText}
              </a>
            </div>
          ` : ''}
        ` + baseFooter,
        text: `${data.subject || 'Communication officielle - Rêve de Q'}\n\nBonjour ${username},\n\n${(data.customMessage || '').trim()}\n\nAccéder à Rêve de Q : ${siteUrl}`
      };

    case 'new_message':
      return {
        name: 'Nouveau message privé reçu',
        subject: 'Nouveau message privé reçu sur Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Vous avez reçu un nouveau message privé sur <strong>Rêve de Q</strong> de la part de <strong>${data.senderName || 'Alex'}</strong>.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 18px; margin: 20px 0; border: 1px solid #334155; font-style: italic; color: #cbd5e1;">
            "${data.messagePreview || 'Salut ! J\'ai adoré ta dernière vidéo, bravo !'}"
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Connectez-vous à votre espace messagerie pour lui répondre.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nVous avez reçu un nouveau message privé de ${data.senderName || 'Alex'} sur Rêve de Q :\n"${data.messagePreview || 'Salut !'}"\n\nRépondez sur : ${siteUrl}`
      };

    case 'report_received':
      return {
        name: 'Signalement pris en compte (Takedown)',
        subject: 'Prise en charge de votre signalement Rêve de Q',
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
        text: `Bonjour ${username},\n\nNous vous confirmons la prise en charge de votre signalement réf #${data.reportId || 'SIG-12345'}.\nNotre équipe de modération traite votre demande dans les plus brefs délais.\n\nRêve de Q Support : ${siteUrl}`
      };

    case 'contact_reply':
      return {
        name: 'Réponse officielle du Support Contact',
        subject: data.subject || 'Réponse de Rêve de Q Support',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px; margin-bottom: 20px;">
            L'équipe d'administration de <strong>Rêve de Q</strong> fait suite à votre message :
          </p>
          <div style="background: #1e293b; border-radius: 10px; padding: 20px; border: 1px solid #334155; margin-bottom: 22px; color: #f8fafc; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">
${(data.replyText || '').trim()}
          </div>
          ${data.originalMessage ? `
            <div style="background: rgba(15, 23, 42, 0.75); border-radius: 8px; padding: 14px 16px; border-left: 3px solid #f97316; margin-bottom: 20px;">
              <span style="display: block; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #f97316; margin-bottom: 6px;">Rappel de votre message :</span>
              <p style="margin: 0; color: #94a3b8; font-size: 13px; font-style: italic; white-space: pre-wrap;">${data.originalMessage}</p>
            </div>
          ` : ''}
          <p style="color: #cbd5e1; font-size: 14px; margin-top: 15px;">
            Pour toute question complémentaire, vous pouvez répondre directement à cet e-mail.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nRéponse du Support Rêve de Q :\n\n${(data.replyText || '').trim()}\n\n--- Rappel de votre message initial ---\n${data.originalMessage || ''}\n\nRêve de Q Support : ${siteUrl}`
      };

    case 'contact_confirmation':
      return {
        name: 'Accusé de réception - Formulaire Contact',
        subject: 'Confirmation de réception de votre message - Rêve de Q',
        html: baseHeader + `
          <h2 style="color: #ffffff; font-size: 20px; margin-top: 0;">Bonjour ${username},</h2>
          <p style="color: #cbd5e1; font-size: 15px;">
            Nous vous confirmons la bonne réception de votre message concernant : <strong>"${data.contactSubject || 'Demande de support'}"</strong>.
          </p>
          <div style="background: #1e293b; border-radius: 8px; padding: 16px 18px; border: 1px solid #334155; margin: 18px 0; color: #94a3b8; font-size: 13px; font-style: italic; white-space: pre-wrap;">
            "${data.originalMessage || ''}"
          </div>
          <p style="color: #cbd5e1; font-size: 14px;">
            Votre demande est enregistrée dans notre espace support. Notre équipe administrative vous répondra dans les plus brefs délais directement sur cette adresse e-mail.
          </p>
        ` + baseFooter,
        text: `Bonjour ${username},\n\nNous confirmons la bonne réception de votre message ("${data.contactSubject || 'Demande de contact'}").\nNotre équipe administrative vous répondra dans les plus brefs délais.\n\nRêve de Q Support : ${siteUrl}`
      };

    default:
      return {
        name: 'Notification générale',
        subject: 'Notification Rêve de Q',
        html: baseHeader + `<p>Notification Rêve de Q</p>` + baseFooter,
        text: `Notification Rêve de Q\n\nAccéder au site : ${siteUrl}`
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

// Whitelist of strictly permitted MIME types and extensions for uploads
const ALLOWED_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'image/jpeg', 'image/png', 'image/webp', 'image/avif'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mpg', '.mpeg',
  '.jpg', '.jpeg', '.png', '.webp', '.avif'
]);

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(mime)) {
      return cb(new Error('Format de fichier non autorise. Seuls les formats video (MP4, WEBM, MOV) et images (JPG, PNG, WEBP) sont acceptes.'));
    }
    cb(null, true);
  }
});

// Middleware for Auth
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifie. Veuillez vous connecter.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    let db = loadDb();
    let user = db.users.find(u => u.id === decoded.userId);
    if (!user) {
      await syncDbFromCloud(true);
      db = loadDb();
      user = db.users.find(u => u.id === decoded.userId);
    }
    if (!user) {
      return res.status(401).json({ error: 'Utilisateur introuvable.' });
    }
    // Auto grant admin role and VIP status strictly to the official admin account
    if (user.email && user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
      user.role = 'admin';
      user.isVip = true;
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expiree ou jeton invalide.' });
  }
}

// Optional Auth Helper (extracts user if valid Bearer token provided)
async function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      let db = loadDb();
      let user = db.users.find(u => u.id === decoded.userId);
      if (!user) {
        await syncDbFromCloud(true);
        db = loadDb();
        user = db.users.find(u => u.id === decoded.userId);
      }
      if (user) {
        if (user.email && user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') {
          user.role = 'admin';
          user.isVip = true;
        }
        req.user = user;
      }
    } catch (e) {}
  }
  next();
}

// Middleware for Admin only
async function requireAdmin(req, res, next) {
  await authenticate(req, res, () => {
    if (req.user.role !== 'admin' && req.user.email.toLowerCase() !== 'ia.project.pro2k26@gmail.com') {
      return res.status(403).json({ error: 'Acces strictement reserve aux administrateurs.' });
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
  'moderation', 'modération', 'staff', 'root', 'support', 'videohub', 'revedeq', 'rêvedeq', 'reve_de_q', 'officiel'
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
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const limitCheck = checkIpRateLimit(registerAttempts, clientIp, 5, 15 * 60 * 1000, 15 * 60 * 1000);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: `Trop de demandes d'inscription. Veuillez réessayer dans ${limitCheck.remaining} minute(s).`
    });
  }
  recordIpAttempt(registerAttempts, clientIp, 5, 15 * 60 * 1000);

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

  if (user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com' || user.role === 'admin' || (user.username && user.username.toLowerCase() === 'administrateur')) {
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

  await syncDbFromCloud(true);
  const db = loadDb();
  
  const targetId = user.id;
  const targetEmail = (user.email || '').trim().toLowerCase();

  // Remove user by both ID and Email
  db.users = (db.users || []).filter(u => {
    if (u.id === targetId) return false;
    if (targetEmail && u.email && u.email.trim().toLowerCase() === targetEmail) return false;
    return true;
  });
  
  // Retain user videos on the platform as per CGU article 5 (an explicit formal request is required for video removal)
  // Anonymize user reference on videos to protect privacy while preserving published content
  let retainedVideoCount = 0;
  (db.videos || []).forEach(v => {
    const isAuthor = v.authorId === targetId || (targetEmail && v.authorEmail && v.authorEmail.toLowerCase() === targetEmail);
    if (isAuthor) {
      v.authorId = null;
      v.authorEmail = null;
      retainedVideoCount += 1;
    }
  });
  
  saveDb(db);
  await syncDbToCloud(db);
  
  addLog('Suppression Compte', `Compte supprime: ${user.username} (${user.email}). ${retainedVideoCount} video(s) conservees conformement aux CGU (demande formelle requise pour suppression).`);

  // Send farewell email
  try {
    const farewellTpl = generateEmailTemplate('account_deleted', {
      username: user.username,
      toEmail: user.email
    });
    await sendRobustEmail({
      to: user.email,
      subject: farewellTpl.subject,
      html: farewellTpl.html,
      text: farewellTpl.text,
      category: 'ACCOUNT'
    });
  } catch (e) {}

  res.json({ 
    success: true, 
    message: 'Votre compte a bien ete supprime. Conformement a nos CGU, vos videos publiees restent en ligne. Pour demander la suppression d\'une video specifique, vous devez formuler une demande a notre service juridique.' 
  });
});

// Forgot Password - Request 6-digit Reset Code by Email
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'Veuillez saisir votre adresse e-mail.' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const limitCheck = checkIpRateLimit(resetPwdAttempts, clientIp, 3, 15 * 60 * 1000, 15 * 60 * 1000);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: `Trop de demandes de réinitialisation. Veuillez réessayer dans ${limitCheck.remaining} minute(s).`
    });
  }
  recordIpAttempt(resetPwdAttempts, clientIp, 3, 15 * 60 * 1000);

  const cleanEmail = email.trim().toLowerCase();
  await syncDbFromCloud();
  const db = loadDb();
  const user = db.users.find(u => u.email && u.email.toLowerCase() === cleanEmail);

  if (user) {
    // Generate 6-digit code valid for 15 minutes
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000;

    user.resetCode = code;
    user.resetExpiresAt = expiresAt;
    saveDb(db);
    await syncDbToCloud(db);

    // Send reset code email
    await sendPasswordResetEmail(user.email, user.username, code);
    addLog('Demande Mot de Passe Oublié', `Code de réinitialisation généré pour ${user.email}`);
  }

  // Uniform response preventing user enumeration
  res.json({
    success: true,
    message: `Si cette adresse e-mail correspond à un compte inscrit, un code de sécurité à 6 chiffres a été envoyé. Pensez à vérifier votre dossier Spam ou Courrier indésirable.`
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
    bio: user.bio || 'Membre createur sur la plateforme Rêve de Q.',
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
  const favoriteVideos = (db.videos || []).filter(v => favoriteIds.includes(v.id)).map(v => resolveVideoThumbnail(v));
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

// Users propose, Admin approves (proposals from users/guests require admin approval)
app.post('/api/categories', optionalAuthenticate, async (req, res) => {
  const { name, icon, description, authorName, isDirectAdmin } = req.body;
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

  const isAdmin = req.user && (req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com'));
  const shouldApproveDirectly = Boolean(isAdmin && isDirectAdmin);
  const creatorName = req.user ? req.user.username : (authorName ? authorName.trim() : 'Visiteur');

  const newCat = {
    id,
    name: cleanName,
    icon: icon || '',
    description: (description || '').trim(),
    createdBy: creatorName,
    createdById: req.user ? req.user.id : null,
    status: shouldApproveDirectly ? 'approved' : 'pending',
    createdAt: new Date().toISOString()
  };

  db.categories.push(newCat);
  saveDb(db);
  await syncDbToCloud(db);

  if (shouldApproveDirectly) {
    addLog('Ajout Catégorie', `Catégorie "${newCat.name}" créée directement par Admin (${req.user.username})`);
    res.status(201).json({
      success: true,
      message: `La catégorie "${newCat.name}" a été ajoutée et publiée avec succès !`,
      category: newCat,
      status: 'approved'
    });
  } else {
    addLog('Proposition Catégorie', `Catégorie "${newCat.name}" proposée par ${creatorName} (en attente de validation admin)`);
    res.status(201).json({
      success: true,
      message: `Votre proposition de catégorie "${newCat.name}" a été soumise avec succès. Elle sera vérifiée et validée par l'administrateur dans son espace admin avant d'être publiée.`,
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

// Helper to resolve working thumbnail for Bunny Stream videos
function resolveVideoThumbnail(v) {
  if (!v) return v;
  const copy = { ...v };
  if ((!copy.thumbnail || copy.thumbnail.startsWith('/uploads/')) && copy.bunnyVideoId) {
    const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
    const libId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
    const hlsHost = customCdn || (libId ? `vz-${libId}.b-cdn.net` : '');
    if (hlsHost) {
      copy.thumbnail = `https://${hlsHost}/${copy.bunnyVideoId}/thumbnail.jpg`;
    }
  }
  return copy;
}

// ---------------- VIDEOS & EXPLORER ROUTES ----------------
app.get('/api/videos', async (req, res) => {
  await syncDbFromCloud(true);
  const { category, categories, region, search, userId } = req.query;
  const db = loadDb();
  let list = (db.videos || []).map(v => resolveVideoThumbnail(v));

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

  // Optimized full-text relevance search via ?q= (also supports legacy ?search=)
  const qParam = (req.query.q || req.query.search || '').trim();
  if (qParam) {
    const normalize = str => (str || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const qNorm = normalize(qParam);

    const scoreItem = (text, isTitle = false) => {
      const t = normalize(text);
      if (!t || !qNorm) return 0;
      if (t === qNorm) return isTitle ? 100 : 80;
      if (t.startsWith(qNorm)) return (isTitle ? 85 : 65) - Math.min(15, t.length - qNorm.length);
      const words = t.split(/[\s\-_\/]+/);
      for (let i = 0; i < words.length; i++) {
        if (words[i].startsWith(qNorm)) {
          return (isTitle ? 70 : 50) - Math.min(10, words[i].length - qNorm.length) - (i * 2);
        }
      }
      if (qNorm.length >= 4 && t.includes(qNorm)) {
        return isTitle ? 30 : 15;
      }
      return 0;
    };

    const scored = [];
    for (const v of list) {
      let maxScore = 0;
      const titleScore = scoreItem(v.title, true);
      if (titleScore > maxScore) maxScore = titleScore;

      const cats = (v.categories && Array.isArray(v.categories)) ? v.categories : [v.category];
      for (const c of cats) {
        const catObj = (db.categories || []).find(x => x.id === c);
        const catName = catObj ? catObj.name : c;
        const cScore = Math.max(scoreItem(c), scoreItem(catName));
        if (cScore > maxScore) maxScore = cScore;
      }

      const authorScore = scoreItem(v.authorName);
      if (authorScore > maxScore) maxScore = authorScore;

      if (qNorm.length >= 4 && v.description) {
        const descScore = scoreItem(v.description) * 0.4;
        if (descScore > maxScore) maxScore = descScore;
      }

      if (maxScore > 0) {
        scored.push({ video: v, score: maxScore });
      }
    }

    if (req.query.sort === 'views') {
      scored.sort((a, b) => ((b.video.views || 0) - (a.video.views || 0)) || (b.score - a.score));
    } else if (req.query.sort === 'likes') {
      scored.sort((a, b) => ((b.video.likes || 0) - (a.video.likes || 0)) || (b.score - a.score));
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
    list = scored.map(item => item.video);
  } else {
    // Sort: recent (default), views, likes (when no search query is specified)
    const sort = req.query.sort || 'recent';
    if (sort === 'views') {
      list.sort((a, b) => ((b.views || 0) - (a.views || 0)) || (new Date(b.createdAt) - new Date(a.createdAt)));
    } else if (sort === 'likes') {
      list.sort((a, b) => ((b.likes || 0) - (a.likes || 0)) || (new Date(b.createdAt) - new Date(a.createdAt)));
    } else {
      // Default: VIP authors first, then by date
      list.sort((a, b) => {
        if (a.isVipAuthor && !b.isVipAuthor) return -1;
        if (!a.isVipAuthor && b.isVipAuthor) return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    }
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

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ videos: list });
});

// Single video lookup
app.get('/api/videos/:id', optionalAuthenticate, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  let video = (db.videos || []).find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Vidéo introuvable.' });
  video = resolveVideoThumbnail(video);

  // Enrich with creator badge and voter's existing rating (by user ID or session)
  const author = video.authorId ? (db.users || []).find(u => u.id === video.authorId) : null;
  const rawSession = (req.query.sessionId || req.headers['x-voter-session'] || '').toString().trim().slice(0, 64);
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const voterKey = req.user ? ('u_' + req.user.id) : (rawSession ? ('s_' + rawSession) : ('ip_' + clientIp));
  let userRating = null;
  if (video.ratings) {
    if (video.ratings[voterKey] !== undefined) {
      userRating = video.ratings[voterKey];
    } else if (req.user && video.ratings[req.user.id] !== undefined) {
      userRating = video.ratings[req.user.id];
    }
  }

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({
    video: {
      ...video,
      userRating,
      creatorBadge: author?.creatorBadge || video.creatorBadge || null
    }
  });
});

// Explorer Directory : group videos by category for fast search
app.get('/api/explorer', async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const approved = (db.videos || []).filter(v => v.status === 'approved').map(v => resolveVideoThumbnail(v));

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
        icon: c.icon || '',
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

const uploadVideoMiddleware = (req, res, next) => {
  upload.fields([
    { name: 'videoFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      console.error('[Upload Middleware Error]:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Le fichier dépasse la taille maximale autorisée (100 Mo).' });
      }
      return res.status(400).json({ error: err.message || 'Erreur lors du traitement du fichier.' });
    }
    next();
  });
};

// Direct Bunny Stream Ingestion (Bypasses Vercel 4.5MB payload limit completely)
app.post('/api/videos/bunny-init', optionalAuthenticate, async (req, res) => {
  if (!isBunnyConfigured()) {
    return res.status(503).json({ error: 'Bunny Stream non configuré.' });
  }

  const libraryId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
  const apiKey = (process.env.BUNNY_STREAM_API_KEY || '').trim();
  const title = (req.body.title || 'Vidéo ' + new Date().toISOString()).slice(0, 150);

  try {
    const createRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
      method: 'POST',
      headers: {
        'AccessKey': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ title })
    });

    if (!createRes.ok) {
      const errTxt = await createRes.text();
      console.error('[Bunny Init Error]:', createRes.status, errTxt);
      return res.status(500).json({ error: 'Échec de création sur Bunny Stream: ' + errTxt });
    }

    const videoData = await createRes.json();
    const videoGuid = videoData.guid;
    const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
    const hlsHost = customCdn || `vz-${libraryId}.b-cdn.net`;

    res.json({
      success: true,
      libraryId,
      videoId: videoGuid,
      uploadUrl: `https://video.bunnycdn.com/library/${libraryId}/videos/${videoGuid}`,
      apiKey,
      directPlayUrl: `https://${hlsHost}/${videoGuid}/playlist.m3u8`,
      iframeUrl: `https://iframe.mediadelivery.net/embed/${libraryId}/${videoGuid}?autoplay=false&preload=true`,
      thumbnailUrl: `https://${hlsHost}/${videoGuid}/thumbnail.jpg`,
      previewAnimationUrl: `https://${hlsHost}/${videoGuid}/preview.webp`
    });
  } catch (err) {
    console.error('[Bunny Init Exception]:', err);
    res.status(500).json({ error: 'Erreur lors de l\'initialisation Bunny: ' + err.message });
  }
});

app.post('/api/videos/bunny-complete', optionalAuthenticate, async (req, res) => {
  const {
    videoId,
    title,
    description,
    category,
    categories,
    email,
    uploaderEmail,
    region,
    uploaderRegion,
    customThumbnailBase64,
    directPlayUrl,
    iframeUrl,
    thumbnailUrl,
    previewAnimationUrl
  } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Identifiant vidéo Bunny manquant.' });
  }

  const resolvedEmail = (req.user ? req.user.email : (uploaderEmail || email || '')).trim().toLowerCase();
  const resolvedRegion = (region || uploaderRegion || 'Île-de-France').trim();

  if (!resolvedEmail) {
    return res.status(400).json({ error: 'L\'adresse e-mail est obligatoire pour finaliser le dépôt.' });
  }

  // Parse categories
  let parsedCategories = [];
  if (categories) {
    try {
      parsedCategories = typeof categories === 'string' ? JSON.parse(categories) : categories;
    } catch (e) {
      parsedCategories = [categories];
    }
  }
  if (!Array.isArray(parsedCategories)) {
    parsedCategories = [category || 'tech'];
  }
  parsedCategories = parsedCategories.filter(c => c && c !== 'all');
  if (parsedCategories.length === 0 && category && category !== 'all') {
    parsedCategories = [category];
  }
  if (parsedCategories.length === 0) {
    parsedCategories = ['tech'];
  }

  const finalTitle = (title || '').trim() || `Vidéo partagée depuis ${resolvedRegion}`;

  let thumbnail = thumbnailUrl;
  if (customThumbnailBase64 && customThumbnailBase64.startsWith('data:')) {
    const uploadedThumb = await uploadBase64ToSupabaseStorage('thumbnails', customThumbnailBase64, 'thumb_' + videoId);
    if (uploadedThumb) thumbnail = uploadedThumb;
  }

  await syncDbFromCloud();
  const db = loadDb();
  const isAdminUser = req.user && (req.user.role === 'admin' || req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com');
  const authorName = req.user ? req.user.username : resolvedEmail.split('@')[0];
  const authorAvatar = req.user ? req.user.avatar : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(authorName)}`;

  const libraryId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
  const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
  const hlsHost = customCdn || `vz-${libraryId}.b-cdn.net`;

  const newVideo = {
    id: 'vid_' + Date.now(),
    title: finalTitle,
    description: (description || '').trim(),
    videoUrl: directPlayUrl || `https://${hlsHost}/${videoId}/playlist.m3u8`,
    thumbnail: thumbnail || `https://${hlsHost}/${videoId}/thumbnail.jpg`,
    isBunnyStream: true,
    bunnyVideoId: videoId,
    iframeUrl: iframeUrl || `https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}?autoplay=false&preload=true`,
    previewAnimationUrl: previewAnimationUrl || `https://${hlsHost}/${videoId}/preview.webp`,
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
    publishedAt: isAdminUser ? new Date().toISOString() : null,
    views: 1,
    likes: 0,
    duration: "0:30",
    createdAt: new Date().toISOString()
  };

  db.videos.unshift(newVideo);
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Depot Video Bunny Stream', `Video "${newVideo.title}" (${newVideo.region}) televersee sur Bunny par ${resolvedEmail}`);

  const isApproved = newVideo.status === 'approved';
  if (!isApproved) {
    const adminUser = (db.users || []).find(u => u.role === 'admin' || (u.email && u.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') || (u.username && u.username.toLowerCase() === 'administrateur'));
    if (adminUser) {
      addNotificationToUser(db, adminUser.id, {
        type: 'moderation',
        message: `Nouvelle video en attente de validation : "${newVideo.title}" (${newVideo.authorName || resolvedEmail})`,
        link: '/#admin'
      });
      saveDb(db);
      await syncDbToCloud(db);
    }
  }

  res.status(201).json({
    message: isApproved
      ? 'Votre video a ete mise en ligne et publiee avec succes ! Le transcodage HD est en cours de finalisation.'
      : 'Votre video a ete envoyee avec succes ! Elle a ete transmise au centre administrateur pour verification et validation avant sa publication.',
    video: newVideo,
    isApproved
  });
});

app.post('/api/videos/upload', optionalAuthenticate, uploadVideoMiddleware, async (req, res) => {
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
    publishedAt: isAdminUser ? new Date().toISOString() : null,
    views: 1,
    likes: 0,
    duration: "0:30",
    createdAt: new Date().toISOString()
  };

  db.videos.unshift(newVideo);
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Depot Video', `Video "${newVideo.title}" (${newVideo.region}) deposee par ${resolvedEmail}`);

  const isApproved = newVideo.status === 'approved';
  if (!isApproved) {
    const adminUser = (db.users || []).find(u => u.role === 'admin' || (u.email && u.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') || (u.username && u.username.toLowerCase() === 'administrateur'));
    if (adminUser) {
      addNotificationToUser(db, adminUser.id, {
        type: 'moderation',
        message: `Nouvelle video en attente de validation : "${newVideo.title}" (${newVideo.authorName || resolvedEmail})`,
        link: '/#admin'
      });
      saveDb(db);
      await syncDbToCloud(db);
    }
  }

  res.status(201).json({
    message: isApproved 
      ? 'Votre video a ete mise en ligne et publiee avec succes !' 
      : 'Votre video a ete envoyee avec succes ! Elle a ete transmise au centre administrateur pour verification et validation avant sa publication.',
    video: newVideo,
    isApproved
  });
});

// In-memory cooldown map for video views: `${videoId}_${viewerKey}` -> timestamp
const videoViewCooldowns = new Map();
const VIEW_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between counted views per viewer

app.post('/api/videos/:id/view', optionalAuthenticate, async (req, res) => {
  const videoId = req.params.id;
  const db = loadDb();
  const video = (db.videos || []).find(v => v.id === videoId);
  if (!video) {
    return res.status(404).json({ error: 'Video introuvable.' });
  }

  // Determine viewer key (user ID, session ID, or IP)
  const sessionId = (req.body?.sessionId || req.query.sessionId || '').toString().trim().slice(0, 64);
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const viewerKey = req.user ? `u_${req.user.id}` : (sessionId ? `s_${sessionId}` : `ip_${clientIp}`);
  const cooldownKey = `${videoId}_${viewerKey}`;

  const now = Date.now();
  const lastViewTime = videoViewCooldowns.get(cooldownKey) || 0;

  if (now - lastViewTime < VIEW_COOLDOWN_MS) {
    return res.json({ success: true, views: video.views || 1, counted: false });
  }

  videoViewCooldowns.set(cooldownKey, now);

  if (videoViewCooldowns.size > 10000) {
    for (const [k, ts] of videoViewCooldowns.entries()) {
      if (now - ts > VIEW_COOLDOWN_MS) videoViewCooldowns.delete(k);
    }
  }

  video.views = (video.views || 0) + 1;

  if (video.authorId) {
    computeCreatorBadge(video.authorId, db);
  }

  saveDb(db);
  await syncDbToCloud(db);

  res.json({
    success: true,
    views: video.views,
    counted: true
  });
});

app.post('/api/videos/:id/like', optionalAuthenticate, async (req, res) => {
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video non trouvee.' });
  }
  video.likes = (video.likes || 0) + 1;

  let convertedToVip = false;
  // Threshold: reaching 5 likes automatically converts free video to VIP Exclusive
  const VIP_LIKE_THRESHOLD = 5;
  if (video.likes >= VIP_LIKE_THRESHOLD && !video.isVipExclusive) {
    video.isVipExclusive = true;
    convertedToVip = true;
    addLog('Conversion VIP Automatique', `La video "${video.title}" a atteint ${video.likes} mentions J'aime et est automatiquement passee en Contenu Exclusif VIP.`);
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
  await syncDbToCloud(db);

  res.json({
    likes: video.likes,
    isVipExclusive: !!video.isVipExclusive,
    convertedToVip,
    message: convertedToVip ? "Cette video populaire a atteint 5 mentions J'aime et est desormais passee en Contenu Exclusif VIP !" : null
  });
});

app.post('/api/admin/videos/:id/toggle-vip-exclusive', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }
  video.isVipExclusive = !video.isVipExclusive;
  saveDb(db);
  await syncDbToCloud(db);
  addLog('Modération VIP', `Vidéo "${video.title}" statut VIP Exclusif : ${video.isVipExclusive}`);
  res.json({
    message: video.isVipExclusive ? 'Vidéo désormais réservée aux membres VIP.' : 'Vidéo remise en accès gratuit.',
    isVipExclusive: video.isVipExclusive
  });
});

// Rate video (1 to 5 stars - Open to all visitors, strictly 1 vote per session or user)
app.post('/api/videos/:id/rate', optionalAuthenticate, async (req, res) => {
  const ratingValue = parseFloat(req.body.rating);
  if (isNaN(ratingValue) || ratingValue < 1 || ratingValue > 5) {
    return res.status(400).json({ error: 'La note doit être comprise entre 1 et 5 étoiles.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const rawSession = (req.body.sessionId || req.headers['x-voter-session'] || '').toString().trim().slice(0, 64);
  const voterKey = req.user ? ('u_' + req.user.id) : (rawSession ? ('s_' + rawSession) : ('ip_' + clientIp));
  const ipKey = clientIp && clientIp !== 'unknown' ? ('ip_' + clientIp) : null;

  if (!video.ratings || typeof video.ratings !== 'object') {
    video.ratings = {};
  }

  let existingRating = video.ratings[voterKey];
  let legacyKey = null;
  if (existingRating === undefined && req.user && video.ratings[req.user.id] !== undefined) {
    existingRating = video.ratings[req.user.id];
    legacyKey = req.user.id;
  }
  // IP protection: prevent user from bypassing vote limits by clearing session or private browsing
  if (existingRating === undefined && ipKey && video.ratings[ipKey] !== undefined) {
    existingRating = video.ratings[ipKey];
    legacyKey = ipKey;
  }

  if (existingRating !== undefined) {
    if (existingRating === ratingValue) {
      return res.status(200).json({
        alreadyRated: true,
        rating: video.rating,
        ratingCount: video.ratingCount,
        userRating: existingRating,
        message: `Vous avez déjà attribué la note de ${existingRating}/5 à cette vidéo.`
      });
    }

    // Voter is modifying their existing vote: ratingCount DOES NOT CHANGE!
    const oldRating = existingRating;
    if (legacyKey && legacyKey !== voterKey) {
      delete video.ratings[legacyKey];
    }
    video.ratings[voterKey] = ratingValue;
    if (ipKey) {
      video.ratings[ipKey] = ratingValue;
    }
    const currentSum = (typeof video.ratingSum === 'number' && !isNaN(video.ratingSum))
      ? video.ratingSum
      : (video.rating ? video.rating * (video.ratingCount || 1) : oldRating);
    video.ratingSum = Math.max(0, currentSum - oldRating + ratingValue);
    const count = Math.max(1, video.ratingCount || 1);
    video.rating = parseFloat((video.ratingSum / count).toFixed(1));

    saveDb(db);
    await syncDbToCloud(db);

    return res.json({
      success: true,
      updated: true,
      rating: video.rating,
      ratingCount: video.ratingCount,
      userRating: ratingValue,
      message: `Votre note a été mise à jour : ${ratingValue}/5.`
    });
  }

  // First vote by this session / IP / user on this video
  video.ratings[voterKey] = ratingValue;
  if (ipKey) {
    video.ratings[ipKey] = ratingValue;
  }
  video.ratingCount = (video.ratingCount || 0) + 1;
  const currentSum = (typeof video.ratingSum === 'number' && !isNaN(video.ratingSum))
    ? video.ratingSum
    : (video.rating ? video.rating * (video.ratingCount - 1) : 0);
  video.ratingSum = currentSum + ratingValue;
  video.rating = parseFloat((video.ratingSum / video.ratingCount).toFixed(1));

  saveDb(db);
  await syncDbToCloud(db);

  res.json({
    success: true,
    rating: video.rating,
    ratingCount: video.ratingCount,
    userRating: ratingValue,
    message: `Merci pour votre note de ${ratingValue}/5 !`
  });
});

// ---------------- COMMENTS & SIMILAR VIDEOS & TAG EDIT ENDPOINTS ----------------
// Get comments for a video
app.get('/api/videos/:id/comments', async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }
  const comments = (db.comments || []).filter(c => c.videoId === video.id);
  res.json({ comments: comments.length > 0 ? comments : (video.comments || []) });
});

// Post a comment on a video (AUTHENTICATED ONLY - requires account)
app.post('/api/videos/:id/comments', authenticate, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Veuillez saisir un texte de commentaire valide.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const resolvedAuthorName = (req.user.username || 'Membre').trim();
  const resolvedAvatar = req.user.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(resolvedAuthorName)}`;

  const newComment = {
    id: 'comm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    videoId: video.id,
    videoTitle: video.title || 'Vidéo',
    authorId: req.user.id,
    authorName: resolvedAuthorName,
    authorAvatar: resolvedAvatar,
    isVip: Boolean(req.user.isVip),
    isAdmin: Boolean(req.user.role === 'admin' || req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com'),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };

  db.comments = db.comments || [];
  db.comments.unshift(newComment);

  video.comments = video.comments || [];
  video.comments.unshift(newComment);

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Nouveau Commentaire', `Commentaire ajouté sur "${video.title}" par ${resolvedAuthorName}`);

  res.status(201).json({
    message: 'Commentaire publié avec succès !',
    comment: newComment,
    comments: video.comments
  });
});

// Delete a comment (SEUL L'ADMINISTRATEUR PEUT SUPPRIMER)
app.delete('/api/videos/:id/comments/:commentId', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
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
  if (Array.isArray(db.comments)) {
    db.comments = db.comments.filter(c => c.id !== req.params.commentId);
  }

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Suppression Commentaire', `Commentaire de "${removed.authorName}" sur "${video.title}" supprimé par Admin (${req.user.username})`);

  res.json({
    message: 'Commentaire supprimé par l\'administrateur avec succès.',
    comments: video.comments
  });
});

// Admin list all recorded comments
app.get('/api/admin/comments', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  res.json({ comments: db.comments || [] });
});

// ---------------- INTERNAL MESSAGING SYSTEM (MESSAGERIE PRIVÉE) ----------------
// Get conversations list
app.get('/api/messages/conversations', optionalAuthenticate, async (req, res) => {
  await syncDbFromCloud();
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

  const isVipUser = Boolean(req.user && (req.user.isVip || req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') || (req.user.username && req.user.username.toLowerCase() === 'administrateur')));

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
        lastMessageIsMine: isSender,
        lastMessageTime: m.createdAt,
        unreadCount: (!isSender && !m.read) ? 1 : 0,
        sentCount: isSender ? 1 : 0
      });
    } else {
      const conv = conversationsMap.get(partnerName.toLowerCase());
      if (new Date(m.createdAt) > new Date(conv.lastMessageTime)) {
        conv.lastMessage = m.text;
        conv.lastMessageIsMine = isSender;
        conv.lastMessageTime = m.createdAt;
      }
      if (!isSender && !m.read) {
        conv.unreadCount++;
      }
      if (isSender) {
        conv.sentCount = (conv.sentCount || 0) + 1;
      }
    }
  });

  const freeLimit = 2;
  const list = Array.from(conversationsMap.values()).map(conv => {
    // Lock last message preview if non-VIP has exhausted quota AND last message is from the partner
    const isLocked = !isVipUser && conv.sentCount >= freeLimit && !conv.lastMessageIsMine;
    return {
      partnerName: conv.partnerName,
      partnerAvatar: conv.partnerAvatar,
      lastMessage: isLocked ? null : conv.lastMessage,
      lastMessageTime: conv.lastMessageTime,
      unreadCount: conv.unreadCount,
      isLocked
    };
  }).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

  res.json({ conversations: list });
});

// Get messages with a specific user
app.get('/api/messages/with/:username', optionalAuthenticate, async (req, res) => {
  await syncDbFromCloud();
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

  const isVip = Boolean(req.user && (req.user.isVip || req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') || (req.user.username && req.user.username.toLowerCase() === 'administrateur')));
  const sentCount = thread.filter(m => m.senderName && m.senderName.toLowerCase() === myUsername).length;
  const freeLimit = 2;
  const remaining = isVip ? 999 : Math.max(0, freeLimit - sentCount);
  const canSend = isVip || sentCount < freeLimit;

  // Mask incoming messages if non-VIP has exhausted their free 2-message quota
  const processedThread = thread.map(m => {
    const isMe = m.senderName && m.senderName.toLowerCase() === myUsername;
    if (!isVip && !canSend && !isMe) {
      return {
        ...m,
        text: m.text ? m.text.replace(/[^\s]/g, '•') : '••••••••••••••••',
        isLocked: true
      };
    }
    return {
      ...m,
      isLocked: false
    };
  });

  res.json({
    partnerUsername: req.params.username,
    messages: processedThread,
    isVip: !!isVip,
    sentCount,
    freeLimit,
    remaining,
    canSend
  });
});

// Send a direct message (2 free messages limit per conversation for non-VIP)
app.post('/api/messages/send', optionalAuthenticate, async (req, res) => {
  const { recipientUsername, text } = req.body;
  if (!recipientUsername || !recipientUsername.trim()) {
    return res.status(400).json({ error: 'Destinataire manquant.' });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
  }

  if (!req.user) {
    return res.status(401).json({
      error: 'Veuillez vous connecter pour envoyer un message privé et profiter de vos 2 messages offerts.',
      requireLogin: true
    });
  }

  await syncDbFromCloud();
  const db = loadDb();
  db.messages = db.messages || [];

  const mySenderName = req.user.username.trim();
  const targetUsername = recipientUsername.trim();
  const isVip = req.user.isVip || req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'ia.project.pro2k26@gmail.com');

  // Quota calculation: count messages sent by this user to this partner
  const sentCount = db.messages.filter(m =>
    m.senderName && m.senderName.toLowerCase() === mySenderName.toLowerCase() &&
    m.recipientName && m.recipientName.toLowerCase() === targetUsername.toLowerCase()
  ).length;

  if (!isVip && sentCount >= 2) {
    return res.status(403).json({
      error: 'Limite de 2 messages gratuits atteinte pour cette conversation. Passez Membre VIP pour débloquer la messagerie illimitée !',
      requiresVip: true,
      sentCount,
      freeLimit: 2
    });
  }

  const myAvatar = req.user.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(mySenderName)}`;

  // Find recipient avatar if registered
  const recipientUser = db.users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  const recipientAvatar = recipientUser ? recipientUser.avatar : `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(targetUsername)}`;

  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    senderId: req.user.id,
    senderName: mySenderName,
    senderAvatar: myAvatar,
    recipientId: recipientUser ? recipientUser.id : null,
    recipientName: targetUsername,
    recipientAvatar: recipientAvatar,
    text: text.trim(),
    read: false,
    createdAt: new Date().toISOString()
  };

  db.messages.push(newMsg);

  // Notify recipient in-app if registered
  if (recipientUser) {
    addNotificationToUser(db, recipientUser.id, {
      type: 'message',
      message: `Nouveau message privé de ${mySenderName}`,
      link: '/#messages'
    });
  }

  saveDb(db);
  await syncDbToCloud(db);

  const quotaInfo = isVip ? 'VIP illimité' : `${sentCount + 1}/2 gratuit`;
  addLog('Message Envoyé', `Message de "${mySenderName}" à "${targetUsername}" (${quotaInfo})`);

  // Email incitatif au destinataire (s'il a un email enregistré)
  if (recipientUser && recipientUser.email) {
    const siteUrl = SITE_URL;
    const chatLink = `${siteUrl}/#messages?with=${encodeURIComponent(mySenderName)}`;
    const recipientIsVip = recipientUser.isVip || recipientUser.role === 'admin';

    // Teaser du message (flouté partiellement pour les non-VIP destinataires)
    const msgTeaser = text.length > 30 ? text.substring(0, 30) + '...' : text;
    const blurredTeaser = recipientIsVip
      ? `<span style="font-style:italic;color:#e2e8f0;">${msgTeaser}</span>`
      : `<span style="filter:blur(4px);user-select:none;color:#94a3b8;font-style:italic;">${msgTeaser}</span>`;

    const vipBlock = recipientIsVip ? '' : `
      <div style="margin-top:20px;background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid rgba(245,158,11,0.35);border-radius:12px;padding:16px 20px;text-align:center;">
        <p style="font-size:0.82rem;color:#f59e0b;font-weight:700;margin:0 0 6px;">Réponse masquée</p>
        <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 14px;">La réponse de <strong style="color:#f8fafc;">${mySenderName}</strong> est masquée. Passez VIP pour lire et répondre en illimité.</p>
        <a href="${siteUrl}/#vip" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:800;font-size:0.9rem;padding:12px 28px;border-radius:999px;text-decoration:none;">Débloquer le Pass VIP - 9,99€</a>
      </div>
    `;

    try {
      await sendRobustEmail({
        to: recipientUser.email,
        subject: `${mySenderName} vous a envoyé un message - Répondez vite !`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:0 auto;background:#0b1120;color:#f8fafc;border-radius:16px;overflow:hidden;border:1px solid rgba(249,115,22,0.25);box-shadow:0 20px 50px rgba(0,0,0,0.6);">
            <div style="background:radial-gradient(circle at 50% 30%, #1e1b4b 0%, #090d16 70%, #030712 100%);padding:32px 24px 26px;text-align:center;border-bottom:1px solid rgba(249,115,22,0.2);position:relative;">
              <div style="display:inline-block;margin-bottom:12px;">
                <img src="${siteUrl}/revedeq-emblem-messages.png" alt="Rêve de Q" width="68" height="68" style="display:block;margin:0 auto;filter:drop-shadow(0 0 18px rgba(249,115,22,0.7));">
              </div>
              <div style="margin:0;font-size:24px;font-weight:900;letter-spacing:-0.5px;line-height:1.1;">
                <span style="color:#ffffff;">Rêve de </span><span style="color:#fbbf24;text-shadow:0 0 18px rgba(249,115,22,0.75);">Q</span>
              </div>
              <p style="margin:8px 0 0;color:#94a3b8;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Messagerie Privée Sécurisée</p>
              <div style="height:2px;width:60px;background:linear-gradient(90deg,transparent,#f59e0b,transparent);margin:16px auto 0;"></div>
            </div>
            <div style="padding:28px 24px;background-color:#0b1120;">
              <p style="font-size:1rem;font-weight:700;color:#f8fafc;margin:0 0 6px;">${mySenderName} vous a écrit un message !</p>
              <p style="font-size:0.88rem;color:#94a3b8;margin:0 0 20px;">Ne le laissez pas sans réponse — il attend votre retour.</p>

              <div style="background:#1e293b;border-left:3px solid #f97316;border-radius:0 10px 10px 0;padding:14px 18px;margin-bottom:20px;">
                <p style="font-size:0.78rem;color:#64748b;margin:0 0 4px;font-weight:600;">${mySenderName} - Message privé</p>
                <p style="margin:0;font-size:0.95rem;line-height:1.5;">${blurredTeaser}</p>
              </div>

              <a href="${chatLink}" style="display:block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:800;font-size:0.95rem;padding:14px 24px;border-radius:12px;text-decoration:none;text-align:center;margin-bottom:16px;">Voir le message &amp; Répondre</a>

              ${vipBlock}

              <p style="font-size:0.72rem;color:#475569;margin-top:24px;text-align:center;">
                Vous recevez cet email car vous êtes membre Rêve de Q.<br>
                <a href="${siteUrl}" style="color:#f97316;text-decoration:none;">Accéder à Rêve de Q</a>
              </p>
            </div>
          </div>
        `,
        category: 'MESSAGE_NOTIFICATION'
      });
    } catch (emailErr) {
      console.error('[Email Notification Error]', emailErr.message);
    }
  }

  const remaining = isVip ? 999 : Math.max(0, 2 - (sentCount + 1));

  res.status(201).json({
    message: 'Message envoyé avec succès !',
    msg: newMsg,
    sentCount: sentCount + 1,
    freeLimit: 2,
    remaining,
    isVip: !!isVip
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

  const approved = (db.videos || [])
    .filter(v => v.status === 'approved' && v.id !== video.id)
    .map(v => resolveVideoThumbnail(v));

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
app.get('/api/admin/videos', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const { status, category, search } = req.query;
  const db = loadDb();
  let list = (db.videos || []).map(v => resolveVideoThumbnail(v));

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

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ videos: list });
});

app.post('/api/admin/videos/:id/approve', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  video.status = 'approved';
  video.publishedAt = new Date().toISOString();

  // Notify author if registered user
  if (video.authorId) {
    addNotificationToUser(db, video.authorId, {
      type: 'moderation',
      message: `Votre video "${video.title.slice(0, 40)}" a ete approuvee et publiee par l'administrateur !`,
      link: `/?video=${video.id}`
    });
  }

  // Update creator badge level
  if (video.authorId) computeCreatorBadge(video.authorId, db);

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Validation Video', `Video "${video.title}" validee et publiee par Admin`);

  const resolvedVideo = resolveVideoThumbnail(video);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({
    message: `La video "${video.title}" a ete validee et mise en ligne !`,
    video: resolvedVideo
  });
});

app.post('/api/admin/videos/:id/toggle-daily', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
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
  await syncDbToCloud(db);
  addLog('Sélection du Jour', `Vidéo "${video.title}" ${video.isDailyFeatured ? 'marquée comme Vidéo du Jour ' : 'retirée de la sélection du jour'}`);

  res.json({
    message: video.isDailyFeatured 
      ? ` "${video.title}" a été ajoutée à la Sélection du Jour !` 
      : `"${video.title}" a été retirée de la Sélection du Jour.`,
    isDailyFeatured: video.isDailyFeatured,
    video
  });
});

// Admin Delete Video (POST /reject and DELETE /)
app.post('/api/admin/videos/:id/reject', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const videoId = req.params.id;
  const index = (db.videos || []).findIndex(v => v.id === videoId);
  if (index === -1) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const removed = db.videos.splice(index, 1)[0];
  
  // Remove comments associated with this video
  db.comments = (db.comments || []).filter(c => c.videoId !== videoId);

  // Remove from favorites of all users
  (db.users || []).forEach(u => {
    if (Array.isArray(u.favorites)) {
      u.favorites = u.favorites.filter(fId => fId !== videoId);
    }
  });

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Suppression Vidéo Admin', `Vidéo "${removed.title}" supprimée définitivement par Admin`);

  res.json({
    success: true,
    message: `La vidéo "${removed.title}" a été supprimée définitivement.`
  });
});

app.delete('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const videoId = req.params.id;
  const index = (db.videos || []).findIndex(v => v.id === videoId);
  if (index === -1) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const removed = db.videos.splice(index, 1)[0];
  db.comments = (db.comments || []).filter(c => c.videoId !== videoId);
  (db.users || []).forEach(u => {
    if (Array.isArray(u.favorites)) {
      u.favorites = u.favorites.filter(fId => fId !== videoId);
    }
  });

  saveDb(db);
  await syncDbToCloud(db);

  // Clean up Bunny Stream video if applicable
  if (removed.bunnyVideoId) {
    const libraryId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
    const apiKey = (process.env.BUNNY_STREAM_API_KEY || '').trim();
    if (libraryId && apiKey) {
      fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${removed.bunnyVideoId}`, {
        method: 'DELETE',
        headers: { 'AccessKey': apiKey }
      }).catch(err => console.error('[Bunny Delete Error]:', err));
    }
  }

  addLog('Suppression Vidéo Admin', `Vidéo "${removed.title}" supprimée définitivement par Admin`);

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({
    success: true,
    message: `La vidéo "${removed.title}" a été supprimée définitivement.`
  });
});

app.put('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  const { title, description, category, categories, thumbnail, isVipExclusive, vipPreviewStart, vipPreviewDuration } = req.body;
  await syncDbFromCloud(true);
  const db = loadDb();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Video introuvable.' });
  }

  if (title) video.title = title.trim();
  if (description !== undefined) video.description = description.trim();
  
  if (isVipExclusive !== undefined) {
    video.isVipExclusive = Boolean(isVipExclusive);
  }
  if (vipPreviewStart !== undefined) {
    video.vipPreviewStart = Math.max(0, parseInt(vipPreviewStart, 10) || 0);
  }
  if (vipPreviewDuration !== undefined) {
    video.vipPreviewDuration = Math.max(5, parseInt(vipPreviewDuration, 10) || 15);
  }
  
  if (Array.isArray(categories) && categories.length > 0) {
    video.categories = categories;
    video.category = categories[0];
  } else if (category) {
    video.category = category;
    if (!video.categories || video.categories.length === 0) {
      video.categories = [category];
    }
  }

  // Process and save thumbnail captured or uploaded by admin
  if (thumbnail && typeof thumbnail === 'string') {
    if (thumbnail.startsWith('data:image')) {
      try {
        const thumbFilename = `thumb_admin_${video.id}_${Date.now()}`;
        const supabaseThumb = await uploadBase64ToSupabaseStorage('thumbnails', thumbnail, thumbFilename);
        if (supabaseThumb) {
          video.thumbnail = supabaseThumb;
        } else if (video.bunnyVideoId) {
          const customCdn = (process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
          const libId = (process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
          const hlsHost = customCdn || `vz-${libId}.b-cdn.net`;
          video.thumbnail = `https://${hlsHost}/${video.bunnyVideoId}/thumbnail.jpg`;
        } else {
          const matches = thumbnail.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const buffer = Buffer.from(matches[2], 'base64');
            const filename = `thumb_admin_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.jpg`;
            const filepath = path.join(uploadsDir, filename);
            fs.writeFileSync(filepath, buffer);
            video.thumbnail = `/uploads/${filename}`;
          }
        }
      } catch (e) {
        console.error('Error saving base64 thumbnail:', e);
      }
    } else if (thumbnail.trim()) {
      video.thumbnail = thumbnail.trim();
    }
  }

  saveDb(db);
  await syncDbToCloud(db);
  addLog('Modification Vidéo', `Métadonnées et miniature de "${video.title}" mises à jour par Admin`);

  const resolvedVideo = resolveVideoThumbnail(video);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ message: 'Vidéo et miniature mises à jour avec succès ! ', video: resolvedVideo });
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
      subject: `Nouveau Signalement : ${newReport.reason} - Rêve de Q`,
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
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const limitCheck = checkIpRateLimit(contactAttempts, clientIp, 5, 15 * 60 * 1000, 15 * 60 * 1000);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: `Trop de messages envoyes. Veuillez patienter ${limitCheck.remaining} minute(s) avant de renvoyer un message.`
    });
  }
  recordIpAttempt(contactAttempts, clientIp, 5, 15 * 60 * 1000);

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
    read: false,
    replied: false,
    createdAt: new Date().toISOString()
  };

  db.contactMessages.unshift(newContact);

  // Notify admin in-app
  const adminUser = (db.users || []).find(u => u.role === 'admin' || (u.email && u.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') || (u.username && u.username.toLowerCase() === 'administrateur'));
  if (adminUser) {
    addNotificationToUser(db, adminUser.id, {
      type: 'contact',
      message: `Nouveau message de contact de ${newContact.name} (${newContact.subject})`,
      link: '/admin'
    });
  }

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Contact', `Nouveau message de ${newContact.name} (${newContact.email}) - Objet: ${newContact.subject}`);

  const adminRecipients = ['ia.project.pro2k26@gmail.com'];
  const officialSender = process.env.SMTP_FROM || process.env.SMTP_USER || 'support@revedeq.fr';
  if (!adminRecipients.includes(officialSender)) {
    adminRecipients.push(officialSender);
  }

  // 1. Send direct notification email to Admin
  const adminContactHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155;">
      <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 30px 24px; text-align: center;">
        <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">Rêve de <span style="color: #0f172a; background: #ffffff; padding: 2px 8px; border-radius: 6px; margin-left: 4px;">Q</span></h1>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600;">Tes rêves, tes délires.</p>
        <div style="display: inline-block; margin-top: 12px; background: rgba(15, 23, 42, 0.4); padding: 4px 14px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #ffffff; text-transform: uppercase;">
          Nouveau message de contact reçu
        </div>
      </div>
      <div style="padding: 28px 24px; line-height: 1.6;">
        <p style="margin: 0 0 10px 0;"><strong style="color:#f97316;">Expéditeur :</strong> ${newContact.name} (<a href="mailto:${newContact.email}" style="color:#38bdf8;">${newContact.email}</a>)</p>
        <p style="margin: 0 0 16px 0;"><strong style="color:#f97316;">Objet :</strong> ${newContact.subject}</p>
        <div style="background: #1e293b; border-radius: 8px; padding: 18px; border: 1px solid #334155; margin-bottom: 22px;">
          <strong style="color:#cbd5e1; font-size:13px; display:block; margin-bottom:8px;">Message du visiteur :</strong>
          <p style="color: #f8fafc; font-size: 14px; margin: 0; white-space: pre-wrap;">${newContact.message}</p>
        </div>
        <div style="text-align: center; margin-top: 25px;">
          <a href="${SITE_URL}/#admin" style="background-color: #f97316; color: #ffffff; text-decoration: none; padding: 13px 26px; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block;">
            Accéder à l'Espace Admin pour Répondre
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; border-top: 1px solid #334155; padding-top: 18px; margin-top: 25px; margin-bottom: 0;">
          Ce message est également archivé dans votre onglet <strong>Administration &gt; Messages</strong> sur le site.
        </p>
      </div>
    </div>
  `;
  const adminContactText = `Nouveau message de contact Rêve de Q\n\nDe : ${newContact.name} (${newContact.email})\nObjet : ${newContact.subject}\n\nMessage :\n${newContact.message}\n\nRépondre dans l'administration : ${SITE_URL}/#admin`;

  for (const adminTo of adminRecipients) {
    try {
      await sendRobustEmail({
        to: adminTo,
        replyTo: newContact.email,
        subject: `[Rêve de Q Contact] ${newContact.subject} (de ${newContact.name})`,
        html: adminContactHtml,
        text: adminContactText,
        category: 'CONTACT_ADMIN'
      });
    } catch (e) {}
  }

  // 2. Send automatic confirmation email to the user with full Rêve de Q branding
  try {
    const confirmationTpl = generateEmailTemplate('contact_confirmation', {
      username: newContact.name,
      toEmail: newContact.email,
      contactSubject: newContact.subject,
      originalMessage: newContact.message
    });
    await sendRobustEmail({
      to: newContact.email,
      subject: confirmationTpl.subject,
      html: confirmationTpl.html,
      text: confirmationTpl.text,
      category: 'CONTACT_CONFIRM'
    });
  } catch (e) {}

  res.status(201).json({
    message: 'Votre message a été envoyé avec succès ! Notre équipe a été notifiée par e-mail.',
    contact: newContact
  });
});

// ---------------- ADMIN REPORTS (SIGNALEMENTS) ----------------
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ reports: db.reports || [] });
});

app.delete('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const repId = req.params.id;
  db.reports = (db.reports || []).filter(r => r.id !== repId);
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Suppression Signalement', `Signalement #${repId} supprimé définitivement par Admin`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, message: 'Signalement supprimé définitivement.', reports: db.reports });
});

// Purger tous les signalements
app.delete('/api/admin/reports', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const count = (db.reports || []).length;
  db.reports = [];
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Purger Signalements', `${count} signalement(s) purgé(s) par Admin`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, message: 'Tous les signalements ont été supprimés.', reports: [] });
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  rep.status = 'resolved';
  rep.resolvedAt = new Date().toISOString();
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Signalement Traite', `Signalement #${rep.id} marque comme resolu par Admin`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ message: 'Signalement marque comme traite.', report: rep });
});

app.post('/api/admin/reports/:id/delete-video', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
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
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ message: 'Video supprimee et signalement resolu.', report: rep, deleted: !!deletedVideo });
});

app.post('/api/admin/reports/:id/dismiss', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  db.reports = db.reports || [];
  const rep = db.reports.find(r => r.id === req.params.id);
  if (!rep) return res.status(404).json({ error: 'Signalement introuvable.' });

  rep.status = 'dismissed';
  rep.resolvedAt = new Date().toISOString();
  saveDb(db);
  await syncDbToCloud(db);

  addLog('Signalement Classe', `Signalement #${rep.id} classe sans suite.`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ message: 'Signalement classe sans suite.', report: rep });
});

// ---------------- ADMIN CONTACT MESSAGES ----------------
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({ messages: db.contactMessages || [] });
});

app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const targetId = req.params.id;
  const targetMsg = (db.contactMessages || []).find(m => m.id === targetId);
  db.contactMessages = (db.contactMessages || []).filter(m => m.id !== targetId);
  if (targetMsg) {
    addLog('Suppression Message', `Message de "${targetMsg.name}" (${targetMsg.email}) supprimé par Admin`);
  }
  saveDb(db);
  await syncDbToCloud(db);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, message: 'Message supprimé avec succès.', messages: db.contactMessages });
});

// Purger tous les messages de contact
app.delete('/api/admin/messages', requireAdmin, async (req, res) => {
  await syncDbFromCloud(true);
  const db = loadDb();
  const count = (db.contactMessages || []).length;
  db.contactMessages = [];
  saveDb(db);
  await syncDbToCloud(db);
  addLog('Purger Messages', `${count} message(s) supprimé(s) par Admin`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, message: 'Tous les messages ont été supprimés.', messages: [] });
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

  const subject = (replySubject && replySubject.trim()) || `Re: ${msg.subject || 'Votre message sur Rêve de Q'}`;

  const template = generateEmailTemplate('contact_reply', {
    username: msg.name || 'Membre',
    toEmail: msg.email,
    subject: subject,
    replyText: replyText.trim(),
    originalMessage: msg.message
  });

  const officialSender = process.env.SMTP_FROM || process.env.SMTP_USER || 'support@revedeq.fr';

  // Send real email to the user with full official brand codes
  try {
    await sendRobustEmail({
      to: msg.email,
      from: `"Rêve de Q Support" <${officialSender}>`,
      replyTo: officialSender,
      subject: template.subject,
      html: template.html,
      text: template.text,
      category: 'CONTACT_REPLY'
    });
  } catch (err) {
    console.error('Error sending contact reply email', err);
    return res.status(500).json({ error: "Échec de l'envoi de l'e-mail. Vérifiez la configuration SMTP." });
  }

  msg.read = true;
  msg.replied = true;
  msg.repliedAt = new Date().toISOString();
  msg.lastReplyText = replyText.trim();
  msg.lastReplySubject = subject;

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Réponse Contact', `Réponse envoyée à ${msg.email} (Sujet: ${subject}) par Admin`);

  res.json({ success: true, message: `Réponse envoyée avec succès à ${msg.email}`, messageRecord: msg });
});

// Marquer un message de contact comme lu
app.post('/api/admin/messages/:id/read', requireAdmin, async (req, res) => {
  await syncDbFromCloud();
  const db = loadDb();
  const msg = (db.contactMessages || []).find(m => m.id === req.params.id);
  if (msg) {
    msg.read = true;
    saveDb(db);
    await syncDbToCloud(db);
  }
  res.json({ success: true });
});

// ---------------- ADMIN MODIFY VIDEO TAGS (MAX 5 TAGS) ----------------
app.put('/api/admin/videos/:id/tags', requireAdmin, async (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) {
    return res.status(400).json({ error: 'Le format des tags est invalide.' });
  }
  if (tags.length > 5) {
    return res.status(400).json({ error: 'Vous ne pouvez pas sélectionner plus de 5 tags.' });
  }

  await syncDbFromCloud();
  const db = loadDb();
  const video = (db.videos || []).find(v => v.id === req.params.id);
  if (!video) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }

  const cleanTags = tags.map(t => String(t).trim()).filter(Boolean);
  video.categories = cleanTags.length > 0 ? cleanTags : ['divers'];
  video.category = video.categories[0] || 'divers';

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Modification Tags', `Tags de la vidéo "${video.title}" mis à jour par Admin: ${video.categories.join(', ')}`);

  res.json({
    success: true,
    message: 'Tags mis à jour avec succès.',
    video: {
      id: video.id,
      title: video.title,
      categories: video.categories,
      category: video.category
    }
  });
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

// Admin Delete User
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  await syncDbFromCloud(true);
  const db = loadDb();
  const targetUser = db.users.find(u => u.id === userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const isAdminUser = (targetUser.role === 'admin') || 
                      (targetUser.email && targetUser.email.toLowerCase() === 'ia.project.pro2k26@gmail.com') ||
                      (targetUser.username && targetUser.username.toLowerCase() === 'administrateur');
  if (isAdminUser) {
    return res.status(403).json({ error: 'Impossible de supprimer le compte administrateur.' });
  }

  const targetEmail = (targetUser.email || '').trim().toLowerCase();
  db.users = db.users.filter(u => u.id !== userId && (!targetEmail || !u.email || u.email.trim().toLowerCase() !== targetEmail));
  
  // Retain published videos in catalog with anonymized author references as per CGU
  let adminRetainedCount = 0;
  (db.videos || []).forEach(v => {
    const isAuthor = v.authorId === userId || (targetEmail && v.authorEmail && v.authorEmail.toLowerCase() === targetEmail);
    if (isAuthor) {
      v.authorId = null;
      v.authorEmail = null;
      adminRetainedCount += 1;
    }
  });

  saveDb(db);
  await syncDbToCloud(db);

  addLog('Suppression Utilisateur Admin', `Utilisateur supprime par admin: ${targetUser.username} (${targetUser.email}). ${adminRetainedCount} video(s) conservees en ligne.`);
  res.json({ success: true, message: 'Utilisateur supprime definitivement.' });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    await syncDbFromCloud();
    const db = loadDb();

    const videos = Array.isArray(db.videos) ? db.videos : [];
    const users = Array.isArray(db.users) ? db.users : [];
    const categories = Array.isArray(db.categories) ? db.categories : [];
    const reports = Array.isArray(db.reports) ? db.reports : [];
    const contactMessages = Array.isArray(db.contactMessages) ? db.contactMessages : [];

    const totalViews = videos.reduce((acc, v) => acc + (v.views || 0), 0);
    const totalLikes = videos.reduce((acc, v) => acc + (v.likes || 0), 0);
    const totalVips = users.filter(u => u.isVip).length;
    const pendingReports = reports.filter(r => r.status === 'pending').length;
    const totalReports = reports.length;
    const pendingCategories = categories.filter(c => c.status === 'pending').length;
    const totalMessages = contactMessages.length;
    const unreadMessages = contactMessages.filter(m => !m.read && !m.replied).length;
    const totalComments = videos.reduce((acc, v) => acc + (Array.isArray(v.comments) ? v.comments.length : 0), 0);
    const approvedCategories = categories.filter(c => c.status !== 'pending').length;

    res.json({
      totalUsers: users.length,
      totalVideos: videos.length,
      approvedVideos: videos.filter(v => v.status === 'approved').length,
      pendingVideos: videos.filter(v => v.status === 'pending').length,
      totalCategories: categories.length,
      approvedCategories,
      pendingCategories,
      totalViews,
      totalLikes,
      totalVips,
      pendingReports,
      totalReports,
      totalMessages,
      unreadMessages,
      totalComments,
      logs: db.logs || []
    });
  } catch (err) {
    console.error('Error fetching admin stats:', err);
    res.status(500).json({ error: 'Erreur lors du calcul des statistiques administratives.' });
  }
});


// ---------------- ADMIN EMAIL TEST & PREVIEW SUITE ----------------
app.get('/api/admin/email-templates', requireAdmin, (req, res) => {
  const templates = [
    {
      key: 'welcome',
      title: 'Bienvenue & Inscription',
      description: 'Envoyé automatiquement à chaque nouvel utilisateur dès la création de son compte.',
      subject: 'Bienvenue sur Rêve de Q - Votre compte a été créé avec succès'
    },
    {
      key: 'reset_pwd',
      title: 'Mot de passe oublié (Code 6 chiffres)',
      description: 'Envoyé lorsqu\'un utilisateur demande la réinitialisation de son mot de passe.',
      subject: 'Réinitialisation de votre mot de passe Rêve de Q'
    },
    {
      key: 'video_approved',
      title: 'Vidéo validée & publiée',
      description: 'Notification au créateur confirmant que sa vidéo a été approuvée par la modération.',
      subject: 'Votre vidéo a été validée et publiée sur Rêve de Q'
    },
    {
      key: 'video_rejected',
      title: 'Vidéo refusée (motif modération)',
      description: 'Notification au créateur expliquant le motif de rejet de sa vidéo.',
      subject: 'Notification de modération - Votre vidéo sur Rêve de Q'
    },
    {
      key: 'vip_activated',
      title: 'Abonnement VIP activé (9,99€)',
      description: 'Confirmation officielle de l\'activation du Pass VIP après paiement.',
      subject: 'Confirmation d\'adhésion - Votre Pass VIP Rêve de Q est actif'
    },
    {
      key: 'account_deleted',
      title: 'Suppression définitive de compte (RGPD)',
      description: 'Confirmation officielle de suppression de compte et de l\'ensemble des données.',
      subject: 'Confirmation de suppression définitive de votre compte - Rêve de Q'
    },
    {
      key: 'new_message',
      title: 'Nouveau message privé reçu',
      description: 'Notification par e-mail lors de la réception d\'un message dans la boîte privée.',
      subject: 'Nouveau message privé reçu sur Rêve de Q'
    },
    {
      key: 'report_received',
      title: 'Signalement pris en compte (Takedown)',
      description: 'Accusé de réception officiel suite à un signalement de contenu par un utilisateur.',
      subject: 'Prise en charge de votre signalement Rêve de Q'
    },
    {
      key: 'contact_reply',
      title: 'Réponse officielle du Support',
      description: 'Réponse administrative directe avec mise en page Rêve de Q et citation.',
      subject: 'Réponse de Rêve de Q Support'
    },
    {
      key: 'custom_announcement',
      title: 'Annonce officielle / Message personnalisé',
      description: 'Communication officielle avec objet, contenu et bouton d\'action libres.',
      subject: 'Communication officielle - Rêve de Q'
    }
  ];

  res.json({ templates });
});

// Endpoint: Live preview of an email template
app.post('/api/admin/email-preview', requireAdmin, (req, res) => {
  const {
    templateKey = 'welcome',
    toEmail = 'ia.project.pro2k26@gmail.com',
    username,
    customSubject,
    customMessage,
    heading,
    videoTitle = 'Vortex Électronique (Exemple)',
    videoCategory = 'Electronique',
    reason = 'Qualité audio insuffisante ou doublon dans la thématique.',
    callToActionText = 'Découvrir les nouveautés',
    callToActionUrl
  } = req.body;

  try {
    const db = loadDb();
    const existingUser = (db.users || []).find(u => u.email && u.email.toLowerCase() === (toEmail || '').trim().toLowerCase());
    const finalUsername = (username && username.trim() && username !== 'Alexandre' && username !== 'Membre')
      ? username.trim()
      : (existingUser ? existingUser.username : (req.user?.username || 'Membre'));

    const template = generateEmailTemplate(templateKey, {
      username: finalUsername,
      toEmail: toEmail || 'contact@revedeq.fr',
      subject: customSubject,
      customMessage: customMessage,
      heading: heading,
      videoTitle: videoTitle,
      videoCategory: videoCategory,
      reason: reason,
      senderName: 'Rêve de Q Support',
      messagePreview: customMessage || 'Bonjour, voici un aperçu de message officiel.',
      replyText: customMessage || 'Bonjour, nous faisons suite à votre demande.',
      originalMessage: 'Ceci est un exemple de message reçu de la part du visiteur.',
      code: '849201',
      reportId: 'SIG-48201',
      reportReason: 'Demande de vérification',
      callToActionText: callToActionText,
      callToActionUrl: callToActionUrl
    });

    res.json({
      success: true,
      resolvedUsername: finalUsername,
      template: {
        key: templateKey,
        name: template.name,
        subject: customSubject || template.subject,
        html: template.html,
        text: template.text
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la génération de l\'aperçu.' });
  }
});

// Endpoint: Send a single custom or suggested email from support@revedeq.fr
app.post('/api/admin/send-single-email', requireAdmin, async (req, res) => {
  const {
    templateKey = 'welcome',
    toEmail,
    username,
    customSubject,
    customMessage,
    heading,
    videoTitle,
    videoCategory,
    reason,
    callToActionText,
    callToActionUrl
  } = req.body;

  if (!toEmail || !toEmail.trim() || !toEmail.includes('@')) {
    return res.status(400).json({ error: 'Veuillez saisir une adresse e-mail de destination valide.' });
  }

  try {
    const db = loadDb();
    const existingUser = (db.users || []).find(u => u.email && u.email.toLowerCase() === toEmail.trim().toLowerCase());
    const finalUsername = (username && username.trim() && username !== 'Alexandre' && username !== 'Membre')
      ? username.trim()
      : (existingUser ? existingUser.username : (req.user?.username || 'Membre'));

    const template = generateEmailTemplate(templateKey, {
      username: finalUsername,
      toEmail: toEmail.trim(),
      subject: customSubject ? customSubject.trim() : undefined,
      customMessage: customMessage,
      heading: heading,
      videoTitle: videoTitle || 'Vortex Électronique (Exemple)',
      videoCategory: videoCategory || 'Général',
      reason: reason || 'Non-respect des critères de qualité.',
      senderName: 'Rêve de Q Support',
      messagePreview: customMessage,
      replyText: customMessage,
      originalMessage: 'Demande soumise à l\'administration.',
      code: Math.floor(100000 + Math.random() * 900000).toString(),
      reportId: 'SIG-' + Math.floor(10000 + Math.random() * 90000),
      reportReason: reason || 'Vérification administrative',
      callToActionText: callToActionText,
      callToActionUrl: callToActionUrl
    });

    const finalSubject = (customSubject && customSubject.trim()) ? customSubject.trim() : template.subject;

    const sent = await sendRobustEmail({
      to: toEmail.trim(),
      subject: finalSubject,
      html: template.html,
      text: template.text,
      category: 'ADMIN_DIRECT'
    });

    if (!sent) {
      return res.status(500).json({ error: 'Échec de l\'expédition SMTP de l\'e-mail.' });
    }

    addLog('Envoi E-mail Admin', `Modèle "${template.name}" expédié à ${toEmail.trim()} par ${req.user.username}`);

    res.json({
      success: true,
      message: `L'e-mail officiel "${template.name}" a été expédié avec succès à ${toEmail.trim()} !`
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur technique lors de l\'envoi de l\'e-mail.' });
  }
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
  const siteUrl = SITE_URL;

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
              name: 'Abonnement VIP RDQ Service (9,99€ / mois)',
              description: 'Accès illimité au catalogue VIP exclusif, badge certifié, suppression des pubs et priorité',
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
        username: user.username,
        utm_source: String(req.body.attribution?.utm_source || '').slice(0, 50),
        utm_campaign: String(req.body.attribution?.utm_campaign || '').slice(0, 50),
        clickid: String(req.body.attribution?.clickid || '').slice(0, 50)
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
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true
}));

function escapeHtmlServer(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Dynamic Server-Side SEO & Open Graph Injection
function renderSeoPage(req, res) {
  const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
  try {
    let html = fs.readFileSync(indexHtmlPath, 'utf8');
    const siteUrl = SITE_URL;
    const db = loadDb();

    let title = 'Rêve de Q - Vidéos Adultes Streaming HD/4K (18+)';
    let description = 'Rêve de Q : Première plateforme française de streaming vidéo pour adultes (18+). Vidéos exclusives, amateur français, créateurs certifiés en HD et 4K.';
    let canonical = `${siteUrl}${req.path === '/' ? '' : req.path}`;
    let ogImage = `${siteUrl}/revedeq-banner.png`;
    let extraSchema = '';

    // 1. Video detection (/video/:id or /?video=:id)
    let videoId = null;
    if (req.path.startsWith('/video/')) {
      videoId = req.path.split('/')[2];
    } else if (req.query && req.query.video) {
      videoId = req.query.video;
    }

    if (videoId) {
      const video = (db.videos || []).find(v => v.id === videoId);
      if (video) {
        title = `${video.title || 'Vidéo Adulte'} - Vidéo Adulte HD/4K | Rêve de Q`;
        description = (video.description || `Regardez la vidéo adulte "${video.title}" en streaming haute définition sur Rêve de Q.`).substring(0, 160);
        canonical = `${siteUrl}/video/${encodeURIComponent(video.id)}`;
        ogImage = video.thumbnail || ogImage;

        const videoSchema = {
          '@context': 'https://schema.org',
          '@type': 'VideoObject',
          'name': video.title || 'Vidéo Adulte Rêve de Q',
          'description': video.description || description,
          'thumbnailUrl': [ogImage],
          'uploadDate': video.createdAt || new Date().toISOString(),
          'contentUrl': video.videoUrl || canonical,
          'embedUrl': `${siteUrl}/?video=${encodeURIComponent(video.id)}`,
          'isFamilyFriendly': false,
          'author': {
            '@type': 'Person',
            'name': video.authorName || 'Créateur Rêve de Q'
          }
        };
        extraSchema = `<script type="application/ld+json">${JSON.stringify(videoSchema)}</script>`;
      }
    } else if (req.path.startsWith('/profil/')) {
      const username = decodeURIComponent(req.path.split('/')[2] || '');
      const user = (db.users || []).find(u => u.username && u.username.toLowerCase() === username.toLowerCase());
      if (user) {
        title = `Profil de ${user.username} - Vidéos & Créateur Adulte | Rêve de Q`;
        description = `Découvrez les publications et vidéos adultes exclusives de ${user.username} sur la plateforme Rêve de Q.`;
        canonical = `${siteUrl}/profil/${encodeURIComponent(user.username)}`;
        ogImage = user.avatar || `${siteUrl}/revedeq-logo.png`;
        const profileSchema = {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          'mainEntity': {
            '@type': 'Person',
            'name': user.username,
            'image': ogImage
          }
        };
        extraSchema = `<script type="application/ld+json">${JSON.stringify(profileSchema)}</script>`;
      }
    } else if (req.path.startsWith('/categorie/') || req.path.startsWith('/categories/')) {
      const slug = decodeURIComponent(req.path.split('/')[2] || '');
      const cleanSlug = slug.toLowerCase().replace(/_/g, '-');
      const cat = (db.categories || []).find(c =>
        c.id && (c.id.toLowerCase() === cleanSlug || c.id.toLowerCase().replace(/_/g, '-') === cleanSlug)
      );
      if (cat) {
        title = `Vidéos ${cat.name} - Streaming Adulte Gratuit HD/4K (18+) | Rêve de Q`;
        description = `Découvrez notre sélection exclusive de vidéos adultes dans la catégorie "${cat.name}". Streaming 100% anonyme en haute définition et 4K sur Rêve de Q.`;
        canonical = `${siteUrl}/categorie/${encodeURIComponent(cleanSlug)}`;
        const catSchema = {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          'name': `Vidéos ${cat.name}`,
          'description': description,
          'url': canonical
        };
        extraSchema = `<script type="application/ld+json">${JSON.stringify(catSchema)}</script>`;
      }
    } else if (req.path === '/vip' || req.path === '/abonnement') {
      title = 'Abonnement Club VIP Privé - Streaming 4K & Zéro Pub | Rêve de Q';
      description = 'Rejoignez le Club VIP Rêve de Q (9,99€ / mois) : accès illimité aux vidéos exclusives, streaming 4K Ultra HD, messagerie illimitée et facturation 100% discrète.';
      canonical = `${siteUrl}/vip`;
    } else if (req.path === '/upload' || req.path === '/deposer') {
      title = 'Déposer une Vidéo Adulte - Partage Gratuit & Anonyme (18+) | Rêve de Q';
      description = 'Partagez votre vidéo adulte gratuitement et en toute discrétion sur Rêve de Q. Mise en ligne rapide sans inscription obligatoire.';
      canonical = `${siteUrl}/upload`;
    } else if (req.path === '/categories' || req.path === '/explorer') {
      title = 'Toutes les Catégories de Vidéos Adultes HD & 4K | Rêve de Q';
      description = 'Explorez l\'ensemble des catégories de vidéos pour adultes sur Rêve de Q : amateur français, levrette, gros cul, cougar, beurette, solo et duo.';
      canonical = `${siteUrl}/categories`;
    } else if (req.path.startsWith('/messages')) {
      title = 'Messagerie Privée & Tchat Entre Membres | Rêve de Q';
      description = 'Discutez en toute discrétion avec les membres et créateurs sur la messagerie privée sécurisée de Rêve de Q.';
      canonical = `${siteUrl}/messages`;
    } else if (req.path === '/profil' || req.path === '/compte' || req.path === '/connexion') {
      title = 'Mon Profil & Espace Membre | Rêve de Q';
      description = 'Gérez votre compte Rêve de Q, retrouvez vos vidéos favorites, vos publications et vos paramètres de confidentialité.';
      canonical = `${siteUrl}/profil`;
    } else if (req.path === '/faq') {
      title = 'Foire Aux Questions (FAQ) | Rêve de Q';
      description = 'Toutes les réponses à vos questions : comment regarder, déposer une vidéo, s\'abonner au Club VIP et protéger votre anonymat sur Rêve de Q.';
      canonical = `${siteUrl}/faq`;
    }

    html = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtmlServer(title)}</title>`);
    html = html.replace(/<meta name="description" content=".*?"\s*\/?>/i, `<meta name="description" content="${escapeHtmlServer(description)}">`);
    html = html.replace(/<link rel="canonical" href=".*?"\s*\/?>/i, `<link rel="canonical" href="${canonical}">`);
    html = html.replace(/<meta property="og:title" content=".*?"\s*\/?>/i, `<meta property="og:title" content="${escapeHtmlServer(title)}">`);
    html = html.replace(/<meta property="og:description" content=".*?"\s*\/?>/i, `<meta property="og:description" content="${escapeHtmlServer(description)}">`);
    html = html.replace(/<meta property="og:url" content=".*?"\s*\/?>/i, `<meta property="og:url" content="${canonical}">`);
    html = html.replace(/<meta property="og:image" content=".*?"\s*\/?>/i, `<meta property="og:image" content="${ogImage}">`);
    html = html.replace(/<meta name="twitter:title" content=".*?"\s*\/?>/i, `<meta name="twitter:title" content="${escapeHtmlServer(title)}">`);
    html = html.replace(/<meta name="twitter:description" content=".*?"\s*\/?>/i, `<meta name="twitter:description" content="${escapeHtmlServer(description)}">`);
    html = html.replace(/<meta name="twitter:image" content=".*?"\s*\/?>/i, `<meta name="twitter:image" content="${ogImage}">`);

    if (extraSchema) {
      html = html.replace('</head>', `${extraSchema}\n</head>`);
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache, must-revalidate');
    return res.send(html);
  } catch (err) {
    return res.sendFile(indexHtmlPath);
  }
}

// Auto-generated Google Video XML Sitemap for Adult SEO
app.get('/sitemap.xml', async (req, res) => {
  const db = loadDb();
  const siteUrl = SITE_URL;
  const today = new Date().toISOString().split('T')[0];

  const staticUrls = [
    { loc: siteUrl, priority: '1.0', changefreq: 'daily' },
    { loc: `${siteUrl}/categories`, priority: '0.9', changefreq: 'daily' },
    { loc: `${siteUrl}/vip`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${siteUrl}/upload`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${siteUrl}/faq`, priority: '0.6', changefreq: 'monthly' },
    { loc: `${siteUrl}/contact`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${siteUrl}/mentions-legales`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${siteUrl}/cgu`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${siteUrl}/confidentialite`, priority: '0.5', changefreq: 'monthly' },
    { loc: `${siteUrl}/protection-mineurs`, priority: '0.6', changefreq: 'monthly' },
  ];

  const categoryUrls = (db.categories || []).filter(c => !c.isSystem).map(c => ({
    loc: `${siteUrl}/categorie/${encodeURIComponent((c.id || '').toLowerCase().replace(/_/g, '-'))}`,
    priority: '0.8',
    changefreq: 'daily'
  }));

  const videoEntries = (db.videos || []).filter(v => v.status !== 'pending').slice(0, 500).map(v => {
    const pubDate = v.createdAt ? v.createdAt.split('T')[0] : today;
    
    // Ensure absolute thumbnail URL
    let fullThumb = v.thumbnail || `${siteUrl}/revedeq-banner.png`;
    if (!fullThumb.startsWith('http://') && !fullThumb.startsWith('https://')) {
      fullThumb = `${siteUrl}${fullThumb.startsWith('/') ? '' : '/'}${fullThumb}`;
    }
    fullThumb = escapeHtmlServer(fullThumb);

    const cleanTitle = escapeHtmlServer(v.title || 'Vidéo Adulte Rêve de Q');
    const cleanDesc = escapeHtmlServer((v.description || v.title || 'Vidéo adulte streaming HD sur Rêve de Q.').substring(0, 1000));
    const playerUrl = `${siteUrl}/video/${encodeURIComponent(v.id)}`;

    // Parse duration in seconds if available
    let durationTag = '';
    if (v.duration && typeof v.duration === 'string') {
      const parts = v.duration.trim().split(':').map(n => parseInt(n, 10));
      let sec = 0;
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        sec = parts[0] * 60 + parts[1];
      } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
      if (sec > 0 && sec < 28800) {
        durationTag = `\n      <video:duration>${sec}</video:duration>`;
      }
    }

    return `  <url>
    <loc>${playerUrl}</loc>
    <lastmod>${pubDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <video:video>
      <video:thumbnail_loc>${fullThumb}</video:thumbnail_loc>
      <video:title>${cleanTitle}</video:title>
      <video:description>${cleanDesc}</video:description>
      <video:player_loc>${playerUrl}</video:player_loc>${durationTag}
      <video:publication_date>${pubDate}</video:publication_date>
      <video:family_friendly>no</video:family_friendly>
    </video:video>
  </url>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${staticUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
${categoryUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
${videoEntries.join('\n')}
</urlset>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(xml);
});

// Direct Clean URLs with Dynamic Server-Side SEO & Meta Pre-rendering
app.get([
  '/',
  '/upload',
  '/deposer',
  '/categories',
  '/explorer',
  '/vip',
  '/abonnement',
  '/messages',
  '/messages/:username',
  '/profil',
  '/compte',
  '/connexion',
  '/profil/:username',
  '/faq',
  '/admin',
  '/video/:id',
  '/categorie/:slug',
  '/categories/:slug',
  '/contact',
  '/mentions-legales',
  '/cgu',
  '/confidentialite',
  '/reclamations',
  '/signaler',
  '/protection-mineurs',
  '/proposer-categorie'
], renderSeoPage);

// SPA Fallback with SEO Pre-rendering
app.use(renderSeoPage);


if (process.env.NODE_ENV !== 'production' || require.main === module) {
  app.listen(PORT, () => {
    console.log(` Serveur démarré avec succès sur http://localhost:${PORT}`);
  });
}

module.exports = app;
