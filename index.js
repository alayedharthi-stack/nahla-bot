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
app.use(express.json());

// ====================================================
// ⚙️ الإعدادات
// ====================================================
const CONFIG = {
  // AI Keys — الأولوية: OpenAI ← Claude ← Gemini
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

## ✍️ أسلوب الكتابة:
- *النص العريض* بنجمة للأسعار والكوبونات والمعلومات المهمة
- الإيموجي باعتدال وفي مكانها الطبيعي 🍯🐝✅
- ردود قصيرة ومفيدة — لا إطالة بلا فائدة
- أسطر منظّمة عند ذكر الأسعار أو الخيارات

## 📚 معلوماتك الكاملة:
${knowledge}

## ⚡ قدراتك — أنتِ تقررين متى وكيف:

### 1️⃣ إرسال كوبون خصم
- متى: عند التردد في الشراء، طلب الخصم، أو الحاجة لتحفيز
- نسب الخصم: 5% أو 7% أو 9% (أنتِ تقررين المناسب حسب الموقف)
- 12% للعملاء المميزين VIP فقط
- *مهم جداً:* لا تذكري النسبة مسبقاً — قولي فقط "عندي مفاجأة لك 🎁"
- الكوبون يُولَّد تلقائياً بالكود [COUPON:رقم] مثل [COUPON:7]

### 2️⃣ إرسال قالب رابط المتجر
- متى: عند السؤال عن المتجر أو الطلب
- الكود: [TEMPLATE:store_link]

### 3️⃣ إرسال قالب التواصل مع المالك
- متى: عند طلب التواصل المباشر
- الكود: [TEMPLATE:contact_owner]

### 4️⃣ تحويل للمالك (للحالات الجدية)
- متى: شكاوى جدية، طلبات جملة كبيرة، أسئلة خارج نطاقك
- الكود: [TRANSFER]

## 🚫 قواعد لا تتجاوزيها:
- لا خصم أكثر من 9% للعملاء العاديين (12% VIP فقط)
- السمن البلدي لا يشمله أي خصم — أبداً
- لا تبالغي في وصف المنتجات أكثر من الحقيقة
- لا تعدي بما ليس في يدك`;

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
  // المزود 1: OpenAI
  if (CONFIG.openaiKey) {
    try {
      const reply = await askOpenAI(messages);
      console.log('✅ OpenAI responded');
      return reply;
    } catch (err) {
      console.warn('⚠️ OpenAI failed:', err.response?.data?.error?.message || err.message);
    }
  }

  // المزود 2: Claude
  if (CONFIG.claudeKey) {
    try {
      const reply = await askClaude(messages);
      console.log('✅ Claude responded');
      return reply;
    } catch (err) {
      console.warn('⚠️ Claude failed:', err.response?.data?.error?.message || err.message);
    }
  }

  // المزود 3: Gemini (الاحتياطي الأخير)
  if (CONFIG.geminiKey) {
    try {
      const reply = await askGemini(messages);
      console.log('✅ Gemini responded');
      return reply;
    } catch (err) {
      console.error('❌ All AI providers failed:', err.message);
      throw new Error('All AI providers failed');
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

async function saveCoupon(phone, code, discount) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  await supabase.from('coupons').insert({ phone, code, discount_percent: discount, expires_at: expires });
}

// توليد كود الكوبون بتشفير آمن (5 حروف عشوائية بدلاً من حرف+رقم)
function generateCouponCode(discount, isVip = false) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(5);
  const part  = Array.from(bytes).map(b => chars[b % chars.length]).join('');
  return isVip ? `VIP${discount}${part}` : `NAH${discount}${part}`;
}

// توليد كود فريد مع التحقق من عدم التكرار في قاعدة البيانات
async function generateUniqueCouponCode(discount, isVip = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCouponCode(discount, isVip);
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
  try {
    await axios.post(WA_URL(), {
      messaging_product: 'whatsapp', to,
      type: 'template',
      template: { name: templateName, language: { code: 'ar' }, components },
    }, { headers: WA_HEADERS() });
    console.log(`✅ Template sent: ${templateName} → ${to}`);
  } catch (err) {
    console.error(`❌ Template error (${templateName}):`, err.response?.data || err.message);
    // Fallback نصي إذا فشل القالب
    const fallbacks = {
      store_link:     '🛒 تفضل متجرنا: *ayedhoney.com* 🍯',
      contact_owner:  '👤 للتواصل المباشر مع المالك:\n📞 *+966555906901*',
      post_purchase:  '🎉 شكراً على طلبك! سنتواصل معك قريباً 🐝',
      review_request: '🌟 نتمنى أن تمنحنا تقييمك: https://maps.app.goo.gl/WstMVjfaSMckzx8N7',
    };
    if (fallbacks[templateName]) await sendMessage(to, fallbacks[templateName]);
  }
}

// ====================================================
// 💬 معالجة الرسالة الواردة
// ====================================================

async function handleMessage(phone, userMessage) {
  try {
    const customer = await getCustomer(phone);
    await saveCustomer(phone);

    // جلب التاريخ أولاً قبل حفظ الرسالة الجديدة — لتجنب تكرارها في السياق
    const history  = await getHistory(phone, 8);
    await saveMessage(phone, 'user', userMessage);

    const messages = [...history, { role: 'user', content: userMessage }];

    // الذكاء الاصطناعي يفكر ويرد
    let botReply = await askAI(messages);
    let intent   = 'ai_reply';

    // ===== معالجة الأوامر التي تقررها نحلة =====

    // 1. قالب رابط المتجر
    if (botReply.includes('[TEMPLATE:store_link]')) {
      const textPart = botReply.replace('[TEMPLATE:store_link]', '').trim();
      if (textPart) await sendMessage(phone, textPart);
      await sendTemplate(phone, 'store_link');
      intent = 'store_link';
      if (textPart) await saveMessage(phone, 'bot', textPart, intent);
      return;
    }

    // 2. قالب التواصل مع المالك
    if (botReply.includes('[TEMPLATE:contact_owner]')) {
      const textPart = botReply.replace('[TEMPLATE:contact_owner]', '').trim();
      if (textPart) await sendMessage(phone, textPart);
      await sendTemplate(phone, 'contact_owner');
      intent = 'contact_owner';
      if (textPart) await saveMessage(phone, 'bot', textPart, intent);
      return;
    }

    // 3. كوبون خصم — نحلة تقرر النسبة
    const couponMatch = botReply.match(/\[COUPON:(\d+)\]/);
    if (couponMatch) {
      const isVip  = customer?.is_vip || false;
      let discount = parseInt(couponMatch[1]);
      // حماية: لا تتجاوز الحد المسموح
      discount = isVip ? Math.min(discount, 12) : Math.min(discount, 9);
      const code   = await generateUniqueCouponCode(discount, isVip);
      await saveCoupon(phone, code, discount);

      botReply = botReply.replace(/\[COUPON:\d+\]/,
        `\n\n🎁 *مفاجأتك من آل عايد:*\n` +
        `🏷️ كود الخصم: *${code}*\n` +
        `📅 صالح 30 يوم\n` +
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
async function abandonedCartFirst(phone, customerName) {
  await sendTemplate(phone, 'abandoned_cart_1', [
    { type: 'body', parameters: [{ type: 'text', text: customerName || 'عزيزنا' }] }
  ]);
  await saveMessage(phone, 'bot', '[abandoned_cart_1 template]', 'abandoned_cart');
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
  const code = await generateUniqueCouponCode(7);
  await saveCoupon(phone, code, 7);

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
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);

  const { data: inactive } = await supabase
    .from('customers').select('*')
    .lt('last_contact', cutoff.toISOString())
    .eq('win_back_sent', false)
    .limit(15); // 15 عميل يومياً — لا مبالغة

  if (!inactive?.length) { console.log('✅ No inactive customers today'); return; }
  console.log(`💛 Win-back: ${inactive.length} customers`);

  for (const customer of inactive) {
    const isVip    = customer.is_vip || false;
    const discount = isVip ? 12 : 7;
    const code     = await generateUniqueCouponCode(discount, isVip);
    await saveCoupon(customer.phone, code, discount);

    await sendTemplate(customer.phone, isVip ? 'vip_coupon' : 'win_back', [
      { type: 'body', parameters: [
        { type: 'text', text: customer.name || 'عزيزنا' },
        { type: 'text', text: String(discount) },
        { type: 'text', text: code },
      ]},
    ]);

    await supabase.from('customers').update({ win_back_sent: true }).eq('phone', customer.phone);
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
    const code = await generateUniqueCouponCode(7);
    await saveCoupon(customer.phone, code, 7);

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
      if (msg.type !== 'text') continue;

      // تجاهل الرسائل المكررة بناءً على msg.id
      if (processedMsgIds.has(msg.id)) {
        console.log(`⚠️ Duplicate skipped: ${msg.id}`);
        continue;
      }
      processedMsgIds.add(msg.id);
      // تنظيف المعرّف بعد 10 دقائق
      setTimeout(() => processedMsgIds.delete(msg.id), 10 * 60 * 1000);

      console.log(`📩 ${msg.from}: ${msg.text.body}`);
      await handleMessage(msg.from, msg.text.body);
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
