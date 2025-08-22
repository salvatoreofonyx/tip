// Simple Streamlabs -> StreamElements forwarder
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const MODE = (process.env.MODE || 'socket').toLowerCase(); // 'socket' or 'webhook'
const PORT = process.env.PORT || 3000;

const SE_JWT = process.env.SE_JWT; // StreamElements JWT
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID; // StreamElements channel id (or account id)
if (!SE_JWT || !SE_CHANNEL_ID) {
  console.error('Missing SE_JWT or SE_CHANNEL_ID environment variables. Exiting.');
  process.exit(1);
}
const SE_TIPS_URL = `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`;

const app = express();
app.use(express.json());

/* ---- UTIL: forward to StreamElements ---- */
async function forwardToSE({ username='Anonymous', amount=0, currency='THB', message='' }) {
  try {
    const payload = {
      username,
      amount,
      currency,
      message,
      provider: 'streamlabs' // helps identify origin
    };
    const res = await axios.post(SE_TIPS_URL, payload, {
      headers: { Authorization: `Bearer ${SE_JWT}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`[SE] forwarded ${amount} ${currency} from ${username} -> ${res.status}`);
    return res.data;
  } catch (err) {
    console.error('[SE] forward error:', err.response ? err.response.data : err.message);
    throw err;
  }
}

/* ---- WEBHOOK mode endpoint (if you have a webhook provider) ---- */
app.post('/webhook/streamlabs', async (req, res) => {
  try {
    console.log('[WEBHOOK] incoming body:', req.body);
    // adjust these fields for the actual webhook format you receive
    const body = req.body || {};
    const username = body.name || body.username || body.donor || 'Anonymous';
    const amount = Number(body.amount || body.data?.amount || body.donation?.amount || 0);
    const currency = (body.currency || body.data?.currency || 'THB').toUpperCase();
    const message = body.message || body.note || '';

    await forwardToSE({ username, amount, currency, message });
    res.status(200).send({ ok: true });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e.message || e) });
  }
});

/* ---- SOCKET mode: connect to Streamlabs socket and listen for 'event' messages ---- */
if (MODE === 'socket') {
  const io = require('socket.io-client');
  const SL_SOCKET_TOKEN = process.env.SL_SOCKET_TOKEN;
  if (!SL_SOCKET_TOKEN) {
    console.error('MODE=socket but SL_SOCKET_TOKEN missing. Exiting.');
    process.exit(1);
  }
  const socketUrl = `https://sockets.streamlabs.com?token=${SL_SOCKET_TOKEN}`;
  console.log('[SOCKET] connecting to', socketUrl);

  const socket = io(socketUrl, { transports: ['websocket'] });

  const seen = new Set(); // basic dedupe

  socket.on('connect', () => console.log('[SOCKET] connected'));
  socket.on('disconnect', () => console.log('[SOCKET] disconnected'));
  socket.on('connect_error', (err) => console.error('[SOCKET] connect_error', err && err.message));

  // many Streamlabs socket examples emit 'event' messages
  socket.on('event', async (evt) => {
    try {
      if (!evt) return;
      // evt.type may be 'donation' and evt.message an array of donation objects
      // or evt.message could be an object depending on version — we handle both
      // Logging to inspect shape
      // console.log('[SOCKET] event', JSON.stringify(evt).slice(0,200));
      let donations = [];
      if (Array.isArray(evt.message)) donations = evt.message;
      else if (evt.type === 'donation' && evt.message) donations = [evt.message];
      else if (evt.type && evt.type === 'donation' && evt.message) donations = [evt.message];

      for (const d of donations) {
        // common fields: d.name, d.amount, d.currency, d.message, d.donation_id or d.id
        const id = String(d.donation_id || d.id || `${d.name}-${d.amount}-${d.currency}-${Date.now()}`);
        if (seen.has(id)) continue;
        seen.add(id);
        // keep set small
        if (seen.size > 5000) {
          const it = seen.values();
          seen.delete(it.next().value);
        }

        const username = d.name || d.display_name || d.username || 'Anonymous';
        const amount = Number(d.amount || d.amount_paid || 0);
        const currency = (d.currency || 'THB').toUpperCase();
        const message = d.message || d.note || '';

        console.log(`[SOCKET] donation ${amount} ${currency} from ${username}`);
        // Optional filters: only forward THB (set FORWARD_ONLY_THB=true)
        if (String((process.env.FORWARD_ONLY_THB || 'true')).toLowerCase() === 'true' && currency !== 'THB') {
          console.log('[SOCKET] skipping non-THB donation', currency);
          continue;
        }
        await forwardToSE({ username, amount, currency, message });
      }
    } catch (e) {
      console.error('[SOCKET] handler error', e);
    }
  });
}

/* ---- health route ---- */
app.get('/', (req, res) => res.send(`Tip bridge running. MODE=${MODE}`));

app.listen(PORT, () => console.log(`Server listening on ${PORT} (MODE=${MODE})`));
