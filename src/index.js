// 찌멍 · 찜멍 실시간 서버
// - Worker 하나가 화면 파일(public/)과 실시간 연결(/ws)을 함께 맡아요.
// - 방 하나 = Durable Object 하나. WebSocket Hibernation API를 써서
//   아무도 말을 안 보낼 때는 잠들어 있어요(무료 플랜 친화적).
// - 한 방에 30명이 차면 다음 방으로 자동 배정. ?room=이름 이면 그 방으로.
import { DurableObject } from 'cloudflare:workers';

const SITES = new Set(['lake', 'ice', 'jjim']);
const CAP = 30;
const MAX_AUTO_ROOMS = 50;
const MAX_MSG = 1500;
const roomHint = {}; // 이 Worker 인스턴스가 기억하는 "최근 자리가 있던 방" (best-effort)
const RATE_WINDOW = 5000, RATE_MAX = 60; // 5초에 60개(초당 12개) 넘게 보내면 끊어요

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return env.ASSETS.fetch(request);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 전용 주소예요', { status: 426 });

    const site = SITES.has(url.searchParams.get('site')) ? url.searchParams.get('site') : 'lake';
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
