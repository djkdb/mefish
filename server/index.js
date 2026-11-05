// 찌멍 · 찜멍 실시간 서버
// - Worker 하나가 화면 파일(sites/<이름>/)과 실시간 연결(/ws)을 함께 맡아요.
//   찌멍(jjimeong)·찜멍(jjimmung)·놀멍(nolmeong)은 같은 서버 코드로 따로 배포해요 (wrangler.<이름>.jsonc).
// - 방 하나 = Durable Object 하나. WebSocket Hibernation API를 써서
//   아무도 말을 안 보낼 때는 잠들어 있어요(무료 플랜 친화적).
// - 한 방에 30명이 차면 다음 방으로 자동 배정. ?room=이름 이면 그 방으로.
import { DurableObject } from 'cloudflare:workers';

const CAP = 30;
const MAX_AUTO_ROOMS = 50;
const MAX_MSG = 1500;
const roomHint = {}; // 이 Worker 인스턴스가 기억하는 "최근 자리가 있던 방" (best-effort)
const RATE_WINDOW = 5000, RATE_MAX = 60; // 5초에 60개(초당 12개) 넘게 보내면 끊어요

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 예전 주소(하나로 합쳐져 있던 시절) → 새 주소로 안내
    if (url.pathname.startsWith('/fishing')) return Response.redirect(new URL('/' + url.search, url), 301);
    if (url.pathname.startsWith('/jjimjilbang') && env.JJIM_URL) return Response.redirect(env.JJIM_URL, 301);
    if (url.pathname === '/board') return board(request, env, url);
    if (url.pathname !== '/ws') return env.ASSETS.fetch(request);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 전용 주소예요', { status: 426 });

    // 이 Worker 가 맡는 장소들 (wrangler 설정의 vars.SITES)
    const sites = String(env.SITES || 'lake').split(',');
    const site = sites.includes(url.searchParams.get('site')) ? url.searchParams.get('site') : sites[0];
    const named = (url.searchParams.get('room') || '').normalize('NFC').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);

    if (named) {
      const res = await roomStub(env, `${site}:r:${named}`).fetch(withRoom(request, named));
      return res.status === 409 ? new Response('이 방은 꽉 찼어요', { status: 409 }) : res;
    }
    // 자동 배정: 최근에 자리가 있던 방부터 찾아요 (꽉 찬 방을 매번 1번부터 두드리면
    // 그만큼 Durable Object 요청이 늘어 무료 한도를 빨리 써요). 가끔은 앞 방이 비었는지 다시 봐요.
    const hint = Math.random() < 0.15 ? 1 : (roomHint[site] || 1);
    for (let k = 0; k < MAX_AUTO_ROOMS; k++) {
      const i = ((hint - 1 + k) % MAX_AUTO_ROOMS) + 1;
      const res = await roomStub(env, `${site}:auto:${i}`).fetch(withRoom(request, String(i)));
      if (res.status !== 409) { roomHint[site] = i; return res; }
      if (k >= 12) break; // 너무 많이 두드리지 않기
    }
    return new Response('모든 방이 꽉 찼어요', { status: 503 });
  },
};

const roomStub = (env, name) => env.ROOMS.get(env.ROOMS.idFromName(name));

/* ---------------- 오늘의 랭킹 (/board) ----------------
   GET  /board?site=lake&kind=big&id=<내 id>          → { date, kind, top:[{n,v,x}], me:{rank,v}|null }
   POST /board  {site, kind, id, name, v, x}           → 같은 형식 (내 기록이 더 좋을 때만 갱신)
   - 한국 시간 하루 단위(자정 초기화). 종류마다 Durable Object 하나(site:kind:날짜).
   - 무료 한도 절약: 클라이언트는 개인 최고를 넘었을 때만 POST, 랭킹 창을 열 때만 GET.
   - 점수는 클라이언트가 보내는 값이라 완벽히 막을 수는 없어요. 범위·횟수만 제한해요. */
const BOARD_KINDS = {
  lake: { big: [1, 200], count: [1, 500] },        // 오늘 가장 큰 물고기(cm, x=어종) · 오늘 낚은 마릿수
  ice:  { big: [1, 200], smelt: [1, 2000] },       // 가장 큰 물고기 · 빙어 마릿수
  jjim: { char: [1, 3600], sweat: [1, 86400], egg: [1, 1000] }, // 숯가마 버티기(초) · 오늘 땀(초) · 계란
  park: { shoot: [1, 5000], bump: [1, 500], rides: [1, 300] },  // 사격 점수 · 범퍼카 박기 · 오늘 탄 놀이기구 수
};
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
async function board(request, env, url) {
  const sites = String(env.SITES || 'lake').split(',');
  let q;
  if (request.method === 'POST') { try { q = await request.json(); } catch { return json({ error: 'bad json' }, 400); } }
  else if (request.method === 'GET') q = Object.fromEntries(url.searchParams);
  else return json({ error: 'method' }, 405);
  const site = sites.includes(q.site) ? q.site : null, kinds = site && BOARD_KINDS[site];
  if (!kinds || !kinds[q.kind]) return json({ error: 'unknown board' }, 400);
  const date = kstDate();
  const stub = env.BOARDS.get(env.BOARDS.idFromName(`${site}:${q.kind}:${date}`));
  return stub.fetch(new Request('https://board/', { method: 'POST', body: JSON.stringify({ ...q, op: request.method === 'POST' ? 'put' : 'get', range: kinds[q.kind], date }) }));
}

export class Board extends DurableObject {
  async fetch(request) {
    const q = await request.json();
    const id = /^[a-z0-9]{8,32}$/i.test(String(q.id || '')) ? String(q.id) : null;
    let e = (await this.ctx.storage.get('e')) || {};
    if (q.op === 'put') {
      const v = Number(q.v), [lo, hi] = q.range;
      if (!id || !Number.isFinite(v) || v < lo || v > hi) return json({ error: 'bad value' }, 400);
      const cur = e[id], now = Date.now();
      if (cur && now - cur.t < 3000) return json({ error: 'slow down' }, 429);
      if (!cur || v > cur.v) {
        e[id] = { n: cleanName(q.name), v: Math.round(v * 10) / 10, x: String(q.x || '').normalize('NFC').replace(/[\u0000-\u001f<>]/g, '').slice(0, 16), t: now };
        // 너무 커지지 않게 상위 300명만 보관
        const keys = Object.keys(e);
        if (keys.length > 300) { keys.sort((a, b) => e[b].v - e[a].v).slice(300).forEach(k => delete e[k]); }
        await this.ctx.storage.put('e', e);
      } else if (cur) { cur.t = now; }
    }
    const all = Object.entries(e).sort((a, b) => b[1].v - a[1].v || a[1].t - b[1].t);
    const top = all.slice(0, 10).map(([, r]) => ({ n: r.n, v: r.v, x: r.x }));
    const i = id ? all.findIndex(([k]) => k === id) : -1;
    return json({ date: q.date, kind: q.kind, top, me: i >= 0 ? { rank: i + 1, v: all[i][1].v } : null, total: all.length });
  }
}
function withRoom(request, room) {
  const u = new URL(request.url);
  u.searchParams.set('roomName', room);
  return new Request(u, request);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new Map(); // 연결별 메시지 수 (메모리, 잠들면 초기화돼도 괜찮음)
    // 연결 유지용 ping 은 Durable Object 를 깨우지 않고 자동 응답
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (this.ctx.getWebSockets().length >= CAP) return new Response('full', { status: 409 });
    const room = new URL(request.url).searchParams.get('roomName') || '1';
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), room, name: null, look: null, s: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    // 도배 방지: 비정상적으로 많이 보내는 연결은 끊어요
    const now = Date.now(), r = this.rate.get(ws) || { t: now, n: 0 };
    if (now - r.t > RATE_WINDOW) { r.t = now; r.n = 0; }
    r.n++; this.rate.set(ws, r);
    if (r.n > RATE_MAX) { this.rate.delete(ws); try { ws.close(4008, 'too many messages'); } catch { } this.leave(ws); return; }
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment();
    if (!a) return;

    if (m.t === 'hello') {
      a.name = cleanName(m.name);
      a.look = isObj(m.look) ? m.look : null;
      a.s = isObj(m.s) ? m.s : null;
      ws.serializeAttachment(a);
      const peers = [];
      for (const o of this.ctx.getWebSockets()) {
        if (o === ws) continue;
        const b = o.deserializeAttachment();
        if (b?.name) peers.push({ id: b.id, name: b.name, look: b.look, s: b.s });
      }
      send(ws, { t: 'welcome', id: a.id, room: a.room, peers, n: peers.length + 1 });
      this.broadcast({ t: 'join', id: a.id, name: a.name, look: a.look, s: a.s }, ws);
      this.broadcastCount();
      return;
    }
    if (!a.name) return; // hello 전에는 무시
    if (m.t === 's' && isObj(m.s)) {
      a.s = m.s;
      ws.serializeAttachment(a); // 새로 들어온 사람에게 마지막 위치를 알려주기 위해 저장
      this.broadcast({ t: 's', id: a.id, s: m.s }, ws);
    } else if (m.t === 'ev' && isObj(m.e)) {
      this.broadcast({ t: 'ev', id: a.id, e: m.e }, ws);
    }
  }

  async webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { }
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    this.rate.delete(ws);
    const a = ws.deserializeAttachment();
    if (a?.name) this.broadcast({ t: 'leave', id: a.id }, ws);
    this.broadcastCount(ws);
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const o of this.ctx.getWebSockets()) {
      if (o === except) continue;
      try { o.send(s); } catch { }
    }
  }

  broadcastCount(except) {
    const live = this.ctx.getWebSockets().filter(o => o !== except && o.readyState === WebSocket.OPEN && o.deserializeAttachment()?.name);
    const s = JSON.stringify({ t: 'count', n: live.length });
    for (const o of live) { try { o.send(s); } catch { } }
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { } };
function cleanName(n) {
  const s = String(n || '').normalize('NFC').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || '손님';
}
