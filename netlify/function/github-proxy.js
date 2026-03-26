// ════════════════════════════════════════════════════════
//  Netlify Function: github-proxy.js
//  Il token GitHub non è mai visibile nel browser.
//  Viene letto dalla variabile d'ambiente GITHUB_TOKEN
//  impostata nel pannello Netlify (Site configuration →
//  Environment variables).
// ════════════════════════════════════════════════════════

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_REPO;
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD;

// ── VALIDAZIONE CONFIGURAZIONE ──
// Verifica che GITHUB_REPO abbia il formato atteso "utente/repo"
// per prevenire injection nell'URL dell'API GitHub
const REPO_RE = /^[a-zA-Z0-9._-]{1,100}\/[a-zA-Z0-9._-]{1,100}$/;
const API_BASE = GITHUB_REPO && REPO_RE.test(GITHUB_REPO)
  ? `https://api.github.com/repos/${GITHUB_REPO}`
  : null;

// ── WHITELIST PATH ──
// Definisce esattamente quali path sono accessibili in lettura (GET)
// e dove è permessa la scrittura per tipo di operazione.
// Blocca path traversal e accesso a file non autorizzati.
const ALLOWED_GET_PATHS   = /^(games\.json|games\/[a-zA-Z0-9._\-_]{1,200})$/;
const ALLOWED_VOTE_PATH   = 'games.json';
const ALLOWED_UPLOAD_PRE  = 'games/';
const ALLOWED_REPORT_PRE  = 'reports/';
const SAFE_PATH_RE        = /^[a-zA-Z0-9._/-]{1,300}$/;

// ── LIMITI DIMENSIONE ──
const MAX_CONTENT_B64 = 7 * 1024 * 1024; // ~5 MB file + overhead base64
const MAX_MESSAGE_LEN = 200;
const MAX_BODY_BYTES  = 8 * 1024 * 1024; // 8 MB body totale

// ── RATE LIMITER IN MEMORIA ──
// Limita voti/segnalazioni: max 10 per IP ogni 15 minuti.
// Si resetta ad ogni cold start Netlify ma blocca burst in tempo reale.
const VOTE_LIMIT     = 10;
const VOTE_WINDOW_MS = 15 * 60 * 1000;
const voteLog        = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let ts = (voteLog.get(ip) || []).filter(t => now - t < VOTE_WINDOW_MS);
  if (ts.length >= VOTE_LIMIT) { voteLog.set(ip, ts); return true; }
  ts.push(now);
  voteLog.set(ip, ts);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of voteLog.entries()) {
    const fresh = ts.filter(t => now - t < VOTE_WINDOW_MS);
    if (!fresh.length) voteLog.delete(ip); else voteLog.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// ── CORS STRICT ──
// Impostare ALLOWED_ORIGIN nelle variabili d'ambiente Netlify con
// l'URL esatto del sito (es: https://tuosito.netlify.app).
// In assenza cade su '*' solo per sviluppo locale.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function corsHeaders(reqOrigin) {
  const ao = ALLOWED_ORIGIN === '*' ? (reqOrigin || '*') : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin':  ao,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary': 'Origin',
  };
}

function errResp(status, msg, origin) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg }),
  };
}

// Rimuove caratteri di controllo e tronca i commit message
function sanitizeMessage(msg) {
  return String(msg).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, MAX_MESSAGE_LEN);
}

// Verifica path sicuro: no traversal, no segmenti nascosti
function isSafePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (!SAFE_PATH_RE.test(p)) return false;
  if (p.split('/').some(s => s === '..' || s === '.' || s.startsWith('.'))) return false;
  return true;
}

// ── HANDLER ──
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') return errResp(405, 'Metodo non consentito.', origin);
  if (!GITHUB_TOKEN || !API_BASE)  return errResp(500, 'Configurazione server non valida.', origin);

  // Limite dimensione body
  if (event.body && Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
    return errResp(413, 'Request troppo grande.', origin);
  }

  let body;
  try   { body = event.body ? JSON.parse(event.body) : {}; }
  catch { return errResp(400, 'Body JSON non valido.', origin); }

  const { action } = body;

  // ── GET ──────────────────────────────────────────────
  if (action === 'get') {
    const { path } = body;
    if (!path || !ALLOWED_GET_PATHS.test(path) || !isSafePath(path)) {
      return errResp(400, 'Path non consentito.', origin);
    }
    try {
      const r = await fetch(`${API_BASE}/contents/${path}`, {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'JAM-Proxy/1.0',
        },
      });
      let data;
      try { data = await r.json(); }
      catch { return errResp(502, 'Risposta non valida da GitHub (GET).', origin); }
      return {
        statusCode: r.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    } catch { return errResp(502, 'Errore comunicazione GitHub.', origin); }
  }

  // ── PUT ──────────────────────────────────────────────
  if (action === 'put') {
    const { path, content, message, sha, password, type } = body;
    const isVote   = type === 'vote';
    const isReport = type === 'report';

    // Validazione path
    if (!path || typeof path !== 'string' || !isSafePath(path)) {
      return errResp(400, 'Path non valido.', origin);
    }

    // Whitelist path per tipo operazione
    if (isVote) {
      if (path !== ALLOWED_VOTE_PATH)
        return errResp(400, 'Path non consentito per voto.', origin);
    } else if (isReport) {
      if (!path.startsWith(ALLOWED_REPORT_PRE))
        return errResp(400, 'Path non consentito per segnalazione.', origin);
    } else {
      // Upload: password obbligatoria + path in games/ oppure games.json
      if (!UPLOAD_PASSWORD || password !== UPLOAD_PASSWORD)
        return errResp(403, 'Password errata.', origin);
      if (path !== ALLOWED_VOTE_PATH && !path.startsWith(ALLOWED_UPLOAD_PRE))
        return errResp(400, 'Path non consentito per upload.', origin);
    }

    // Validazione content
    if (!content || typeof content !== 'string')
      return errResp(400, 'content mancante.', origin);
    if (content.length > MAX_CONTENT_B64)
      return errResp(413, 'Contenuto troppo grande (max 5 MB).', origin);
    if (!/^[A-Za-z0-9+/\r\n]+=*$/.test(content))
      return errResp(400, 'content non è base64 valido.', origin);

    // Validazione message
    if (!message || typeof message !== 'string')
      return errResp(400, 'message mancante.', origin);
    const safeMsg = sanitizeMessage(message);

    // Rate limit voti/segnalazioni
    if (isVote || isReport) {
      const ip =
        (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        event.headers['client-ip'] || 'unknown';
      if (isRateLimited(ip)) {
        return {
          statusCode: 429,
          headers: { ...corsHeaders(origin), 'Retry-After': '900' },
          body: JSON.stringify({
            error: isReport
              ? 'Troppe segnalazioni. Riprova tra 15 minuti.'
              : 'Troppi voti. Riprova tra 15 minuti.',
          }),
        };
      }
    }

    // Scrittura su GitHub
    try {
      const ghBody = { message: safeMsg, content };
      // SHA: accettato solo se è un hex valido da 40 caratteri (SHA-1 Git)
      if (sha && typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)) {
        ghBody.sha = sha;
      }
      const r = await fetch(`${API_BASE}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'JAM-Proxy/1.0',
        },
        body: JSON.stringify(ghBody),
      });
      let data;
      try { data = await r.json(); }
      catch { return errResp(502, 'Risposta non valida da GitHub (PUT).', origin); }
      return {
        statusCode: r.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    } catch { return errResp(502, 'Errore comunicazione GitHub.', origin); }
  }

  // ── DELETE ──────────────────────────────────────────────
  if (action === 'delete') {
    const { path, sha, message, password } = body;

    // Solo con password valida
    if (!UPLOAD_PASSWORD || password !== UPLOAD_PASSWORD)
      return errResp(403, 'Password errata.', origin);

    // Validazione path
    if (!path || typeof path !== 'string' || !isSafePath(path))
      return errResp(400, 'Path non valido.', origin);

    // Solo file in games/ o games.json
    if (path !== ALLOWED_VOTE_PATH && !path.startsWith(ALLOWED_UPLOAD_PRE))
      return errResp(400, 'Path non consentito per eliminazione.', origin);

    // SHA obbligatorio per delete GitHub
    if (!sha || typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha))
      return errResp(400, 'SHA non valido o mancante.', origin);

    if (!message || typeof message !== 'string')
      return errResp(400, 'message mancante.', origin);
    const safeMsg = sanitizeMessage(message);

    try {
      const r = await fetch(`${API_BASE}/contents/${path}`, {
        method: 'DELETE',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'JAM-Proxy/1.0',
        },
        body: JSON.stringify({ message: safeMsg, sha }),
      });
      let data;
      try { data = await r.json(); }
      catch { return errResp(502, 'Risposta non valida da GitHub (DELETE).', origin); }
      return {
        statusCode: r.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    } catch { return errResp(502, 'Errore comunicazione GitHub.', origin); }
  }

  // Azione non riconosciuta — non rivela le azioni valide
  return errResp(400, 'Richiesta non valida.', origin);
};
