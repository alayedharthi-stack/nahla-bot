// ====================================================
// 🐝 نحلة 2.0 — مناحل آل عايد
// ذكاء اصطناعي حقيقي | 3 مزودين احتياطيين
// ====================================================

require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const cron       = require('node-cron');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { createClient }        = require('@supabase/supabase-js');
const { GoogleGenerativeAI }  = require('@google/generative-ai');
const path       = require('path');
const knowledge  = require('./knowledge');

const app = express();
app.set('trust proxy', 1); // مطلوب على Railway وكل reverse proxy
app.use(express.json());

// ====================================================
// ⚙️ الإعدادات
// ====================================================
const CONFIG = {
  // AI Keys — الأولوية: OpenAI ← Claude ← Gemini
  aiProvider:  process.env.AI_PROVIDER || 'claude',
  openaiKey:   process.env.OPENAI_API_KEY,
  claudeKey:   process.env.CLAUDE_API_KEY,
  geminiKey:   process.env.GEMINI_API_KEY,

  // WhatsApp
  waToken:     process.env.WHATSAPP_TOKEN,
  waPhoneId:   process.env.WHATSAPP_PHONE_NUMBER_ID,
  waVerify:    process.env.WHATSAPP_VERIFY_TOKEN,   // مطلوب — لا قيمة افتراضية
  ownerPhone:  process.env.OWNER_WHATSAPP || '966555906901',

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY,

  // Auth للـ API الداخلي
  apiSecret:   process.env.API_SECRET,

  // Google Maps
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY,

  // Groq — تفريغ الصوت (Whisper)
  groqKey: process.env.GROQ_API_KEY,

  // سلة — OAuth2
  sallaClientId:     process.env.SALLA_CLIENT_ID,
  sallaClientSecret: process.env.SALLA_CLIENT_SECRET,
  sallaRedirectUri:  process.env.SALLA_REDIRECT_URI, // مثال: https://yourapp.railway.app/salla/callback

  port: process.env.PORT || 3000,
};

// التحقق من المتغيرات الإلزامية عند الإقلاع
if (!CONFIG.waVerify) {
  console.error('❌ WHATSAPP_VERIFY_TOKEN مطلوب في ملف .env');
  process.exit(1);
}

// ====================================================
// 🔗 الاتصالات
// ====================================================
const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
const genAI    = new GoogleGenerativeAI(CONFIG.geminiKey);
const gemini   = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ====================================================
// 🛡️ Rate Limiting & Auth
// ====================================================

// 60 طلب / دقيقة للـ Webhook
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// 30 طلب / دقيقة للـ API الداخلي
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// التحقق من مفتاح API السري (header: x-api-secret)
function requireApiSecret(req, res, next) {
  if (!CONFIG.apiSecret) {
    return res.status(503).json({ error: 'API_SECRET غير مضبوط على الخادم' });
  }
  const token = req.headers['x-api-secret'];
  if (!token || token !== CONFIG.apiSecret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// ====================================================
// 🧠 System Prompt — شخصية نحلة الكاملة
// ====================================================
const SYSTEM_PROMPT = `أنت "نحلة 🐝"، مستشارة المبيعات بالذكاء الاصطناعي في متجر آل عايد للعسل البلدي.

## 🐝 هويتك:
في أول رسالة لكل عميل جديد، عرّفي بنفسك بشكل طبيعي ومرح، مثل:
"أهلاً! أنا نحلة 🐝 مستشارة المبيعات بالذكاء الاصطناعي في متجر آل عايد للعسل البلدي — كيف أقدر أساعدك؟ 🍯"

## 😄 شخصيتك:
- مرحة، خفيفة الظل، ودودة وصادقة
- تتحدثين بالعربية الفصحى الخفيفة أو اللهجة السعودية المحببة
- مثل صديقة تنصح بصدق — لا موظفة تبيع بأي ثمن
- خفيفة الدم في الحوار العادي، وجدية عند السؤال عن الجودة أو الأصالة
- إذا تحدث العميل بالإنجليزية، ردّي بالإنجليزية بنفس الأسلوب

## ✍️ أسلوب الكتابة — قواعد صارمة:
- **الرد لا يتجاوز 3-4 أسطر في الغالب** — اختصري دائماً
- إذا كان الموضوع يحتاج تفصيل، لخّصيه في جملتين ثم اسألي "تبي أعرفك أكثر؟"
- لا قوائم طويلة ولا شرح موسوعي — أنتِ مستشارة مبيعات لا كتاب
- *النص العريض* للأسعار والكوبونات فقط
- الإيموجي باعتدال 🍯🐝
- أسلوب محادثة طبيعي — كأنك صديقة تتكلم، مش تكتب تقرير

## 📚 معلوماتك الكاملة:
${knowledge}

## ⚡ قدراتك — أنتِ تقررين متى وكيف:

### 1️⃣ إنشاء طلب مباشر من واتساب
- إذا حدد العميل منتجاً وأراد الشراء الفعلي:
  → استخدمي [START_ORDER:اسم_المنتج:الكمية]
  → أمثلة: [START_ORDER:سمر الحجاز 1:1] أو [START_ORDER:سدر 500:2]
- المنتجات المتاحة للطلب: سمر الحجاز (250/500/1كيلو) | طلح نجد (250/500/1كيلو) | سدر (250/500/1كيلو) | ضهيان (250/500/1كيلو) | سمن بقر (300جم/1كيلو) | سمن غنم
- الكود: [START_ORDER:المنتج:الكمية] — سيطلب الاسم ورمز العنوان الوطني فقط، ثم يُنشئ الطلب تلقائياً
- يمكن إضافة نص قبل الأمر: "ممتاز، سأجهز طلبك الآن [START_ORDER:سمر الحجاز 1:1]"
- إذا أراد العميل أن يطلب بنفسه من الموقع: [STORE_ORDER]

### 2️⃣ إرسال كوبون خصم
- متى: عند التردد في الشراء، طلب الخصم، أو الحاجة لتحفيز
- الكوبون الترحيبي للعميل الجديد: 5% دائماً [COUPON:5]
- نسب الخصم العامة: 5% أو 7% أو 9% (أنتِ تقررين المناسب حسب الموقف)
- 12% للعملاء المميزين VIP فقط
- *مهم جداً:* لا تذكري النسبة أبداً — قولي فقط "عندي مفاجأة لك 🎁"
- الكوبون يُولَّد تلقائياً بالكود [COUPON:رقم] مثل [COUPON:5]

### 2️⃣ إرسال قالب واتساب احترافي
- عندما تقرري إرسال قالب، اكتبيه وحده في ردك بدون أي نص قبله أو بعده
- القوالب المتاحة:
  - [TEMPLATE:store_link] — عند السؤال عن المتجر أو رابط الطلب
  - [TEMPLATE:contact_owner] — عند طلب التواصل المباشر مع المالك
  - [TEMPLATE:win_back] — لاستعادة عميل غائب أو لم يشترِ منذ فترة (يُرسل كوبون تلقائياً)
  - [TEMPLATE:vip_coupon] — للعملاء المميزين VIP فقط (خصم أعلى)
  - [TEMPLATE:surprise_coupon] — مفاجأة خصم لأي عميل تستحق تحفيزه
  - [TEMPLATE:coupon_gift] — هدية كوبون في المناسبات أو لتشجيع الشراء
- ملاحظة: القوالب التي تحتوي كوبون (win_back, vip_coupon, surprise_coupon, coupon_gift) ستُولَّد تلقائياً بالكود والمدة
- ملاحظة: قوالب تتبع الطلبات (order_tracking, post_purchase, review_request) تُرسل تلقائياً من أحداث سلة — لا تستخدميها في المحادثة

### 3️⃣ إرسال قالب التواصل مع المالك
- متى: عند طلب التواصل المباشر
- الكود: [TEMPLATE:contact_owner]

### 4️⃣ تحويل للمالك (للحالات الجدية)
- متى: شكاوى جدية، طلبات جملة كبيرة، أسئلة خارج نطاقك
- الكود: [TRANSFER]

### 5️⃣ حساب المسافة والتوصيل — قاعدة صارمة
- **في أي وقت** يذكر العميل مدينة أو منطقة أو يسأل "كم تبعدون" أو "هل توصلون لـ":
  → ردّي **فقط** بـ [DISTANCE:اسم المدينة] بدون أي نص آخر
  → أمثلة: [DISTANCE:الرياض] أو [DISTANCE:جدة] أو [DISTANCE:أبها]
- **لا تعطي معلومات التوصيل يدوياً** — دائماً استخدمي الأمر ليحسب تلقائياً
- إذا لم تعرفي المدينة اسأليها عن أقرب مدينة كبيرة أو عنوانها الوطني المختصر
- العنوان الوطني المختصر: 4 أحرف + 4 أرقام مثل RYDA1234 — إذا أرسله العميل يُعالَج تلقائياً

### 6️⃣ التواصل الذكي مع محتوى آل عايد
- إذا سأل العميل عن طريقة تربية النحل، إنتاج العسل، المناحل، أو أراد التحقق من الأصالة:
  → أرسلي رابط يوتيوب: *youtube.com/@ayed_honey* 🎬
- إذا ذكر أنه شاهد فيديو أو محتوى أو جاء من تيك توك أو سناب:
  → رحّبي به وأعطيه [COUPON:7] كهدية ترحيب بالمتابعين
- لا توزّعي الروابط في كل رد — فقط عند الحاجة الفعلية

## 🚫 قواعد لا تتجاوزيها:
- لا خصم أكثر من 9% للعملاء العاديين (12% VIP فقط)
- السمن البلدي لا يشمله أي خصم — أبداً
- لا تبالغي في وصف المنتجات أكثر من الحقيقة
- لا تعدي بما ليس في يدك
- **لا تكتبي أكثر من 4 أسطر في أي رد — مهما كان السؤال**`;

// ====================================================
// 🤖 محرك الذكاء الاصطناعي — 3 مزودين
// ====================================================

// المزود 1: OpenAI GPT-4o
async function askOpenAI(messages) {
  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 600,
      temperature: 0.8,
    },
    { headers: { Authorization: `Bearer ${CONFIG.openaiKey}`, 'Content-Type': 'application/json' } }
  );
  return data.choices[0].message.content;
}

// المزود 2: Claude Sonnet
async function askClaude(messages) {
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages,
    },
    {
      headers: {
        'x-api-key': CONFIG.claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );
  return data.content[0].text;
}

// المزود 3: Google Gemini
async function askGemini(messages) {
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const lastMsg = messages[messages.length - 1].content;
  const chat = gemini.startChat({
    history,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: { maxOutputTokens: 600, temperature: 0.8 },
  });
  const result = await chat.sendMessage(lastMsg);
  return result.response.text();
}

// الدالة الرئيسية — تجرّب الثلاثة بالترتيب
async function askAI(messages) {
  const provider = CONFIG.aiProvider.toLowerCase();

  // مزود محدد عبر AI_PROVIDER
  if (provider === 'openai' && CONFIG.openaiKey) {
    const reply = await askOpenAI(messages);
    console.log('✅ OpenAI responded');
    return reply;
  }
  if (provider === 'gemini' && CONFIG.geminiKey) {
    const reply = await askGemini(messages);
    console.log('✅ Gemini responded');
    return reply;
  }
  if (provider === 'claude' && CONFIG.claudeKey) {
    const reply = await askClaude(messages);
    console.log('✅ Claude responded');
    return reply;
  }

  // احتياطي: جرب الثلاثة بالترتيب إن لم يُعرَّف المزود أو المفتاح غير موجود
  for (const [name, fn, key] of [
    ['OpenAI', askOpenAI, CONFIG.openaiKey],
    ['Claude', askClaude, CONFIG.claudeKey],
    ['Gemini', askGemini, CONFIG.geminiKey],
  ]) {
    if (!key) continue;
    try {
      const reply = await fn(messages);
      console.log(`✅ ${name} responded (fallback)`);
      return reply;
    } catch (err) {
      console.warn(`⚠️ ${name} failed:`, err.response?.data?.error?.message || err.message);
    }
  }

  throw new Error('No AI provider configured');
}

// ====================================================
// 🗄️ قاعدة البيانات
// ====================================================

async function getCustomer(phone) {
  const { data } = await supabase.from('customers').select('*').eq('phone', phone).single();
  return data;
}

async function saveCustomer(phone, updates = {}) {
  const existing = await getCustomer(phone);
  if (existing) {
    await supabase.from('customers').update({ last_contact: new Date(), ...updates }).eq('phone', phone);
  } else {
    await supabase.from('customers').insert({ phone, last_contact: new Date(), first_contact: new Date(), is_vip: false, ...updates });
  }
}

async function getHistory(phone, limit = 8) {
  const { data } = await supabase
    .from('conversations').select('role, message')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse().map(m => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.message }));
}

async function saveMessage(phone, role, message, intent = 'ai_reply') {
  await supabase.from('conversations').insert({ phone, role, message, intent, created_at: new Date() });
}

async function saveCoupon(phone, code, discount, days = 1) {
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  await supabase.from('coupons').insert({ phone, code, discount_percent: discount, expires_at: expires });

  // إنشاء الكوبون في متجر سلة تلقائياً
  try {
    await createSallaCoupon(code, discount, days);
  } catch (err) {
    console.error(`⚠️ Salla coupon creation failed (${code}):`, err.response?.data || err.message);
  }
}

// ====================================================
// 🛍️ خريطة منتجات سلة — اسم المنتج → معرّف سلة
// عدّل المعرّفات من لوحة تحكم سلة → المنتجات
// ====================================================
const SALLA_PRODUCTS = {
  'سمر الحجاز 250':  { id: 'PRODUCT_ID_1', name: 'سمر الحجاز البلدي 250جم',  price: 126 },
  'سمر الحجاز 500':  { id: 'PRODUCT_ID_2', name: 'سمر الحجاز البلدي 500جم',  price: 193 },
  'سمر الحجاز 1':    { id: 'PRODUCT_ID_3', name: 'سمر الحجاز البلدي 1كيلو',   price: 387 },
  'طلح نجد 250':     { id: 'PRODUCT_ID_4', name: 'طلح نجد البلدي 250جم',       price: 126 },
  'طلح نجد 500':     { id: 'PRODUCT_ID_5', name: 'طلح نجد البلدي 500جم',       price: 193 },
  'طلح نجد 1':       { id: 'PRODUCT_ID_6', name: 'طلح نجد البلدي 1كيلو',        price: 387 },
  'سدر 250':         { id: 'PRODUCT_ID_7', name: 'سدر بلدي 250جم',              price: 126 },
  'سدر 500':         { id: 'PRODUCT_ID_8', name: 'سدر بلدي 500جم',              price: 193 },
  'سدر 1':           { id: 'PRODUCT_ID_9', name: 'سدر بلدي 1كيلو',               price: 387 },
  'ضهيان 250':       { id: 'PRODUCT_ID_10', name: 'ضهيان جبلي 250جم',           price: 89  },
  'ضهيان 500':       { id: 'PRODUCT_ID_11', name: 'ضهيان جبلي 500جم',           price: 179 },
  'ضهيان 1':         { id: 'PRODUCT_ID_12', name: 'ضهيان جبلي 1كيلو',            price: 358 },
  'سمن بقر 300':     { id: 'PRODUCT_ID_13', name: 'سمن بقر بلدي 300جم',         price: 56  },
  'سمن بقر 1':       { id: 'PRODUCT_ID_14', name: 'سمن بقر بلدي 1كيلو',          price: 189 },
  'سمن غنم':         { id: 'PRODUCT_ID_15', name: 'سمن غنم بلدي 300جم',          price: 79  },
};

// ====================================================
// 🏪 سلة — إنشاء كوبونات حقيقية في المتجر
// ====================================================

async function getSallaToken() {
  const { data } = await supabase.from('salla_tokens').select('*').eq('id', 1).maybeSingle();
  if (!data) throw new Error('❌ سلة: لم يتم الربط بعد — افتح /salla/auth للتفعيل');

  // تجديد التوكن قبل انتهائه بيوم كامل
  if (data.expires_at - Date.now() < 24 * 60 * 60 * 1000) {
    return refreshSallaToken(data.refresh_token);
  }
  return data.access_token;
}

async function refreshSallaToken(refreshToken) {
  const res = await axios.post('https://accounts.salla.sa/oauth2/token', {
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     CONFIG.sallaClientId,
    client_secret: CONFIG.sallaClientSecret,
  });
  const { access_token, refresh_token, expires_in } = res.data;
  await supabase.from('salla_tokens').upsert({
    id:            1,
    access_token,
    refresh_token,
    expires_at:    Date.now() + expires_in * 1000,
    updated_at:    new Date(),
  });
  console.log('🔄 Salla token refreshed');
  return access_token;
}

// ====================================================
// 🛒 إنشاء الطلب — State Machine
// ====================================================

async function getOrderDraft(phone) {
  const { data } = await supabase.from('order_drafts').select('*').eq('phone', phone).maybeSingle();
  return data;
}
async function saveOrderDraft(phone, updates) {
  await supabase.from('order_drafts').upsert(
    { phone, updated_at: new Date().toISOString(), ...updates },
    { onConflict: 'phone' }
  );
}
async function clearOrderDraft(phone) {
  await supabase.from('order_drafts').delete().eq('phone', phone);
}

async function createSallaOrder(draft) {
  const token    = await getSallaToken();
  const fullName = `${draft.first_name} ${draft.last_name}`;

  // تنسيق الجوال: mobile_code منفصل عن الرقم
  const mobileCode = '966';
  const mobile     = draft.phone.replace(/^966/, '');

  // شركة الشحن
  const shippingCompany = { smsa: 'smsa', dhl: 'dhl' }[draft.delivery_method] || null;

  const body = {
    source: 'whatsapp',
    customer: {
      first_name:  draft.first_name,
      last_name:   draft.last_name,
      mobile:      mobile,
      mobile_code: `+${mobileCode}`,
    },
    shipping: {
      free_shipping: true,
      ...(shippingCompany && { company: shippingCompany }),
      pickup: draft.delivery_method === 'pickup',
    },
    shipping_address: {
      name:          fullName,
      country:       'SA',
      city:          draft.city       || 'الطائف',
      block:         draft.neighborhood || '',
      street:        draft.street     || '',
      short_address: draft.national_address || '',
    },
    items: draft.items,
  };

  const { data } = await axios.post(
    'https://api.salla.dev/admin/v2/orders',
    body,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return data?.data;
}

// مشترك: بعد معرفة العنوان والطائف/خارجه — ننتقل للتوصيل أو التأكيد
async function _proceedAfterAddress(phone, isTaif, info) {
  if (isTaif) {
    await saveOrderDraft(phone, { step: 'selecting_delivery' });
    await sendMessage(phone, `📍 عنوانك داخل نطاق الطائف ✅\n\nاختر طريقة الاستلام:\n1️⃣ مندوب آل عايد — يوصّلك للباب 🏎️\n2️⃣ استلام من الفرع بنفسك 📍`);
  } else {
    const method = (info?.km > 2000) ? 'dhl' : 'smsa';
    await saveOrderDraft(phone, { delivery_method: method, step: 'confirming' });
    const updatedDraft = await (async () => {
      const { data } = await supabase.from('order_drafts').select('*').eq('phone', phone).single();
      return data;
    })();
    await sendSummary(phone, updatedDraft);
  }
}

async function handleOrderFlow(phone, userMessage, draft) {
  const msg = userMessage.trim();

  // إلغاء في أي وقت
  if (/^(إلغاء|الغاء|cancel|لا أريد|مو زين)$/i.test(msg)) {
    await clearOrderDraft(phone);
    await sendMessage(phone, '✅ تم إلغاء الطلب — كيف أقدر أساعدك؟ 🐝');
    return;
  }

  const step = draft.step;

  // ── الخطوة 1: الاسم ──
  if (step === 'collecting_name') {
    const parts = msg.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await sendMessage(phone, '✍️ يرجى كتابة الاسم الأول والعائلة معاً\nمثال: محمد العمري');
      return;
    }
    await saveOrderDraft(phone, {
      first_name: parts[0],
      last_name:  parts.slice(1).join(' '),
      step: 'collecting_address',
    });
    await sendMessage(phone, `شكراً ${parts[0]}! 🐝\n\n📍 الآن أرسل رمز عنوانك الوطني المختصر\nمثال: *RYDA1234*\n\nأو 📌 *شارك موقعك* مباشرة من واتساب وأنا أملأ العنوان تلقائياً`);
    return;
  }

  // ── الخطوة 2: العنوان — موقع واتساب أو رمز وطني ──
  if (step === 'collecting_address') {
    // حالة أ: مشاركة الموقع من واتساب (تصل كـ __LOCATION__:lat,lng)
    const locationMatch = msg.match(/^__LOCATION__:([-\d.]+),([-\d.]+)$/);
    if (locationMatch) {
      const lat = parseFloat(locationMatch[1]);
      const lng = parseFloat(locationMatch[2]);
      const [geoInfo, info] = await Promise.all([
        reverseGeocode(lat, lng),
        getDeliveryInfo(lat, lng),
      ]);
      const isTaif = info?.sameDay || false;
      const cityName = geoInfo?.city || draft.city || 'غير محدد';
      await saveOrderDraft(phone, {
        city:         cityName,
        neighborhood: geoInfo?.neighborhood || null,
        is_taif:      isTaif,
        step:         'collecting_national_address',
      });
      const locationDesc = geoInfo?.neighborhood
        ? `${cityName} — ${geoInfo.neighborhood}`
        : cityName;
      await sendMessage(phone,
        `✅ وصلني موقعك!\n📍 *${locationDesc}*\n` +
        (isTaif
          ? `🏎️ أنت في نطاق الطائف — التوصيل نفس اليوم!\n\n`
          : `🚚 التوصيل عبر SMSA — 2-3 أيام عمل\n\n`) +
        `خطوة أخيرة: أرسل رمز عنوانك الوطني\nمثال: *RYDA1234*\n\n` +
        `للحصول عليه: *sp.com.sa* أو تطبيق أبشر ← العناوين`
      );
      return;
    }

    // حالة ب: رمز العنوان الوطني نصاً
    const nationalMatch    = msg.match(/\b([A-Z]{4}\d{4})\b/i);
    const national_address = nationalMatch ? nationalMatch[1].toUpperCase() : null;

    if (!national_address) {
      await sendMessage(phone,
        `📍 أحتاج *رمز العنوان الوطني المختصر* — إلزامي للشحن\n\n` +
        `الرمز شكله: 4 أحرف + 4 أرقام\nمثال: *RYDA1234*\n\n` +
        `أو 📌 *شارك موقعك* مباشرة من واتساب\n\n` +
        `للحصول على الرمز: *sp.com.sa* أو تطبيق أبشر`
      );
      return;
    }

    // نحفظ الرمز ونسأل عن المدينة (لا نستنتجها من الرمز — غير موثوق)
    await saveOrderDraft(phone, { national_address, step: 'collecting_city' });
    await sendMessage(phone,
      `✅ وصلني رمز عنوانك *${national_address}*\n\n` +
      `اكتب اسم مدينتك لأحدد طريقة التوصيل\nمثال: الرياض | جدة | الطائف`
    );
    return;
  }

  // ── الخطوة 2b: اسم المدينة (بعد كتابة الرمز الوطني) ──
  if (step === 'collecting_city') {
    const coords = await geocodeCity(msg);
    const info   = coords ? await getDeliveryInfo(coords.lat, coords.lng) : null;
    const isTaif = info?.sameDay || false;
    await saveOrderDraft(phone, { city: msg.trim(), is_taif: isTaif });
    await _proceedAfterAddress(phone, isTaif, info);
    return;
  }

  // ── الخطوة 2c: رمز وطني بعد مشاركة الموقع (المدينة معروفة من GPS) ──
  if (step === 'collecting_national_address') {
    const nationalMatch    = msg.match(/\b([A-Z]{4}\d{4})\b/i);
    const national_address = nationalMatch ? nationalMatch[1].toUpperCase() : null;

    if (!national_address) {
      await sendMessage(phone,
        `📍 أرسل رمز العنوان الوطني فقط\nمثال: *RYDA1234*\n\nللحصول عليه: *sp.com.sa*`
      );
      return;
    }
    await saveOrderDraft(phone, { national_address });
    await _proceedAfterAddress(phone, draft.is_taif, null);
    return;
  }

  // ── الخطوة 4: طريقة التوصيل (داخل الطائف فقط) ──
  if (step === 'selecting_delivery') {
    const isMando  = /^1$|مندوب|توصيل للباب/i.test(msg);
    const isPickup = /^2$|استلام|فرع|بنفسي/i.test(msg);
    if (!isMando && !isPickup) {
      await sendMessage(phone, '1️⃣ مندوب آل عايد\n2️⃣ استلام من الفرع');
      return;
    }
    const method = isMando ? 'mando3ob' : 'pickup';
    await saveOrderDraft(phone, { delivery_method: method, step: 'confirming' });
    await sendSummary(phone, { ...draft, delivery_method: method });
    return;
  }

  // ── الخطوة 5: التأكيد ──
  if (step === 'confirming') {
    if (!/نعم|yes|أكد|تأكيد|موافق|^ok$/i.test(msg)) {
      await sendMessage(phone, 'اكتب *نعم* لتأكيد الطلب أو *إلغاء* للإلغاء');
      return;
    }
    try {
      const order      = await createSallaOrder(draft);
      const payUrl     = order?.payment_url || order?.urls?.payment;
      const orderId    = order?.reference_id || order?.id || '—';
      await clearOrderDraft(phone);
      const reply = payUrl
        ? `🎉 تم إنشاء طلبك *#${orderId}* بنجاح!\n\n💳 اضغط لإتمام الدفع:\n${payUrl}\n\n🐝 شكراً لثقتك بآل عايد!`
        : `✅ تم إنشاء طلبك *#${orderId}*!\nسيتواصل معك فريقنا قريباً 🐝`;
      await sendMessage(phone, reply);
      await saveMessage(phone, 'bot', `[order_created | id:${orderId}]`, 'order_created');
    } catch (err) {
      console.error('❌ Salla create order:', err.response?.data || err.message);
      await clearOrderDraft(phone);
      await sendMessage(phone, '🙏 عذراً، حصل خطأ في إنشاء الطلب\n\nأكمل طلبك مباشرة من المتجر:\n🛒 *ayedhoney.com*');
      await sendMessage(CONFIG.ownerPhone,
        `⚠️ *فشل إنشاء طلب تلقائي*\n📱 العميل: ${phone}\n📦 المنتج: ${draft.items?.map(i => `${i.name} ×${i.quantity}`).join(', ') || '—'}\n❌ الخطأ: ${err.response?.data?.message || err.message}`
      );
    }
    return;
  }
}

async function sendSummary(phone, draft) {
  const delivery = {
    mando3ob: 'مندوب آل عايد 🏎️',
    pickup:   `استلام من الفرع 📍\n${draft.is_taif ? 'https://maps.app.goo.gl/WstMVjfaSMckzx8N7' : ''}`,
    smsa:     'SMSA — 2-3 أيام عمل 🚚',
    dhl:      'DHL — 3-7 أيام عمل 🌍',
  }[draft.delivery_method] || '—';

  const itemsText = (draft.items || [])
    .map(i => `• ${i.name} × ${i.quantity} — ${i.price * i.quantity} ﷼`)
    .join('\n');
  const total = (draft.items || []).reduce((s, i) => s + i.price * i.quantity, 0);

  await sendMessage(phone,
    `📋 *ملخص طلبك:*\n\n${itemsText}\n\n💰 الإجمالي: *${total} ﷼*\n🚚 التوصيل: ${delivery}\n📍 العنوان: ${draft.national_address || draft.city || '—'}\n\nاكتب *نعم* لتأكيد أو *إلغاء* للإلغاء`
  );
}

async function createSallaCoupon(code, discount, days = 3) {
  const accessToken = await getSallaToken();
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + days);

  await axios.post('https://api.salla.dev/admin/v2/coupons', {
    code,
    type:                  'percentage',
    amount:                discount,
    free_shipping:         false,
    expiry_date:           expiry.toISOString().split('T')[0],
    exclude_sale_products: false,
  }, {
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`✅ Salla coupon created: ${code} (${discount}%)`);
}

// توليد كود الكوبون — حرفان + رقمان (مختصر وسهل الحفظ)
function generateCouponCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits  = '23456789';
  const lb = crypto.randomBytes(2);
  const db = crypto.randomBytes(2);
  const part = Array.from(lb).map(b => letters[b % letters.length]).join('')
             + Array.from(db).map(b => digits[b % digits.length]).join('');
  return part; // مثال: AB27
}

// توليد كود فريد مع التحقق من عدم التكرار في قاعدة البيانات
async function generateUniqueCouponCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCouponCode();
    const { data } = await supabase.from('coupons').select('id').eq('code', code).maybeSingle();
    if (!data) return code;
  }
  throw new Error('فشل توليد كود كوبون فريد بعد 5 محاولات');
}

// ====================================================
// ⏰ الرسائل المجدولة — بديل setTimeout المؤقت
// يتطلب جدول scheduled_messages في Supabase:
//   id (uuid/serial), phone (text), template_name (text),
//   parameters (text/jsonb), send_at (timestamptz), sent (bool default false)
// ====================================================

async function scheduleMessage(phone, templateName, parameters, sendAt) {
  await supabase.from('scheduled_messages').insert({
    phone,
    template_name: templateName,
    parameters: JSON.stringify(parameters),
    send_at: sendAt.toISOString(),
    sent: false,
  });
}

async function processScheduledMessages() {
  const { data, error } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('sent', false)
    .lte('send_at', new Date().toISOString());

  if (error) {
    // الجدول غير موجود بعد — تجاهل هادئ
    if (error.code !== '42P01') console.error('❌ Scheduled messages error:', error.message);
    return;
  }
  if (!data?.length) return;

  for (const task of data) {
    try {
      const params = JSON.parse(task.parameters);
      await sendTemplate(task.phone, task.template_name, params);
      await supabase.from('scheduled_messages').update({ sent: true }).eq('id', task.id);
    } catch (err) {
      console.error(`❌ Scheduled message failed (id: ${task.id}):`, err.message);
    }
  }
}

// ====================================================
// 📲 واتساب — إرسال الرسائل
// ====================================================

const WA_URL = () => `https://graph.facebook.com/v19.0/${CONFIG.waPhoneId}/messages`;
const WA_HEADERS = () => ({
  Authorization: `Bearer ${CONFIG.waToken}`,
  'Content-Type': 'application/json',
});

// موقع مناحل آل عايد (الطائف)
const STORE_LAT = 21.2854;
const STORE_LNG = 40.4155;

// تحويل اسم المدينة إلى إحداثيات عبر Geocoding API
async function geocodeCity(cityName) {
  if (!CONFIG.googleMapsKey) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: `${cityName}, Saudi Arabia`, key: CONFIG.googleMapsKey, language: 'ar' },
    });
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (err) {
    console.error('❌ Geocode error:', err.message);
    return null;
  }
}

// حساب المسافة بالكيلومتر وتحديد نوع التوصيل
async function getDeliveryInfo(lat, lng) {
  if (!CONFIG.googleMapsKey) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: {
        origins:      `${STORE_LAT},${STORE_LNG}`,
        destinations: `${lat},${lng}`,
        key:          CONFIG.googleMapsKey,
        language:     'ar',
        units:        'metric',
      },
    });
    const element = data.rows?.[0]?.elements?.[0];
    if (element?.status !== 'OK') return null;
    const km       = Math.round(element.distance.value / 1000);
    const duration = element.duration.text;
    const sameDay  = km <= 60; // الطائف ومحيطها
    return { km, duration, sameDay };
  } catch (err) {
    console.error('❌ Maps API error:', err.message);
    return null;
  }
}

// عكس الإحداثيات → اسم المدينة والحي (لمشاركة الموقع من واتساب)
async function reverseGeocode(lat, lng) {
  if (!CONFIG.googleMapsKey) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: CONFIG.googleMapsKey, language: 'ar' },
    });
    const result = data.results?.[0];
    if (!result) return null;
    let city = null, neighborhood = null;
    for (const comp of result.address_components) {
      if (!city && (comp.types.includes('locality') || comp.types.includes('administrative_area_level_2'))) {
        city = comp.long_name;
      }
      if (!neighborhood && (comp.types.includes('sublocality_level_1') || comp.types.includes('neighborhood'))) {
        neighborhood = comp.long_name;
      }
    }
    if (!city) {
      const admin = result.address_components.find(c => c.types.includes('administrative_area_level_1'));
      city = admin?.long_name || null;
    }
    return { city, neighborhood };
  } catch (err) {
    console.error('❌ Reverse geocode error:', err.message);
    return null;
  }
}

// ====================================================
// 🎙️ الصوت والصور — Groq Whisper + Claude Vision
// ====================================================

// تحميل ملف الميديا من WhatsApp
async function downloadWhatsAppMedia(mediaId) {
  // الخطوة 1: احصل على URL الملف
  const { data: meta } = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${CONFIG.waToken}` } }
  );
  // الخطوة 2: حمّل الملف كـ buffer
  const { data: buffer } = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${CONFIG.waToken}` },
    responseType: 'arraybuffer',
  });
  return { buffer: Buffer.from(buffer), mimeType: meta.mime_type };
}

// تفريغ الصوت → نص عبر Groq Whisper
async function transcribeAudio(mediaId) {
  if (!CONFIG.groqKey) throw new Error('GROQ_API_KEY غير مضبوط');
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);

  // نحدد الامتداد من mime type
  const ext = mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('mp4') ? 'mp4'
    : mimeType.includes('mpeg') ? 'mp3'
    : 'ogg';

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: `audio.${ext}`, contentType: mimeType });
  form.append('model', 'whisper-large-v3');
  form.append('language', 'ar');
  form.append('response_format', 'text');

  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    { headers: { Authorization: `Bearer ${CONFIG.groqKey}`, ...form.getHeaders() } }
  );
  return typeof data === 'string' ? data.trim() : data?.text?.trim() || '';
}

// قراءة الصورة → نص وصفي عبر Claude Vision
async function describeImage(mediaId, caption) {
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
  const base64 = buffer.toString('base64');

  const prompt = caption
    ? `العميل أرسل صورة مع تعليق: "${caption}"\n\nصِف ما تراه في الصورة باختصار ثم أجب على تعليق العميل كمستشارة مبيعات عسل.`
    : `العميل أرسل هذه الصورة. صِف ما تراه وأجب عليه كمستشارة مبيعات عسل بلدي.`;

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    },
    {
      headers: {
        'x-api-key': CONFIG.claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );
  return data.content[0].text;
}

async function sendMessage(to, text) {
  try {
    await axios.post(WA_URL(), {
      messaging_product: 'whatsapp', to,
      type: 'text', text: { body: text },
    }, { headers: WA_HEADERS() });
  } catch (err) {
    console.error('❌ sendMessage error:', err.response?.data || err.message);
  }
}

async function sendTemplate(to, templateName, components = []) {
  await axios.post(WA_URL(), {
    messaging_product: 'whatsapp', to,
    type: 'template',
    template: { name: templateName, language: { code: 'ar' }, components },
  }, { headers: WA_HEADERS() });
  console.log(`✅ Template sent: ${templateName} → ${to}`);
}

// ====================================================
// 💬 معالجة الرسالة الواردة
// ====================================================

async function handleMessage(phone, userMessage) {
  try {
    const customer = await getCustomer(phone);
    await saveCustomer(phone);

    // ── تحقق من طلب جارٍ ──
    const draft = await getOrderDraft(phone);
    if (draft?.step) {
      await saveMessage(phone, 'user', userMessage);
      await handleOrderFlow(phone, userMessage, draft);
      return;
    }

    // جلب التاريخ أولاً قبل حفظ الرسالة الجديدة — لتجنب تكرارها في السياق
    const history  = await getHistory(phone, 8);
    await saveMessage(phone, 'user', userMessage);

    const messages = [...history, { role: 'user', content: userMessage }];

    // الذكاء الاصطناعي يفكر ويرد
    let botReply = await askAI(messages);
    let intent   = 'ai_reply';

    // ===== معالجة الأوامر التي تقررها نحلة =====

    // 0. بدء طلب جديد
    const orderMatch = botReply.match(/\[START_ORDER:([^\]:]+):(\d+)\]/);
    if (orderMatch) {
      const productKey = orderMatch[1].trim();
      const quantity   = parseInt(orderMatch[2]);
      const product    = Object.entries(SALLA_PRODUCTS).find(([k]) =>
        productKey.includes(k) || k.includes(productKey)
      )?.[1];

      if (!product) {
        await sendMessage(phone, botReply.replace(/\[START_ORDER:[^\]]+\]/, '').trim());
        return;
      }
      await saveOrderDraft(phone, {
        phone,
        step:  'collecting_name',
        items: [{ id: product.id, name: product.name, price: product.price, quantity }],
      });
      const intro = botReply.replace(/\[START_ORDER:[^\]]+\]/, '').trim();
      if (intro) await sendMessage(phone, intro);
      await sendMessage(phone, `✅ *${product.name} × ${quantity}* — ${product.price * quantity} ﷼\n\nلإتمام الطلب نحتاج معلومتين فقط 📋\n\n✍️ اكتب اسمك الأول والعائلة\nمثال: محمد العمري`);
      await saveMessage(phone, 'bot', `[order_started | ${product.name} × ${quantity}]`, 'order_start');
      return;
    }

    // 0b. إرسال رابط المتجر للطلب الذاتي
    if (botReply.includes('[STORE_ORDER]')) {
      try {
        await sendTemplate(phone, 'store_link', []);
        await saveMessage(phone, 'bot', '[store_link | self_order]', 'store_order');
      } catch {
        await sendMessage(phone, '🛒 أكمل طلبك من هنا:\n*ayedhoney.com*');
        await saveMessage(phone, 'bot', '[store_link fallback]', 'store_order');
      }
      return;
    }

    // 1. قالب واتساب — نحلة تقرر أي قالب ترسل
    const templateMatch = botReply.match(/\[TEMPLATE:([^\]]+)\]/);
    if (templateMatch) {
      const templateName = templateMatch[1];
      const isVip = customer?.is_vip || false;

      // القوالب التي تحتاج كوبون — تُولَّد تلقائياً
      const couponTemplates = ['win_back', 'vip_coupon', 'surprise_coupon', 'coupon_gift'];
      let components = [];
      let couponCode = null;

      if (couponTemplates.includes(templateName)) {
        const discount = (templateName === 'vip_coupon' || isVip) ? 12 : 7;
        const days = (templateName === 'vip_coupon' || isVip) ? 2 : 1;
        couponCode = await generateUniqueCouponCode();
        await saveCoupon(phone, couponCode, discount, days);
        components = [{ type: 'body', parameters: [
          { type: 'text', text: customer?.name || 'عزيزنا' },
          { type: 'text', text: String(discount) },
          { type: 'text', text: couponCode },
        ]}];
      }

      try {
        await sendTemplate(phone, templateName, components);
        intent = templateName;
        await saveMessage(phone, 'bot', `[template:${templateName}${couponCode ? ` | coupon:${couponCode}` : ''}]`, intent);
      } catch (err) {
        console.error(`❌ Template ${templateName} failed:`, err.response?.data || err.message);
        // نصوص fallback جاهزة لكل قالب — بدون استدعاء AI ثانٍ
        const staticFallbacks = {
          store_link:     '🛒 تفضل رابط المتجر:\n*ayedhoney.com*',
          contact_owner:  '📞 تواصل مع المالك مباشرة:\n*+966555906901*',
        };
        let fallbackReply = staticFallbacks[templateName]
          || botReply.replace(/\[TEMPLATE:[^\]]+\]/, '').trim();
        if (!fallbackReply) {
          try {
            fallbackReply = await askAI([...messages, { role: 'assistant', content: `أردت إرسال قالب ${templateName} لكنه فشل، أجيبي بنص طبيعي.` }]);
          } catch {
            fallbackReply = '🐝 تواصل مع المالك: *+966555906901*';
          }
        }
        await sendMessage(phone, fallbackReply);
        await saveMessage(phone, 'bot', fallbackReply, 'template_fallback');
      }
      return;
    }

    // 2. حساب المسافة من اسم المدينة
    const distanceMatch = botReply.match(/\[DISTANCE:([^\]]+)\]/);
    if (distanceMatch) {
      const cityName = distanceMatch[1].trim();
      const coords   = await geocodeCity(cityName);
      const info     = coords ? await getDeliveryInfo(coords.lat, coords.lng) : null;
      let reply;
      if (info) {
        reply = info.sameDay
          ? `📍 ${cityName} على بُعد *${info.km} كم* منا ✅\nمتاح توصيل بمندوب آل عايد — عادةً *نفس اليوم* 🏎️`
          : `📍 ${cityName} على بُعد *${info.km} كم* منا 🚚\nنوصّل عبر *SMSA* خلال 2-3 أيام عمل بإذن الله`;
      } else {
        // تحقق إذا كانت المدينة دولية
        const intlKeywords = ['الكويت','الإمارات','قطر','البحرين','عمان','الأردن','مصر','لندن','أمريكا','كندا','أوروبا','australia','uk','usa'];
        const isIntl = intlKeywords.some(k => cityName.toLowerCase().includes(k.toLowerCase()));
        reply = isIntl
          ? `🌍 نعم نوصّل لـ *${cityName}* عبر *DHL* 🚀\nالتوصيل خلال 3-7 أيام عمل — الشحن مجاني على طلبات العسل`
          : `🚚 نوصّل لجميع مناطق المملكة — الطائف نفس اليوم، وباقي المناطق 2-5 أيام\n🌍 وللخليج وأغلب دول العالم عبر *DHL*`;
      }
      await sendMessage(phone, reply);
      await saveMessage(phone, 'bot', reply, 'distance_reply');
      return;
    }

    // 3. كوبون خصم — نحلة تقرر النسبة
    const couponMatch = botReply.match(/\[COUPON:(\d+)\]/);
    if (couponMatch) {
      const isVip  = customer?.is_vip || false;
      let discount = parseInt(couponMatch[1]);
      // حماية: لا تتجاوز الحد المسموح
      discount = isVip ? Math.min(discount, 12) : Math.min(discount, 9);
      const code   = await generateUniqueCouponCode();
      const days   = isVip ? 2 : 1; // VIP = يومان | عادي = 24 ساعة
      await saveCoupon(phone, code, discount, days);

      const validityText = days === 1 ? '24 ساعة' : `${days} أيام`;
      botReply = botReply.replace(/\[COUPON:\d+\]/,
        `\n\n🎁 *مفاجأتك من آل عايد:*\n` +
        `🏷️ كود الخصم: *${code}*\n` +
        `📅 صالح ${validityText}\n` +
        `🛒 استخدمه في: *ayedhoney.com*`
      );
      intent = 'coupon_sent';
    }

    // 4. تحويل للمالك
    else if (botReply.includes('[TRANSFER]')) {
      botReply = botReply.replace('[TRANSFER]', '').trim();
      botReply += '\n\n👤 سأحولك للمالك مباشرة الآن...';
      await sendMessage(CONFIG.ownerPhone,
        `🔔 *عميل يحتاج اهتمامك*\n📱 الرقم: ${phone}\n💬 رسالته: "${userMessage}"`
      );
      intent = 'transferred';
    }

    await sendMessage(phone, botReply.trim());
    await saveMessage(phone, 'bot', botReply, intent);

  } catch (err) {
    console.error('❌ handleMessage error:', err);
    await sendMessage(phone, '🐝 عذراً، حدث خطأ مؤقت. تواصل مع المالك: *+966555906901*');
  }
}

// ====================================================
// 🎯 السيناريوهات التلقائية
// ====================================================

// السلة المتروكة — التنبيه الأول (بعد ساعة) — قالب Meta
async function abandonedCartFirst(phone, customerName, checkoutUrl) {
  const components = [
    { type: 'body', parameters: [{ type: 'text', text: customerName || 'عزيزنا' }] },
  ];
  // إذا عندنا رابط السلة — نضيفه للزر الديناميكي
  if (checkoutUrl) {
    components.push({
      type: 'button', sub_type: 'url', index: '0',
      parameters: [{ type: 'text', text: checkoutUrl }],
    });
  }
  await sendTemplate(phone, 'abandoned_cart_1', components);
  await saveMessage(phone, 'bot', `[abandoned_cart_1 | url:${checkoutUrl || 'static'}]`, 'abandoned_cart');
}

// السلة المتروكة — التنبيه الثاني (بعد 23 ساعة) — نحلة تكتبه
async function abandonedCartSecond(phone, cartInfo) {
  const customer = await getCustomer(phone);
  const name     = customer?.name || 'عزيزنا';

  const prompt = `اكتبي رسالة واتساب قصيرة ومحببة لعميل اسمه ${name} تركَ سلة في متجر آل عايد.
هذه المرة الثانية نتواصل معه — كوني أكثر إلحاحاً لكن بأسلوب خفيف ومرح.
معلومات السلة: ${JSON.stringify(cartInfo || {})}.
اكتبي الرسالة مباشرة بدون مقدمة.`;

  const reply = await askAI([{ role: 'user', content: prompt }]);
  await sendMessage(phone, reply);
  await saveMessage(phone, 'bot', reply, 'abandoned_cart_2');
}

// السلة المتروكة — التنبيه الثالث (بعد 48 ساعة) — قالب Meta + كوبون
async function abandonedCartThird(phone, customerName) {
  const code = await generateUniqueCouponCode();
  await saveCoupon(phone, code, 7, 1); // 24 ساعة — سلة متروكة

  await sendTemplate(phone, 'abandoned_cart_3', [
    { type: 'body', parameters: [
      { type: 'text', text: customerName || 'عزيزنا' },
      { type: 'text', text: '7' },
      { type: 'text', text: code },
    ]},
  ]);
  await saveMessage(phone, 'bot', `[abandoned_cart_3 template | coupon: ${code}]`, 'abandoned_cart_3');
}

// العملاء النائمون — يومياً الساعة 10 صباحاً
async function handleInactiveCustomers() {
  const now = new Date();

  // عميل نائم = لم يتواصل منذ 180 يوم
  const inactiveCutoff = new Date(now);
  inactiveCutoff.setDate(inactiveCutoff.getDate() - 180);

  // لا نعيد الإرسال إلا بعد 90 يوم من آخر رسالة استعادة
  const resendCutoff = new Date(now);
  resendCutoff.setDate(resendCutoff.getDate() - 90);

  const { data: inactive } = await supabase
    .from('customers').select('*')
    .lt('last_contact', inactiveCutoff.toISOString())
    .or(`win_back_sent_at.is.null,win_back_sent_at.lt.${resendCutoff.toISOString()}`)
    .limit(15); // 15 عميل يومياً

  if (!inactive?.length) { console.log('✅ No inactive customers today'); return; }
  console.log(`💛 Win-back: ${inactive.length} customers`);

  for (const customer of inactive) {
    const isVip    = customer.is_vip || false;
    const discount = isVip ? 12 : 7;
    const code     = await generateUniqueCouponCode();
    await saveCoupon(customer.phone, code, discount, isVip ? 3 : 1);

    await sendTemplate(customer.phone, isVip ? 'vip_coupon' : 'win_back', [
      { type: 'body', parameters: [
        { type: 'text', text: customer.name || 'عزيزنا' },
        { type: 'text', text: String(discount) },
        { type: 'text', text: code },
      ]},
    ]);

    await supabase.from('customers').update({ win_back_sent_at: now.toISOString() }).eq('phone', customer.phone);
    await saveMessage(customer.phone, 'bot', `[win_back template | coupon: ${code}]`, 'win_back');
    await new Promise(r => setTimeout(r, 2000));
  }
}

// مفاجأة شهرية — كل أول الشهر
async function monthlySurprise() {
  // جلب جميع العملاء النشطين بدون ترتيب تفضيلي لضمان العدالة
  const { data: customers } = await supabase
    .from('customers').select('*')
    .eq('is_active', true);

  if (!customers?.length) return;

  // خلط عشوائي حقيقي (Fisher-Yates) ثم اختيار 10
  const pool = customers.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const selected = pool.slice(0, 10);
  console.log(`🎉 Monthly surprise: ${selected.length} / ${customers.length} customers`);

  for (const customer of selected) {
    const code = await generateUniqueCouponCode();
    await saveCoupon(customer.phone, code, 7, 1); // 24 ساعة — هدية شهرية

    await sendTemplate(customer.phone, 'surprise_coupon', [
      { type: 'body', parameters: [
        { type: 'text', text: '7' },
        { type: 'text', text: code },
      ]},
    ]);

    await saveMessage(customer.phone, 'bot', `[surprise_coupon | coupon: ${code}]`, 'surprise_coupon');
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ====================================================
// 📡 Webhook واتساب
// ====================================================

// تخزين مؤقت لمعرّفات الرسائل المعالجة — مكافحة التكرار
const processedMsgIds = new Set();

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === CONFIG.waVerify) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', webhookLimiter, async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    for (const msg of messages) {
      // تجاهل الأنواع غير المدعومة
      if (!['text', 'location', 'audio', 'image'].includes(msg.type)) continue;

      // تجاهل الرسائل المكررة
      if (processedMsgIds.has(msg.id)) {
        console.log(`⚠️ Duplicate skipped: ${msg.id}`);
        continue;
      }
      processedMsgIds.add(msg.id);
      setTimeout(() => processedMsgIds.delete(msg.id), 10 * 60 * 1000);

      // رسالة موقع WhatsApp
      if (msg.type === 'location') {
        const { latitude, longitude } = msg.location;
        console.log(`📍 ${msg.from}: location ${latitude},${longitude}`);
        await saveCustomer(msg.from);

        // إذا كان في مسار الطلب (خطوة العنوان) → وجّه للطلب
        const locDraft = await getOrderDraft(msg.from);
        if (locDraft?.step === 'collecting_address') {
          await saveMessage(msg.from, 'user', `[location:${latitude},${longitude}]`);
          await handleOrderFlow(msg.from, `__LOCATION__:${latitude},${longitude}`, locDraft);
          continue;
        }

        // خارج مسار الطلب → رد معلومات توصيل عادي
        const info = await getDeliveryInfo(latitude, longitude);
        const reply = info
          ? (info.sameDay
              ? `📍 موقعك على بُعد *${info.km} كم* منا 🚗\n✅ التوصيل بمندوب آل عايد — عادةً *نفس اليوم* 🏎️`
              : `📍 موقعك على بُعد *${info.km} كم* منا\n🚚 التوصيل عبر *SMSA* — يصلك خلال 2-3 أيام عمل بإذن الله`)
          : `📍 وصلني موقعك! 🐝\nنوصّل لجميع مناطق المملكة — الطائف نفس اليوم، وباقي المناطق 2-5 أيام 🚚`;
        await sendMessage(msg.from, reply);
        await saveMessage(msg.from, 'bot', reply, 'location_reply');
        continue;
      }

      // 🎙️ رسالة صوتية — Groq Whisper
      if (msg.type === 'audio') {
        const mediaId = msg.audio?.id;
        if (!mediaId) continue;
        console.log(`🎙️ ${msg.from}: voice message`);
        try {
          const transcript = await transcribeAudio(mediaId);
          if (!transcript) {
            await sendMessage(msg.from, '🎙️ ما قدرت أسمع الرسالة بوضوح، ممكن تكتب سؤالك؟ 🐝');
            continue;
          }
          console.log(`🎙️ Transcript: ${transcript}`);
          await saveMessage(msg.from, 'user', `[voice] ${transcript}`);
          await handleMessage(msg.from, transcript);
        } catch (err) {
          console.error('❌ Voice transcription error:', err.message);
          await sendMessage(msg.from, '🎙️ صعوبة في معالجة الصوت — ممكن تكتب سؤالك؟ 🐝');
        }
        continue;
      }

      // 🖼️ رسالة صورة — Claude Vision
      if (msg.type === 'image') {
        const mediaId = msg.image?.id;
        const caption = msg.image?.caption || '';
        if (!mediaId) continue;
        console.log(`🖼️ ${msg.from}: image${caption ? ` + caption: ${caption}` : ''}`);
        try {
          const reply = await describeImage(mediaId, caption);
          await saveMessage(msg.from, 'user', `[image]${caption ? ` ${caption}` : ''}`);
          await sendMessage(msg.from, reply);
          await saveMessage(msg.from, 'bot', reply, 'image_reply');
        } catch (err) {
          console.error('❌ Image description error:', err.message);
          await sendMessage(msg.from, '🖼️ ما قدرت أقرأ الصورة، ممكن تصف ما تريد بالكلام؟ 🐝');
        }
        continue;
      }

      // رسالة نصية
      const text = msg.text.body;

      // كشف رابط مكان مختصر من Apple Maps (maps.apple.com/p/...)
      const appleMapsPlaceMatch = text.match(/maps\.apple\.com\/p\/([A-Za-z0-9~_\-]+)/);
      if (appleMapsPlaceMatch) {
        console.log(`📍 ${msg.from}: Apple Maps place link`);
        let lat = null, lng = null;
        try {
          const resp = await axios.get(
            `https://maps.apple.com/p/${appleMapsPlaceMatch[1]}`,
            { maxRedirects: 10, timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          // إحداثيات في الـ URL النهائي بعد الـ redirect
          const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || '';
          const llMatch  = finalUrl.match(/ll=([-\d.]+),([-\d.]+)/);
          if (llMatch) { lat = parseFloat(llMatch[1]); lng = parseFloat(llMatch[2]); }
          // أو داخل HTML الصفحة
          if (!lat) {
            const htmlMatch = String(resp.data).match(/"latitude":([-\d.]+),"longitude":([-\d.]+)/);
            if (htmlMatch) { lat = parseFloat(htmlMatch[1]); lng = parseFloat(htmlMatch[2]); }
          }
        } catch (e) { console.warn('Apple Maps place resolve failed:', e.message); }

        if (lat && lng) {
          const plDraft = await getOrderDraft(msg.from);
          if (plDraft?.step === 'collecting_address') {
            await saveMessage(msg.from, 'user', `[apple-maps-place:${lat},${lng}]`);
            await handleOrderFlow(msg.from, `__LOCATION__:${lat},${lng}`, plDraft);
            continue;
          }
          const info  = await getDeliveryInfo(lat, lng);
          const reply = info
            ? (info.sameDay
                ? `📍 موقعك على بُعد *${info.km} كم* منا ✅\nالتوصيل بمندوب آل عايد — عادةً *نفس اليوم* 🏎️`
                : `📍 موقعك على بُعد *${info.km} كم* منا\n🚚 التوصيل عبر *SMSA* — 2-3 أيام عمل بإذن الله`)
            : `📍 وصلني موقعك! 🐝\nنوصّل لجميع مناطق المملكة 🚚`;
          await sendMessage(msg.from, reply);
          await saveMessage(msg.from, 'bot', reply, 'location_reply');
        } else {
          // فشل الحل → نخلّي نحلة تطلب الموقع بطريقة أخرى
          await sendMessage(msg.from, `📍 ما أقدر أقرأ هذا الرابط مباشرة\n\nاضغط 📎 ← الموقع ← *موقعي الحالي* وأرسله لي 🐝`);
          await saveMessage(msg.from, 'bot', '[apple-maps-place: unresolved]', 'location_reply');
        }
        continue;
      }

      // كشف رابط خرائط أبل العادي (مع إحداثيات مباشرة)
      const appleMapsMatch = text.match(/maps\.apple\.com[^?]*\?[^#]*ll=([-\d.]+),([-\d.]+)/);
      if (appleMapsMatch) {
        const lat = parseFloat(appleMapsMatch[1]);
        const lng = parseFloat(appleMapsMatch[2]);
        console.log(`📍 ${msg.from}: Apple Maps ${lat},${lng}`);

        const apDraft = await getOrderDraft(msg.from);
        if (apDraft?.step === 'collecting_address') {
          await saveMessage(msg.from, 'user', `[apple-maps:${lat},${lng}]`);
          await handleOrderFlow(msg.from, `__LOCATION__:${lat},${lng}`, apDraft);
          continue;
        }

        const info = await getDeliveryInfo(lat, lng);
        const reply = info
          ? (info.sameDay
              ? `📍 موقعك على بُعد *${info.km} كم* منا 🚗\n✅ التوصيل بمندوب آل عايد — عادةً *نفس اليوم* 🏎️`
              : `📍 موقعك على بُعد *${info.km} كم* منا\n🚚 التوصيل عبر *SMSA* — يصلك خلال 2-3 أيام عمل بإذن الله`)
          : `📍 وصلني موقعك! 🐝\nنوصّل لجميع مناطق المملكة 🚚`;
        await sendMessage(msg.from, reply);
        await saveMessage(msg.from, 'bot', reply, 'location_reply');
        continue;
      }

      // كشف العنوان الوطني السعودي المختصر — مثال: RYDA1234
      const nationalAddressMatch = text.match(/\b([A-Z]{4}\d{4})\b/i);
      if (nationalAddressMatch) {
        const shortAddress = nationalAddressMatch[1].toUpperCase();
        console.log(`🏠 ${msg.from}: National Address ${shortAddress}`);

        // إذا كان في مسار الطلب → وجّه للطلب (بدل رد المسافة)
        const naDraft = await getOrderDraft(msg.from);
        if (naDraft?.step === 'collecting_address' || naDraft?.step === 'collecting_national_address') {
          await handleMessage(msg.from, text);
          continue;
        }

        // خارج مسار الطلب → رد عام (لا يمكن استنتاج المدينة من الرمز بموثوقية)
        const reply = `🏠 وصلني عنوانك *${shortAddress}* ✅\nنوصّل لجميع مناطق المملكة — الطائف نفس اليوم، وباقي المناطق 2-5 أيام 🚚\n\n📌 شارك موقعك لأحسب المسافة بدقة`;
        await sendMessage(msg.from, reply);
        await saveMessage(msg.from, 'bot', reply, 'national_address_reply');
        continue;
      }

      console.log(`📩 ${msg.from}: ${text}`);
      await handleMessage(msg.from, text);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

// ====================================================
// 🌐 API لوحة التحكم
// ====================================================

// إحصائيات
app.get('/api/stats', requireApiSecret, apiLimiter, async (_req, res) => {
  const [convs, customers, coupons] = await Promise.all([
    supabase.from('conversations').select('id, intent', { count: 'exact' }),
    supabase.from('customers').select('id', { count: 'exact' }),
    supabase.from('coupons').select('id', { count: 'exact' }),
  ]);
  res.json({
    conversations: convs.count || 0,
    customers:     customers.count || 0,
    coupons:       coupons.count || 0,
    transferred:   convs.data?.filter(c => c.intent === 'transferred').length || 0,
  });
});

// آخر المحادثات
app.get('/api/conversations', requireApiSecret, apiLimiter, async (_req, res) => {
  const { data } = await supabase
    .from('conversations').select('*')
    .order('created_at', { ascending: false }).limit(100);
  res.json(data || []);
});

// تشغيل السلة المتروكة (تُستدعى من سلة API)
app.post('/api/abandoned-cart', requireApiSecret, apiLimiter, async (req, res) => {
  const { phone, step, cart, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (step === 1) await abandonedCartFirst(phone, name);
  else if (step === 2) await abandonedCartSecond(phone, cart);
  else if (step === 3) await abandonedCartThird(phone, name);
  res.json({ success: true });
});

// ما بعد الشراء (تُستدعى من سلة API)
app.post('/api/post-purchase', requireApiSecret, apiLimiter, async (req, res) => {
  const { phone, orderId, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  await sendTemplate(phone, 'post_purchase', [
    { type: 'body', parameters: [
      { type: 'text', text: name || 'عزيزنا' },
      { type: 'text', text: orderId || '—' },
    ]},
  ]);
  // جدولة طلب التقييم بعد يومين في قاعدة البيانات — لا setTimeout
  const sendAt = new Date();
  sendAt.setDate(sendAt.getDate() + 2);
  await scheduleMessage(phone, 'review_request', [
    { type: 'body', parameters: [{ type: 'text', text: name || 'عزيزنا' }] }
  ], sendAt);
  res.json({ success: true });
});

// Webhook سلة — سلة متروكة (abandoned_cart.created + abandoned_cart.updated)
// الرابط: /api/salla/abandoned-cart?secret=API_SECRET
app.post('/api/salla/abandoned-cart', apiLimiter, async (req, res) => {
  const secret = req.query.secret;
  if (!CONFIG.apiSecret || secret !== CONFIG.apiSecret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.json({ success: true });

  try {
    const cart     = req.body?.data || req.body;
    const customer = cart?.customer || {};

    const mobileCode = (customer.mobile_code || '+966').replace('+', '');
    const mobile     = (customer.mobile || '').replace(/^0/, '');
    const phone      = mobileCode + mobile;
    if (!mobile) { console.warn('⚠️ abandoned-cart: no phone'); return; }

    const name        = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'عزيزنا';
    const checkoutUrl = cart?.urls?.checkout || cart?.checkout_url || null;
    console.log(`🛒 Abandoned cart: ${phone} | ${name} | url:${checkoutUrl}`);

    await saveCustomer(phone, { name });

    // الخطوة 1: فوري — قالب abandoned_cart_1 مع رابط السلة الديناميكي
    await abandonedCartFirst(phone, name, checkoutUrl);

    // الخطوة 2: بعد 48 ساعة — قالب abandoned_cart_3 + كوبون
    const code = await generateUniqueCouponCode();
    await saveCoupon(phone, code, 7, 2); // صالح يومين
    const sendAt = new Date();
    sendAt.setHours(sendAt.getHours() + 48);
    await scheduleMessage(phone, 'abandoned_cart_3', [
      { type: 'body', parameters: [
        { type: 'text', text: name },
        { type: 'text', text: '7' },
        { type: 'text', text: code },
      ]},
    ], sendAt);

  } catch (err) {
    console.error('❌ Salla abandoned-cart webhook error:', err.message);
  }
});

// Webhook سلة — طلب جديد (order.created)
// الرابط: /api/salla/order?secret=API_SECRET
app.post('/api/salla/order', apiLimiter, async (req, res) => {
  const secret = req.query.secret;
  if (!CONFIG.apiSecret || secret !== CONFIG.apiSecret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.json({ success: true }); // رد سريع لسلة

  try {
    const order    = req.body?.data || req.body;
    const customer = order?.customer || {};

    // استخراج رقم الهاتف — سلة ترسله بأشكال مختلفة
    const mobileCode = (customer.mobile_code || '+966').replace('+', '');
    const mobile     = (customer.mobile || '').replace(/^0/, '');
    const phone      = mobileCode + mobile;

    const name    = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'عزيزنا';
    const orderId = String(order?.reference_id || order?.id || '—');

    if (!mobile) { console.warn('⚠️ Salla order: no phone'); return; }

    console.log(`🛒 Salla order: ${orderId} | ${phone} | ${name}`);

    // رسالة ما بعد الشراء
    await sendTemplate(phone, 'post_purchase', [
      { type: 'body', parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
      ]},
    ]);

    // حفظ العميل في قاعدة البيانات
    await saveCustomer(phone, { name });
    await saveMessage(phone, 'bot', `[post_purchase | order: ${orderId}]`, 'post_purchase');

    // جدولة طلب التقييم بعد يومين
    const sendAt = new Date();
    sendAt.setDate(sendAt.getDate() + 2);
    await scheduleMessage(phone, 'review_request', [
      { type: 'body', parameters: [{ type: 'text', text: name }] }
    ], sendAt);

  } catch (err) {
    console.error('❌ Salla order webhook error:', err.message);
  }
});

// Webhook سلة — تحديث حالة الطلب (order.status.updated)
// الرابط: /api/salla/order-status?secret=API_SECRET
app.post('/api/salla/order-status', apiLimiter, async (req, res) => {
  const secret = req.query.secret;
  if (!CONFIG.apiSecret || secret !== CONFIG.apiSecret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.json({ success: true }); // رد سريع لسلة

  try {
    const order    = req.body?.data || req.body;
    const customer = order?.customer || {};

    const mobileCode = (customer.mobile_code || '+966').replace('+', '');
    const mobile     = (customer.mobile || '').replace(/^0/, '');
    const phone      = mobileCode + mobile;
    if (!mobile) { console.warn('⚠️ order-status: no phone'); return; }

    const name     = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'عزيزنا';
    const orderId  = String(order?.reference_id || order?.id || '—');
    const rawStatus = order?.status?.name || order?.status || '';

    // ترجمة حالات سلة إلى عربي
    const statusMap = {
      under_review:  'قيد المراجعة 🔍',
      in_progress:   'جاري التجهيز 📦',
      pending:       'قيد الانتظار ⏳',
      shipping:      'في الطريق إليك 🚚',
      shipped:       'في الطريق إليك 🚚',
      out_for_delivery: 'مع المندوب الآن 🛵',
      delivered:     'تم التوصيل ✅',
      canceled:      'ملغي ❌',
      cancelled:     'ملغي ❌',
      returned:      'تم الإرجاع 🔄',
    };
    const statusAr = statusMap[rawStatus] || rawStatus;
    if (!statusAr) { console.warn('⚠️ order-status: unknown status', rawStatus); return; }

    console.log(`📦 Order status: ${orderId} → ${rawStatus} | ${phone}`);

    await sendTemplate(phone, 'order_tracking', [
      { type: 'body', parameters: [
        { type: 'text', text: name },
        { type: 'text', text: orderId },
        { type: 'text', text: statusAr },
      ]},
    ]);
    await saveMessage(phone, 'bot', `[order_tracking | order:${orderId} | status:${rawStatus}]`, 'order_tracking');

  } catch (err) {
    console.error('❌ Salla order-status webhook error:', err.message);
  }
});

// ====================================================
// 🔐 سلة OAuth — إعداد أولي مرة واحدة فقط
// ====================================================

// الخطوة 1: افتح هذا الرابط في المتصفح (مع x-api-secret في الهيدر أو عبر الداشبورد)
let sallaOAuthState = null; // تخزين مؤقت للـ state

app.get('/salla/auth', (req, res) => {
  if (req.query.secret !== CONFIG.apiSecret) return res.status(403).send('Unauthorized');
  if (!CONFIG.sallaClientId || !CONFIG.sallaRedirectUri) {
    return res.status(500).send('❌ SALLA_CLIENT_ID أو SALLA_REDIRECT_URI غير مضبوط');
  }
  sallaOAuthState = crypto.randomBytes(16).toString('hex'); // 32 حرف — أكثر من الحد الأدنى
  const url = new URL('https://accounts.salla.sa/oauth2/auth');
  url.searchParams.set('client_id',     CONFIG.sallaClientId);
  url.searchParams.set('redirect_uri',  CONFIG.sallaRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'offline_access marketing.read_write');
  url.searchParams.set('state',         sallaOAuthState);
  res.redirect(url.toString());
});

// الخطوة 2: سلة ترجع هنا بعد موافقة المستخدم
app.get('/salla/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.status(400).send(`❌ خطأ من سلة: ${error}`);
  if (!sallaOAuthState || state !== sallaOAuthState) return res.status(400).send('❌ state غير صالح — أعد فتح /salla/auth');
  if (!code)  return res.status(400).send('❌ لا يوجد code');

  try {
    const tokenRes = await axios.post('https://accounts.salla.sa/oauth2/token', {
      grant_type:    'authorization_code',
      code,
      client_id:     CONFIG.sallaClientId,
      client_secret: CONFIG.sallaClientSecret,
      redirect_uri:  CONFIG.sallaRedirectUri,
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    await supabase.from('salla_tokens').upsert({
      id:            1,
      access_token,
      refresh_token,
      expires_at:    Date.now() + expires_in * 1000,
      updated_at:    new Date(),
    });

    console.log('✅ Salla connected successfully');
    res.send('<h2>✅ تم ربط سلة بنجاح!</h2><p>نحلة الآن تنشئ الكوبونات مباشرة في متجرك.</p>');
  } catch (err) {
    console.error('❌ Salla OAuth callback error:', err.response?.data || err.message);
    res.status(500).send(`❌ فشل الربط: ${err.response?.data?.message || err.message}`);
  }
});

// Health check
app.get('/health', (_req, res) => res.json({
  status: 'ok', bot: 'نحلة 2.0 🐝',
  ai: CONFIG.openaiKey ? 'OpenAI' : CONFIG.claudeKey ? 'Claude' : 'Gemini',
}));

// لوحة التحكم
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ====================================================
// ⏰ المهام المجدولة
// ====================================================

// كل يوم 10 صباحاً — استرداد العملاء النائمين
cron.schedule('0 10 * * *', () => {
  console.log('⏰ Win-back check...');
  handleInactiveCustomers();
});

// كل أول الشهر 11 صباحاً — مفاجأة شهرية
cron.schedule('0 11 1 * *', () => {
  console.log('🎉 Monthly surprise...');
  monthlySurprise();
});

// كل دقيقة — معالجة الرسائل المجدولة (بديل setTimeout)
cron.schedule('* * * * *', () => {
  processScheduledMessages();
});

// ====================================================
// 🚀 تشغيل الخادم
// ====================================================
app.listen(CONFIG.port, () => {
  const aiProvider = CONFIG.openaiKey ? 'OpenAI GPT-4o' : CONFIG.claudeKey ? 'Claude Sonnet' : 'Gemini';
  console.log(`
╔══════════════════════════════════════╗
║      نحلة 2.0 🐝 — مناحل آل عايد    ║
╠══════════════════════════════════════╣
║  🤖 الذكاء: ${aiProvider.padEnd(23)}║
║  🚀 http://localhost:${CONFIG.port}          ║
║  📊 لوحة التحكم: /                  ║
╚══════════════════════════════════════╝
  `);
});
