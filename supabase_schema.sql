-- ==========================================================
-- VIDEOHUB - SUPABASE DATABASE & STORAGE SCHEMA
-- ==========================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABLE UTILISATEURS (USERS)
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY DEFAULT 'user_' || replace(uuid_generate_v4()::text, '-', ''),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user', -- 'admin' ou 'user'
  is_vip BOOLEAN DEFAULT false,
  vip_expiry TEXT,
  avatar TEXT DEFAULT 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
  bio TEXT DEFAULT 'Membre de VideoHub',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insérer le compte Administrateur par défaut
INSERT INTO public.users (id, username, email, password_hash, role, is_vip, vip_expiry, bio)
VALUES (
  'user_admin_main',
  'Administrateur',
  'ia.project.pro2k26@gmail.com',
  '\/6IFSOUNWevSlxNeL66GiWEyu1.x1/6QhUzz803lsSZrac.', -- Mot de passe : admin123
  'admin',
  true,
  '2030-01-01',
  'Administrateur principal de la plateforme'
)
ON CONFLICT (email) DO NOTHING;

-- 3. TABLE CATEGORIES
CREATE TABLE IF NOT EXISTS public.categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_system BOOLEAN DEFAULT false,
  created_by TEXT DEFAULT 'Administrateur',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. TABLE VIDEOS
CREATE TABLE IF NOT EXISTS public.videos (
  id TEXT PRIMARY KEY DEFAULT 'vid_' || replace(uuid_generate_v4()::text, '-', ''),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  video_url TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  duration TEXT DEFAULT '00:00',
  uploader_email TEXT,
  author_name TEXT DEFAULT 'Anonyme',
  is_vip_author BOOLEAN DEFAULT false,
  is_vip_exclusive BOOLEAN DEFAULT false,
  is_daily_featured BOOLEAN DEFAULT false,
  categories JSONB DEFAULT '["Amateur"]'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'pending', -- 'approved', 'pending', 'rejected'
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  rating NUMERIC(3,1) DEFAULT 5.0,
  rating_count INTEGER DEFAULT 1,
  rating_sum NUMERIC(10,1) DEFAULT 5.0,
  region TEXT DEFAULT 'France',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. TABLE COMMENTAIRES (COMMENTS)
CREATE TABLE IF NOT EXISTS public.comments (
  id TEXT PRIMARY KEY DEFAULT 'comm_' || replace(uuid_generate_v4()::text, '-', ''),
  video_id TEXT NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  author_id TEXT,
  author_name TEXT NOT NULL,
  author_avatar TEXT,
  is_vip BOOLEAN DEFAULT false,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. TABLE CONVERSATIONS & MESSAGES
CREATE TABLE IF NOT EXISTS public.conversations (
  id TEXT PRIMARY KEY DEFAULT 'conv_' || replace(uuid_generate_v4()::text, '-', ''),
  participant1_id TEXT NOT NULL,
  participant1_username TEXT NOT NULL,
  participant2_id TEXT NOT NULL,
  participant2_username TEXT NOT NULL,
  last_message TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id TEXT PRIMARY KEY DEFAULT 'msg_' || replace(uuid_generate_v4()::text, '-', ''),
  conversation_id TEXT NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  text TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. TABLE SIGNALEMENTS (REPORTS)
CREATE TABLE IF NOT EXISTS public.reports (
  id TEXT PRIMARY KEY DEFAULT 'rep_' || replace(uuid_generate_v4()::text, '-', ''),
  video_id TEXT,
  video_title TEXT,
  video_url TEXT,
  motif TEXT NOT NULL,
  reporter_name TEXT NOT NULL,
  reporter_email TEXT NOT NULL,
  description TEXT,
  proof_url TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'resolved', 'dismissed'
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. TABLE AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY DEFAULT 'log_' || replace(uuid_generate_v4()::text, '-', ''),
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  author TEXT DEFAULT 'Système',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 9. CRÉATION DES BUCKETS DE STOCKAGE PUBLICS (STORAGE)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('videos', 'videos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public) 
VALUES ('thumbnails', 'thumbnails', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- POLITIQUES D'ACCÈS PUBLICS EN LECTURE ET ÉCRITURE
CREATE POLICY "Allow public read on videos" ON storage.objects FOR SELECT USING (bucket_id = 'videos');
CREATE POLICY "Allow public insert on videos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'videos');

CREATE POLICY "Allow public read on thumbnails" ON storage.objects FOR SELECT USING (bucket_id = 'thumbnails');
CREATE POLICY "Allow public insert on thumbnails" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'thumbnails');
