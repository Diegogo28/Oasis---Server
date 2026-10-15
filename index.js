// Servidor de Oasis. Node 18 o superior, sin dependencias externas.
//
// Variables de entorno
//   STEAM_API_KEY    (obligatoria)  clave de la API de Steam
//   PUBLIC_URL       (obligatoria en linea)  direccion publica, ej. https://oasis-server.onrender.com
//   XBL_PUBLIC_KEY   (para Xbox)    clave PUBLICA de tu app en OpenXBL (la que va en /app/auth/{publicKey})
//   XBL_APP_KEY      (para Xbox)    clave de la app que se envia al canjear el codigo (/app/claim);
//                                   si no existe se usa XBL_PUBLIC_KEY
//   XBL_BASE         (opcional)     por defecto https://api.xbl.io
//   APP_SCHEME       (opcional)     esquema de la app, por defecto "oasis"
//   STEAM_API_BASE   (opcional)     solo para pruebas
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const KEY = process.env.STEAM_API_KEY;
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STEAM = process.env.STEAM_API_BASE || 'https://api.steampowered.com';
const XBL = (process.env.XBL_BASE || 'https://api.xbl.io').replace(/\/$/, '');
const XBL_PUBLIC = process.env.XBL_PUBLIC_KEY || process.env.XBL_APP_KEY;
const XBL_SECRET = process.env.XBL_APP_KEY || process.env.XBL_PUBLIC_KEY;
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
// Respuestas segun la especificacion OpenAPI de OpenXBL: { content: {...}, code }.
async function xblGet(path, key) {
  return unwrap(await getJson(`${XBL}/v2${path}`, { 'X-Authorization': key, Accept: 'application/json' }));
}

// OpenXBL no entrega minutos jugados: las horas de Xbox quedan como null ("—" en la app).
async function xbox(key) {
  const ck = 'x' + key.slice(0, 12);
  const hit = getCached(ck);
  if (hit) return hit;
  const [t, acc, pres] = await Promise.all([
    xblGet('/titles', key),
    xblGet('/account', key).catch(() => null),
    xblGet('/presence', key).catch(() => null),
  ]);
  const games = ((t && t.titles) || []).filter((x) => !x.type || /game/i.test(x.type)).map((x) => {
    const a = x.achievement || {};
    const cur = a.currentAchievements || 0;
    let tot = a.totalAchievements || 0;
    // Xbox a veces informa total 0: se estima con el porcentaje de progreso.
    if (tot < cur) tot = a.progressPercentage > 0 ? Math.round((cur * 100) / a.progressPercentage) : cur;
    return { id: 'x' + x.titleId, name: x.name, platform: 'xbox', hours: null, achEarned: cur, achTotal: tot, cover: x.displayImage };
  });
  let avatar = null;
  try {
    const s2 = acc.profileUsers[0].settings.find((v) => v.id === 'GameDisplayPicRaw');
    avatar = s2 && s2.value;
  } catch (e) { /* sin foto */ }
  let now = null;
  try {
    for (const d of pres.devices || []) {
      for (const ti of d.titles || []) {
        if (!now && ti.state === 'Active' && ti.placement === 'Full' && ti.name && ti.name !== 'Home') now = { name: ti.name, platform: 'xbox' };
      }
    }
  } catch (e) { /* sin presencia */ }
  const out = { games, avatar, now };
  setCached(ck, out);
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
      if (!XBL_PUBLIC) return send(res, 503, { error: 'Falta XBL_PUBLIC_KEY' });
      res.writeHead(302, { Location: `${XBL}/app/auth/${XBL_PUBLIC}` });
      return res.end();
    }
    if (u.pathname === '/auth/xbox/return') {
      const code = u.searchParams.get('code');
      if (!XBL_SECRET || !code) { res.statusCode = 400; return res.end('Solicitud no valida'); }
      const r = await fetch(`${XBL}/app/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, app_key: XBL_SECRET }),
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
