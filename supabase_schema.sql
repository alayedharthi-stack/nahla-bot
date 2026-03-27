-- 🐝 نحلة 2.0 — قاعدة البيانات
-- شغّل هذا في Supabase SQL Editor

CREATE TABLE customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100),
  first_contact TIMESTAMPTZ DEFAULT NOW(),
  last_contact TIMESTAMPTZ DEFAULT NOW(),
  win_back_sent BOOLEAN DEFAULT false
);

CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  role VARCHAR(10) NOT NULL, -- 'user' or 'bot'
  message TEXT,
  intent VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE coupons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(20),
  code VARCHAR(25) UNIQUE NOT NULL,
  discount_percent INT,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- توكنات سلة — سطر واحد دائماً (id = 1)
CREATE TABLE salla_tokens (
  id INT PRIMARY KEY DEFAULT 1,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,    -- Unix timestamp بالميلي ثانية
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- فهارس للسرعة
CREATE INDEX ON conversations(phone);
CREATE INDEX ON conversations(created_at DESC);
CREATE INDEX ON customers(last_contact);
