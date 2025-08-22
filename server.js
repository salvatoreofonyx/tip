// Streamlabs -> StreamElements tip bridge (THB-first), with debug + fallbacks
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const MODE = (process.env.MODE || 'socket').toLowerCase(); // 'socket' or 'webhook'
const PORT = process.env.PORT || 3000;

const SE_JWT = process.env.SE_JWT;               // StreamElements JWT (Owner token from SE)
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID; // StreamElements channel _id (hex string)
if (!SE_JWT || !SE_CHANNEL_ID) {
  console.error('Missing SE_JWT or SE_CHANNEL_ID environment variables. Exiting.');
  process.exit(1);
}
const SE_TIPS_URL = `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`;
const SE_ME_URL   = `https://api.streamelements.com/kappa/v2/channels/me`;

const ONLY_THB = String(process.env.FORWARD_ONLY_THB || 'true').toLowerCase() === 'true';

const app = express();
app.use(express.json());

/* ---------------- Currency conversion (to THB) ---------------- */
let ratesCache = { ts: 0, base: 'THB', rates: { THB: 1 } };
// Simple converter that fetches rates if needed (exchangerate.host)
async function toTHB(amount, currency) {
  const cur = (currency || 'THB').toUpperCase();
  if (cur === 'THB') return Number(amount || 0);

  const now = Date.now();
  if (now - ratesCache.ts > 60 * 60 * 1000) { // refresh hourly
    try {
      const r = await axios.get('https://api.exchangerate.host/latest?base=THB');
      if (r.data && r.data.rates) {
        ratesCache = { ts: now, base: 'THB', rates: r.data.rates };
      }
    } catch (e) {
      console.warn('[FX] rate fetch failed, using stale/1:1 fallback:', e.message);
    }
  }
  // amount in THB = amount / (rate for currency vs THB)
  const rateTHBtoCUR = ratesCache.rates[cur];
  if (!rateTHBtoCUR || !Number(rateTHBtoCUR)) {
    console.warn(`[FX] unknown currency ${cur}, passing raw amount as THB.`);
    return Number(amount || 0);
  }
  return Number(amount) / Number(rateTHBtoCUR);
}

/* ---------------- Utils ---------------- */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function sanitizeName(name) {
  const raw = String(name || 'Anonymous').trim();
  // keep letters, digits, space, underscore, dash; strip exotic glyphs
  const ascii = raw.replace(/[^\w \-]/g, '');
  const trimmed = (ascii || 'Anonymous').slice(0, 25);
  return trimmed || 'Anonymous';
}

/* ---------- Core: forward to StreamElements (with fallbacks) ---------- */
async function forwardToSEBase(payload, tag='primary') {
  const res = await axios.post(SE_TIPS_URL, payload, {
    headers: { Authorization: `Bearer ${SE_JWT}`, 'Content-Type': 'application/json' },
    timeout: 10000
  });
  console.log(`[SE] ${tag} OK -> ${res.status}`, res.data && res.data._id ? `tipId=${res.data._id}` : '');
  return res.data;
}

async function forwardToSE({ username='Anonymous', amount=0, currency='THB', message='' }) {
  // Always send to SE in THB (this is the most stable path)
  let amtTHB = amount;
  let cur = String(currency || 'THB').toUpperCase();
  if (cur !== 'THB') {
    amtTHB = await toTHB(amount, cur);
    cur = 'THB';
  }
  amtTHB = Math.max(0, round2(amtTHB));

  // Prepare the safest payload first (no provider field)
  let payload = {
    username: sanitizeName(username),
    amount: amtTHB,
    currency: 'THB',
    message: String(message || '')
  };

  try {
    return await forwardToSEBase(payload, 'primary');
  } catch (err) {
    const data = err.response ? err.response.data : err.message;
    const status = err.response ? err.response.status : 'no-status';
    console.error('[SE] primary failed:', status, data);

    // Fallback A: empty message (some rare unicode combos can blow up)
    try {
      const payloadA = { ...payload, message: '' };
      return await forwardToSEBase(payloadA, 'fallbackA-emptyMessage');
    } catch (eA) {
      console.error('[SE] fallbackA failed:', eA.response ? eA.response.status : 'no-status', eA.response ? eA.response.data : eA.message);
    }

    // Fallback B: ultra-sanitized ASCII username
    try {
      const payloadB = { ...payload, username: sanitizeName(payload.username) };
      return await forwardToSEBase(payloadB, 'fallbackB-sanitizedName');
    } catch (eB) {
      console.error('[SE] fallbackB failed:', eB.response ? eB.response.status : 'no-status', eB.response ? eB.response.data : eB.message);
    }

    // Fallback C: tiny amount + generic name (to detect if payload shape is the issue)
    try {
      const payloadC = { username: 'Guest', amount: 10, currency: 'THB', message: '' };
      return await forwardToSEBase(payloadC, 'fallbackC-probe');
    } catch (eC) {
      console.error('[SE] fallbackC failed:', eC.response ? eC.response.status : 'no-status', eC.response ? eC.response.data : eC.message);
    }

    throw err; // bubble up original
  }
}

/* ---------------- WEBHOOK mode (optional) ---------------- */
app.post('/webhook/streamlabs', async (req, res) => {
  try {
    console.log('[WEBHOOK] incoming body:', req.body);
    const body = req.body || {};
    const username = body.name || body.username || body.donor || 'Anonymous';
    const amount = Number(body.amount || body.data?.amount || body.donation?.amount || 0);
    const currency = (body.currency || body.data?.currency || 'THB').toUpperCase();
    const message = body.message || body.note || '';

    if (ONLY_THB && currency !== 'THB') {
      console.log(`[WEBHOOK] converting ${amount} ${currency} -> THB`);
    }
    await forwardToSE({ username, amount, currency, message });
    res.status(200).send({ ok: true });
  } catch (e) {
    console.error('[WEBHOOK] error', e.response ? e.response.data : e.message);
    res.status(500).send({ ok: false, error: String(e.message || e) });
  }
});

/* ---------------- SOCKET mode (Streamlabs) ---------------- */
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
  const seen = new Set(); // dedupe

  socket.on('connect', () => console.log('[SOCKET] connected'));
  socket.on('disconnect', () => console.log('[SOCKET] disconnected'));
  socket.on('connect_error', (err) => console.error('[SOCKET] connect_error', err && err.message));

  socket.on('event', async (evt) => {
    try {
      if (!evt) return;

      let donations = [];
      if (Array.isArray(evt.message)) donations = evt.message;
      else if (evt.type === 'donation' && evt.message) donations = [evt.message];

      for (const d of donations) {
        const id = String(d.donation_id || d.id || `${d.name}-${d.amount}-${d.currency}-${Date.now()}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);

        const username = d.name || d.display_name || d.username || 'Anonymous';
        const amount = Number(d.amount || d.amount_paid || 0);
        const currency = (d.currency || 'THB').toUpperCase();
        const message = d.message || d.note || '';

        console.log(`[SOCKET] donation ${amount} ${currency} from ${username}`);

        if (ONLY_THB && currency !== 'THB') {
          console.log('[SOCKET] will convert non-THB to THB before forwarding');
        }
        await forwardToSE({ username, amount, currency, message });
      }
    } catch (e) {
      console.error('[SOCKET] handler error', e);
    }
  });
}

/* ---------------- Debug helpers ---------------- */
app.get('/debug/se', async (req, res) => {
  try {
    const info = await axios.get(SE_ME_URL, {
      headers: { Authorization: `Bearer ${SE_JWT}` },
      timeout: 10000
    });
    const chan = info.data || {};
    res.json({
      ok: true,
      note: 'Use _id for SE_CHANNEL_ID',
      your_channel_id_from_env: SE_CHANNEL_ID,
      se_me_response_sample: {
        _id: chan._id,
        provider: chan.provider,
        channel: chan.channel,
        channel_id: chan.channel_id,
        username: chan.username,
        currency: chan.currency
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response ? e.response.data : e.message });
  }
});

app.get('/', (req, res) => res.send(`Tip bridge running. MODE=${MODE}`));

app.listen(PORT, () => console.log(`Server listening on ${PORT} (MODE=${MODE})`));
