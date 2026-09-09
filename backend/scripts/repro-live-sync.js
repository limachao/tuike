// 临时排查脚本：复现「直播中的课」同步听课记录报错
const crypto = require('crypto');
const fs = require('fs');

const env = {};
fs.readFileSync('.env', 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const APP_ID = env.FEICE_APP_ID;
const APP_SECRET = env.FEICE_APP_SECRET;
const BASE = 'https://scrm.gzfeice.com/api';

function sign(all) {
  const src = Object.keys(all).sort().map((k) => `${k}=${all[k]}`).join('');
  return crypto.createHmac('sha256', APP_SECRET).update(src, 'utf8').digest('hex');
}

async function call(path, extra = {}) {
  const all = {
    appId: APP_ID,
    ts: String(Date.now()),
    nonce: Math.random().toString(36).slice(2, 12),
    ...extra,
  };
  all.sign = sign({ ...all });
  const qs = Object.keys(all).map((k) => `${k}=${encodeURIComponent(all[k])}`).join('&');
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  console.log(`\n===== ${path} → HTTP ${res.status} =====`);
  console.log('Content-Type:', res.headers.get('content-type'));
  console.log('BODY:', JSON.stringify(text.slice(0, 400)));
  return text;
}

(async () => {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  // 1) 直播间列表
  const raw = await call('/live-manage/open/live-room/list', {
    startTime: String(sevenDaysAgo),
    offset: '0',
  });
  let rooms = [];
  try { rooms = JSON.parse(raw).data?.list ?? JSON.parse(raw).data ?? []; } catch {}
  if (!Array.isArray(rooms)) rooms = [];
  const live = rooms.find((r) => (r.liveName || r.name || '').includes('测试') || String(r.status) === '1' || String(r.liveStatus) === '1');
  const target = live || rooms[0];
  if (!target) { console.log('\n未找到直播间'); return; }
  console.log(`\n>>> 目标直播间: id=${target.id} name=${target.liveName ?? target.name} status=${target.status ?? target.liveStatus}`);

  const liveRoomId = String(target.id);
  const enterClassTime = String(sevenDaysAgo);
  const exitTime = String(sevenDaysAgo);

  // 2) 直播听课记录
  await call('/live-manage/open/class-record/list', {
    enterClassTime,
    offset: '0',
    liveRoomId,
  });

  // 3) 回放观看记录
  await call('/live-manage/open/live-playback-record/list', {
    exitTime,
    offset: '0',
    liveRoomId,
  });

  // 4) 邀课记录
  await call('/live-manage/open/invitation-record/list', {
    appointmentTime: String(sevenDaysAgo),
    offset: '0',
    liveRoomId,
  });
})();
