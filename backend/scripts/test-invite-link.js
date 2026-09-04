/**
 * 临时验证脚本：对指定直播间调用飞策邀课链接接口
 * 用法：node scripts/test-invite-link.js <liveRoomId>
 * 通过 stdin 注入容器运行：docker compose exec -T backend node - < scripts/test-invite-link.js 1639796
 */
const crypto = require('crypto');

const appId = process.env.FEICE_APP_ID;
const appSecret = process.env.FEICE_APP_SECRET;
const baseUrl = process.env.FEICE_BASE_URL || 'https://scrm.gzfeice.com/api';

function sign(params) {
  const source = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(source, 'utf8').digest('hex');
}

async function call(path, extra) {
  const ts = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2, 12);
  const all = { appId, ts, nonce, ...extra };
  all.sign = sign(all);
  const qs = Object.keys(all)
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  const url = `${baseUrl}${path}?${qs}`;
  console.log('>>> GET', path, JSON.stringify(extra));
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  console.log('<<< HTTP', res.status);
  console.log(text.slice(0, 2000));
  console.log('');
}

(async () => {
  const liveRoomId = process.argv[2] || '1639796';
  if (!appId || !appSecret) {
    console.error('缺少 FEICE_APP_ID / FEICE_APP_SECRET 环境变量');
    process.exit(1);
  }
  console.log('=== 邀课链接接口测试 liveRoomId=' + liveRoomId + ' ===\n');
  await call('/live-manage/open/invitation-link/list', {
    liveRoomId,
    mobile: '13800000000',
    thirdPartyTraceId: 'internal_test_001',
  });
})().catch((e) => {
  console.error('请求失败：', e.message);
  process.exit(1);
});
