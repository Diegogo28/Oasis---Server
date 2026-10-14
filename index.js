// Servidor de Oasis. Node 18 o superior, sin dependencias externas.
//
// Variables de entorno
//   STEAM_API_KEY  (obligatoria)  clave de la API de Steam
//   PUBLIC_URL     (obligatoria en linea)  direccion publica, ej. https://oasis-server.onrender.com
//   XBL_APP_KEY    (para Xbox)    clave publica de tu "Xbox App" en OpenXBL
//   XBL_AUTH_URL   (opcional)     por defecto https://xbl.io/app/auth
//   XBL_CLAIM_URL  (opcional)     por defecto https://xbl.io/app/claim
//   XBL_API_BASE   (opcional)     por defecto prueba https://api.xbl.io/v2 y luego https://xbl.io/api/v2
//   APP_SCHEME     (opcional)     esquema de la app, por defecto "oasis"
//   STEAM_API_BASE (opcional)     solo para pruebas
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const KEY = process.env.STEAM_API_KEY;
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STEAM = process.env.STEAM_API_BASE || 'https://api.steampowered.com';
const XBL_APP = process.env.XBL_APP_KEY;
const XBL_AUTH = process.env.XBL_AUTH_URL || 'https://xbl.io/app/auth';
const XBL_CLAIM = process.env.XBL_CLAIM_URL || 'https://xbl.io/app/claim';
const XBL_BASES = process.env.XBL_API_BASE ? [process.env.XBL_API_BASE] : ['https://api.xbl.io/v2', 'https://xbl.io/api/v2'];
const SCHEME = process.env.APP_SCHEME || 'oasis';

if (!KEY) { console.error('Falta STEAM_API_KEY'); process.exit(1); }

// ---------- utilidades ----------
const cache = new Map();      // consultas recientes (60 s) para no gastar limites de las APIs
const tickets = new Map();    // boletos de un solo uso para entregar la clave de Xbox a la app
const hits = new Map();       // limite sencillo de solicitudes por IP

const getCached = (k) => { const c = cache.get(k); return c && c.exp > Date.now() ? c.val : null; };
const setCached = (k, val) => { cache.set(k, { val, exp: Date.now() + 60000 }); if (cache.size > 500) cache.clear(); };

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 60;
}

const unwrap = (o) => (o && o.content ? o.content : o);
const send = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};
const appUrl = (app) => (/^(oasis|exp|exps):\/\//.test(app || '') ? app : `${SCHEME}://auth`);
const withParam = (url, k, v) => `${url}${url.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

// ---------- Steam ----------
async function steam(id) {
  const hit = getCached('s' + id);
  if (hit) return hit;
  const [p, o] = await Promise.all([
    getJson(`${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${id}`),
    getJson(`${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${KEY}&steamid=${id}&include_appinfo=1&include_played_free_games=1`),
  ]);
  const pl = (p.response.players || [])[0];
  if (!pl) { const e = new Error('Perfil no encontrado'); e.status = 404; throw e; }
  const owned = (o.response.games || []).sort((a, b) => b.playtime_forever - a.playtime_forever);
  // Logros solo de los 12 juegos mas jugados, para limitar el numero de consultas.
  const ach = {};
  await Promise.all(owned.slice(0, 12).map(async (g) => {
    try {
      const a = await getJson(`${STEAM}/ISteamUserStats/GetPlayerAchievements/v1/?key=${KEY}&steamid=${id}&appid=${g.appid}`);
      const l = a.playerstats.achievements || [];
      ach[g.appid] = [l.filter((x) => x.achieved).length, l.length];
    } catch (e) { /* juego sin logros o datos privados */ }
  }));
  const games = owned.map((g) => ({
    id: 's' + g.appid, name: g.name, platform: 'steam', hours: Math.round(g.playtime_forever / 60),
    achEarned: (ach[g.appid] || [0, 0])[0], achTotal: (ach[g.appid] || [0, 0])[1],
    cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
  }));
  const out = { games, now: pl.gameextrainfo ? { name: pl.gameextrainfo, platform: 'steam' } : null, avatar: pl.avatarfull };
  setCached('s' + id, out);
  return out;
}

// ---------- Xbox (OpenXBL, servicio de terceros) ----------
async function xblGet(path, key) {
  let last;
  for (const base of XBL_BASES) {
    try {
      return unwrap(await getJson(base + path, { 'X-Authorization': key, 'X-Contract': '100', Accept: 'application/json' }));
    } catch (e) {
      last = e;
      if (e.status === 401 || e.status === 403) break;   // clave invalida: no tiene caso probar otra direccion
    }
  }
  throw last;
}

// OJO: la forma exacta de las respuestas de OpenXBL no se pudo verificar; el mapeo es defensivo.
// Las horas jugadas de Xbox no se obtienen (se muestran como "—" en la app).
async function xbox(key) {
  const hit = getCached('x' + key.slice(0, 12));
  if (hit) return hit;
  const [a, acc] = await Promise.all([xblGet('/achievements', key), xblGet('/account', key).catch(() => null)]);
  const games = ((a && a.titles) || []).map((t) => ({
    id: 'x' + t.titleId, name: t.name, platform: 'xbox', hours: null,
    achEarned: (t.achievement || {}).currentAchievements || 0, achTotal: (t.achievement || {}).totalAchievements || 0,
    cover: t.displayImage,
  }));
  let avatar = null;
  try {
    const s = acc.profileUsers[0].settings.find((x) => x.id === 'GameDisplayPicRaw');
    avatar = s && s.value;
  } catch (e) { /* sin foto */ }
  const out = { games, avatar };
  setCached('x' + key.slice(0, 12), out);
  return out;
}

// ---------- servidor ----------
http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const u = new URL(req.url, BASE);
  try {
    if (u.pathname === '/' || u.pathname === '/health') return send(res, 200, { ok: true, servicio: 'oasis' });
    if (limited(ip)) return send(res, 429, { error: 'demasiadas solicitudes' });

    // Steam: inicio de sesion oficial (OpenID).
    if (u.pathname === '/auth/steam') {
      const app = appUrl(u.searchParams.get('app'));
      const p = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
        'openid.return_to': withParam(`${BASE}/auth/steam/return`, 'app', app), 'openid.realm': BASE,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      });
      res.writeHead(302, { Location: 'https://steamcommunity.com/openid/login?' + p });
      return res.end();
    }
    if (u.pathname === '/auth/steam/return') {
      const app = appUrl(u.searchParams.get('app'));
      const body = new URLSearchParams();
      u.searchParams.forEach((v, k) => { if (k.startsWith('openid.')) body.set(k, v); });
      body.set('openid.mode', 'check_authentication');
      const r = await fetch(process.env.STEAM_OPENID_URL || 'https://steamcommunity.com/openid/login', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      const ok = (await r.text()).includes('is_valid:true');
      const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(u.searchParams.get('openid.claimed_id') || '');
      if (!ok || !m) { res.statusCode = 401; return res.end('Inicio de sesion no valido'); }
      res.writeHead(302, { Location: withParam(app, 'steamid', m[1]) });
      return res.end();
    }

    // Xbox: inicio de sesion mediante OpenXBL.
    if (u.pathname === '/auth/xbox') {
      if (!XBL_APP) return send(res, 503, { error: 'Falta XBL_APP_KEY' });
      res.writeHead(302, { Location: `${XBL_AUTH}/${XBL_APP}` });
      return res.end();
    }
    if (u.pathname === '/auth/xbox/return') {
      const code = u.searchParams.get('code');
      if (!XBL_APP || !code) { res.statusCode = 400; return res.end('Solicitud no valida'); }
      const r = await fetch(XBL_CLAIM, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, app_key: XBL_APP }),
      });
      if (!r.ok) { res.statusCode = 401; return res.end('No se pudo validar el inicio de sesion de Xbox'); }
      const j = unwrap(await r.json());
      const key = j && (j.app_key || j.key);
      if (!key) { res.statusCode = 502; return res.end('Respuesta inesperada de OpenXBL'); }
      const t = crypto.randomBytes(24).toString('hex');
      tickets.set(t, { key, exp: Date.now() + 120000 });
      res.writeHead(302, { Location: withParam(`${SCHEME}://auth`, 'ticket', t) });
      return res.end();
    }
    // La app canjea el boleto (una sola vez) por la clave del usuario.
    let m = /^\/auth\/ticket\/([a-f0-9]{48})$/.exec(u.pathname);
    if (m) {
      const t = tickets.get(m[1]);
      tickets.delete(m[1]);
      if (!t || t.exp < Date.now()) return send(res, 410, { error: 'boleto vencido' });
      return send(res, 200, { key: t.key });
    }

    // Datos.
    m = /^\/api\/steam\/(\d{17})$/.exec(u.pathname);
    if (m) return send(res, 200, await steam(m[1]));
    if (u.pathname === '/api/xbox') {
      const key = req.headers['x-xbl-key'];
      if (!key || !/^[\w-]{10,200}$/.test(key)) return send(res, 401, { error: 'falta la clave de Xbox' });
      return send(res, 200, await xbox(key));
    }
    return send(res, 404, { error: 'no encontrado' });
  } catch (e) {
    return send(res, e.status === 404 || e.status === 401 ? e.status : 502, { error: e.message });
  }
}).listen(PORT, () => console.log('Servidor de Oasis en el puerto ' + PORT));
