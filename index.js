const express = require('express');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 181295399;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PRICE_NO_MAT = 500;
const PRICE_WITH_MAT = 700;
const PAY_TEXT = `Для подтверждения места переведите оплату по СБП:\n\n📱 89633771613\n🏦 Т-Банк\n👤 Нина Б.\n\nПосле оплаты отправьте сюда скриншот чека.`;

const https = require('https');
const states = {};

function telegram(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, keyboard) {
  const payload = { chat_id: chatId, text };
  if (keyboard) payload.reply_markup = keyboard;
  return telegram('sendMessage', payload);
}

function sendPhoto(chatId, photo, caption, keyboard) {
  const payload = { chat_id: chatId, photo, caption };
  if (keyboard) payload.reply_markup = keyboard;
  return telegram('sendPhoto', payload);
}

const { google } = require('googleapis');

async function addApplication(data) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: { values: [[new Date().toISOString(), data.userId, data.username, data.name, data.phone, data.option, data.amount, data.status, data.receipt]] }
  });
  const updatedRange = res.data.updates.updatedRange;
  return parseInt(updatedRange.match(/\d+$/)[0]);
}

async function updateStatus(row, status) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sheet1!H${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] }
  });
}

async function getClientId(row) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sheet1!B${row}`
  });
  return res.data.values[0][0];
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text || '';
  const username = msg.from.username || '';

  if (text === '/start' || text === '/register') {
    states[userId] = { step: 'name', username };
    await sendMessage(chatId, 'Привет 🌿\nЗапишем вас на йогу на Водной.\n\nКак вас зовут?');
    return;
  }

  const state = states[userId];
  if (!state) {
    await sendMessage(chatId, 'Нажмите /start, чтобы записаться на йогу 🌿');
    return;
  }

  if (state.step === 'name') {
    state.name = text;
    state.step = 'phone';
    await sendMessage(chatId, 'Укажите номер телефона:');
    return;
  }

  if (state.step === 'phone') {
    state.phone = text;
    state.step = 'option';
    await sendMessage(chatId, 'Выберите вариант участия:', {
      inline_keyboard: [
        [{ text: 'Без коврика — 500 ₽', callback_data: 'option_no_mat' }],
        [{ text: 'С арендой коврика — 700 ₽', callback_data: 'option_with_mat' }]
      ]
    });
    return;
  }

  if (state.step === 'receipt') {
    if (!msg.photo) {
      await sendMessage(chatId, 'Пожалуйста, отправьте именно скриншот/фото чека.');
      return;
    }
    const photo = msg.photo[msg.photo.length - 1].file_id;
    const row = await addApplication({
      userId, username: state.username || username,
      name: state.name, phone: state.phone,
      option: state.option, amount: state.amount,
      status: 'Ожидает подтверждения', receipt: photo
    });
    await sendPhoto(ADMIN_ID, photo,
      `🌿 Новая заявка\n\nИмя: ${state.name}\nТелефон: ${state.phone}\nВариант: ${state.option}\nСумма: ${state.amount} ₽\nUsername: @${state.username || username || 'нет'}\nСтрока: ${row}`,
      { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: 'confirm_' + row }], [{ text: '❌ Отклонить', callback_data: 'reject_' + row }]] }
    );
    await sendMessage(chatId, 'Спасибо 🌿\nЧек отправлен на проверку.');
    delete states[userId];
    return;
  }
}

async function handleCallback(q) {
  const data = q.data;
  const chatId = q.message.chat.id;
  const userId = String(q.from.id);

  if (data === 'option_no_mat' || data === 'option_with_mat') {
    const state = states[userId];
    if (!state) return;
    state.option = data === 'option_no_mat' ? 'Без коврика' : 'С арендой коврика';
    state.amount = data === 'option_no_mat' ? PRICE_NO_MAT : PRICE_WITH_MAT;
    state.step = 'receipt';
    await sendMessage(chatId, `Стоимость: ${state.amount} ₽\n\n${PAY_TEXT}`);
    await telegram('answerCallbackQuery', { callback_query_id: q.id });
    return;
  }

  if (data.startsWith('confirm_')) {
    const row = Number(data.replace('confirm_', ''));
    await updateStatus(row, 'Оплачено');
    const clientId = await getClientId(row);
    await sendMessage(clientId, '🌿 Оплата подтверждена!\n\nВы записаны на йогу на Водной станции.\n\nВремя и место будут направлены накануне в группе:\nSunday | Yoga | Coffee ☀️');
    await sendMessage(chatId, 'Оплата подтверждена ✅');
    await telegram('answerCallbackQuery', { callback_query_id: q.id });
    return;
  }

  if (data.startsWith('reject_')) {
    const row = Number(data.replace('reject_', ''));
    await updateStatus(row, 'Отклонено');
    const clientId = await getClientId(row);
    await sendMessage(clientId, 'К сожалению, оплату не удалось подтвердить. Напишите организатору.');
    await sendMessage(chatId, 'Заявка отклонена ❌');
    await telegram('answerCallbackQuery', { callback_query_id: q.id });
    return;
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.error(e);
    try { await sendMessage(ADMIN_ID, 'Ошибка: ' + e.message); } catch(err) {}
  }
});

app.get('/', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Bot started on port ' + PORT);
  await telegram('setWebhook', { url: process.env.WEBHOOK_URL + '/webhook', drop_pending_updates: true });
  console.log('Webhook set');
});
