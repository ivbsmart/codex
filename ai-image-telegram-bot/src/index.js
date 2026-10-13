import 'dotenv/config';
import { Telegraf, Markup, Input } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.OPENAI_API_KEY;
const allowed = new Set((process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
if (!token || !apiKey || !allowed.size) throw new Error('Fill TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, ALLOWED_TELEGRAM_IDS in .env');
const MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const SIZES = ['1024x1024', '1536x1024', '1024x1536', '1152x1536'];
const DEFAULT_SIZE = '1152x1536';
const sizeLabel = size => size === '1152x1536' ? '3:4' : size;
const QUALITIES = ['low', 'medium', 'high']; // max is not a documented Images API quality value
const defaultModel = MODELS.includes(process.env.DEFAULT_MODEL) ? process.env.DEFAULT_MODEL : MODELS[0];
const dailyLimit = Math.max(1, Number(process.env.DAILY_LIMIT) || 10);
const maxReferenceBytes = Math.max(1, Number(process.env.MAX_REFERENCE_MB) || 15) * 1024 * 1024;
const bot = new Telegraf(token);
const sessions = new Map();
const usage = new Map();
const busy = new Set();
const menu = () => Markup.keyboard([['🎨 Создать новое изображение'], ['🖼 Создать / редактировать по фото']]).resize();
const MAX_REFERENCES = 5;
const referenceKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('✅ Завершить отправку', 'references:done')],
  [Markup.button.callback('🏠 Главное меню', 'home')]
]);
const backMenu = () => Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'back'), Markup.button.callback('🏠 Главное меню', 'home')]]);
const settingsKeyboard = s => Markup.inlineKeyboard([
  [Markup.button.callback(`🤖 Модель: ${s.model.replace('gpt-image-', '')}`, 'choose:model')],
  [Markup.button.callback(`📐 Размер: ${sizeLabel(s.size)}`, 'choose:size')],
  [Markup.button.callback(`✨ Качество: ${s.quality}`, 'choose:quality')],
  [Markup.button.callback('➡️ Продолжить', 'continue')],
  [Markup.button.callback('🏠 Главное меню', 'home')]
]);
function session(id) {
  if (!sessions.has(id)) sessions.set(id, { model: defaultModel, size: DEFAULT_SIZE, quality: 'medium', mode: null, stage: 'home', references: [] });
  return sessions.get(id);
}
function isAllowed(ctx) { return ctx.from && allowed.has(String(ctx.from.id)); }
function dayKey(id) { return `${id}:${new Date().toISOString().slice(0, 10)}`; }
function used(id) { return usage.get(dayKey(id)) || 0; }
function checkLimit(id) { return used(id) < dailyLimit; }
function count(id) { const key = dayKey(id); usage.set(key, used(id) + 1); }
function resetFlow(s) { s.mode = null; s.stage = 'home'; s.references = []; }
async function showHome(ctx) { const s = session(ctx.from.id); resetFlow(s); await ctx.reply('Привет! 👋\nВыбери, что хочешь сделать:', menu()); }
async function showSettings(ctx, s) { s.stage = 'settings'; await ctx.reply('⚙️ Настройки генерации\nВыбери модель, размер и качество:', settingsKeyboard(s)); }
function explainError(error) {
  console.error('Generation error:', error.status || '', error.message);
  if (error.status === 429) return 'OpenAI ограничил частоту запросов или исчерпан доступный баланс.';
  if (error.status === 401) return 'Ошибка авторизации OpenAI. Проверь API-ключ на сервере.';
  if (error.status === 400) return 'OpenAI отклонил параметры или запрос. Проверь доступность выбранной модели и её настройки.';
  return 'Не удалось создать изображение. Попробуй позже.';
}
async function openaiRequest(path, options) {
  const res = await fetch(`https://api.openai.com/v1/images/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, ...options.headers }, body: options.body, signal: AbortSignal.timeout(240000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error?.message || `OpenAI HTTP ${res.status}`); e.status = res.status; throw e; }
  if (!data.data?.[0]?.b64_json) throw new Error('No image in OpenAI response');
  return Buffer.from(data.data[0].b64_json, 'base64');
}
async function downloadReference(fileId) {
  const link = await bot.telegram.getFileLink(fileId);
  const res = await fetch(link, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxReferenceBytes) throw new Error('Reference too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxReferenceBytes) throw new Error('Reference too large');
  return bytes;
}
async function generate(ctx, s, prompt) {
  const id = ctx.from.id;
  if (busy.has(id)) return ctx.reply('⏳ Предыдущий запрос ещё выполняется.');
  if (!checkLimit(id)) return ctx.reply(`Дневной лимит ${dailyLimit} генераций исчерпан (сброс в 00:00 UTC).`);
  busy.add(id);
  s.stage = 'generating';
  await ctx.reply('⏳ Генерирую изображение…');
  const typing = setInterval(() => { ctx.telegram.sendChatAction(ctx.chat.id, 'upload_photo').catch(() => {}); }, 5000);
  try {
    const params = { model: s.model, prompt, size: s.size, quality: s.quality, output_format: 'png' };
    let output;
    if (s.mode === 'edit') {
      if (!s.references.length) throw new Error('Missing references');
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) form.append(key, value);
      for (const [index, reference] of s.references.entries()) {
        const bytes = await downloadReference(reference.fileId);
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[reference.mime];
        form.append('image[]', new Blob([bytes], { type: reference.mime }), `reference-${index + 1}.${extension}`);
      }
      output = await openaiRequest('edits', { body: form });
    } else {
      output = await openaiRequest('generations', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    }
    count(id);
    await ctx.replyWithDocument(Input.fromBuffer(output, 'result.png'), { caption: `Готово ✅\nМодель: ${s.model}\nРазмер: ${sizeLabel(s.size)}\nКачество: ${s.quality}` });
    resetFlow(s);
    await ctx.reply('Можно создать следующее изображение:', menu());
  } catch (error) {
    await ctx.reply(explainError(error));
    s.stage = s.mode === 'edit' && s.references.length ? 'prompt' : s.mode === 'edit' ? 'reference' : 'prompt';
    await ctx.reply(s.stage === 'reference' ? 'Пришли от 1 до 5 фото товара или нажми /cancel для отмены.' : 'Отправь новый промпт или нажми /cancel для отмены.');
  } finally { clearInterval(typing); busy.delete(id); }
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) { if (ctx.chat) await ctx.reply('⛔ Доступ закрыт.'); return; }
  await next();
});
bot.start(showHome);
bot.command('cancel', async ctx => { if (busy.has(ctx.from.id)) return ctx.reply('Запрос уже отправлен в OpenAI; дождись завершения.'); await showHome(ctx); });
bot.command('menu', async ctx => { if (busy.has(ctx.from.id)) return ctx.reply('Дождись завершения генерации.'); await showHome(ctx); });
bot.hears('🎨 Создать новое изображение', async ctx => {
  if (busy.has(ctx.from.id)) return ctx.reply('⏳ Дождись результата.');
  const s = session(ctx.from.id); s.mode = 'new'; s.references = []; await showSettings(ctx, s);
});
bot.hears('🖼 Создать / редактировать по фото', async ctx => {
  if (busy.has(ctx.from.id)) return ctx.reply('⏳ Дождись результата.');
  const s = session(ctx.from.id); s.mode = 'edit'; s.references = []; await showSettings(ctx, s);
});
bot.on('callback_query', async ctx => {
  await ctx.answerCbQuery();
  if (busy.has(ctx.from.id)) return ctx.reply('⏳ Дождись результата.');
  const s = session(ctx.from.id);
  const action = ctx.callbackQuery.data;
  if (action === 'home') return showHome(ctx);
  if (action === 'back') return showSettings(ctx, s);
  if (!s.mode) return showHome(ctx);
  if (action.startsWith('choose:')) {
    const field = action.split(':')[1];
    const values = field === 'model' ? MODELS : field === 'size' ? SIZES : field === 'quality' ? QUALITIES : null;
    if (!values) return;
    s.stage = 'settings';
    return ctx.reply(`Выбери ${field}:`, Markup.inlineKeyboard([...values.map(v => [Markup.button.callback(`${s[field] === v ? '✅ ' : ''}${field === 'size' ? sizeLabel(v) : v}`, `set:${field}:${v}`)]), [Markup.button.callback('⬅️ Назад', 'back')]]));
  }
  if (action.startsWith('set:')) {
    const [, field, value] = action.split(':');
    const values = { model: MODELS, size: SIZES, quality: QUALITIES }[field];
    if (!values?.includes(value)) return;
    s[field] = value;
    return showSettings(ctx, s);
  }
  if (action === 'references:done') {
    if (s.mode !== 'edit' || s.stage !== 'reference') return;
    if (!s.references.length) return ctx.reply('Сначала пришли хотя бы одно фото товара.');
    s.stage = 'prompt';
    return ctx.reply(`Принято фото: ${s.references.length} ✅ Теперь отправь промпт: какую карточку товара создать?`);
  }
  if (action === 'continue' && s.stage === 'settings') {
    s.stage = s.mode === 'edit' ? 'reference' : 'prompt';
    return ctx.reply(s.mode === 'edit' ? '🖼 Пришли от 1 до 5 фото товара отдельными сообщениями (фото или PNG/JPEG/WEBP файлом). После загрузки нажми «Завершить отправку».' : '✍️ Отправь текстовый промпт для генерации.', backMenu());
  }
});
async function addReference(ctx, s, reference) {
  if (s.references.length >= MAX_REFERENCES) return ctx.reply('Уже принято 5 фото. Отправь промпт для карточки товара.');
  s.references.push(reference);
  if (s.references.length === MAX_REFERENCES) {
    s.stage = 'prompt';
    return ctx.reply('Принято 5 из 5 фото ✅ Отправка завершена. Теперь отправь промпт: какую карточку товара создать?');
  }
  await ctx.reply(`Фото принято ✅ (${s.references.length} из ${MAX_REFERENCES}). Пришли следующее фото или нажми «Завершить отправку».`, referenceKeyboard());
}
bot.on('photo', async ctx => {
  const s = session(ctx.from.id);
  if (s.stage !== 'reference' || busy.has(ctx.from.id)) return ctx.reply('Сначала выбери режим редактирования.');
  const p = ctx.message.photo.at(-1);
  if (p.file_size && p.file_size > maxReferenceBytes) return ctx.reply('Изображение слишком большое.');
  await addReference(ctx, s, { fileId: p.file_id, mime: 'image/jpeg' });
});
bot.on('document', async ctx => {
  const s = session(ctx.from.id);
  if (s.stage !== 'reference' || busy.has(ctx.from.id)) return ctx.reply('Сначала выбери режим редактирования.');
  const d = ctx.message.document;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(d.mime_type)) return ctx.reply('Нужен PNG, JPEG или WEBP.');
  if (d.file_size && d.file_size > maxReferenceBytes) return ctx.reply('Файл слишком большой.');
  await addReference(ctx, s, { fileId: d.file_id, mime: d.mime_type });
});
bot.on('text', async ctx => {
  const s = session(ctx.from.id);
  if (busy.has(ctx.from.id)) return ctx.reply('⏳ Генерация уже выполняется.');
  if (s.stage === 'reference') return ctx.reply('Пришли следующее фото или нажми «Завершить отправку». Нужно от 1 до 5 фото.', referenceKeyboard());
  if (s.stage !== 'prompt') return ctx.reply('Выбери режим в главном меню:', menu());
  const prompt = ctx.message.text.trim();
  if (prompt.length < 3 || prompt.length > 4000) return ctx.reply('Промпт должен содержать от 3 до 4000 символов.');
  await generate(ctx, s, prompt);
});
bot.catch(err => console.error('Telegram handler error:', err));
await bot.launch();
console.log('Telegram image bot started');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
