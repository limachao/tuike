/**
 * 临时验证脚本：验证飞策邀课链接接口对已结束直播间的行为
 * 用法：node scripts/test-invite-link.js <liveRoomId> [mobile]
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
  // 中文转 unicode 转义输出，避免终端方块乱码
  const escaped = text.replace(/[\u007f-\uffff]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  console.log(escaped.slice(0, 3000));
  console.log('');
  try { return JSON.parse(text); } catch { return null; }
}

(async () => {
  const liveRoomId = process.argv[2] || '1639796';
  const givenMobile = process.argv[3];
  if (!appId || !appSecret) {
    console.error('缺少 FEICE_APP_ID / FEICE_APP_SECRET');
    process.exit(1);
  }
  const now = Date.now();
  const startTime = String(now - 29 * 24 * 3600 * 1000);

  if (givenMobile) {
    // 直接用指定手机号测试
    await call('/live-manage/open/invitation-link/list', {
      liveRoomId, mobile: givenMobile, thirdPartyTraceId: 'internal_test_002',
    });
    return;
  }

  // 第 1 步：查邀课记录，找真实学员标识
  console.log('=== 第1步：查询该直播间的邀课记录 ===\n');
  const rec = await call('/live-manage/open/invitation-record/list', {
    liveRoomId, offset: '0', startTime,
  });
  const recList = Array.isArray(rec?.data) ? rec.data : rec?.data?.list ?? [];
  console.log('邀课记录数量：', recList.length);
  if (recList[0]) console.log('第一条记录字段：', JSON.stringify(recList[0]).slice(0, 800), '\n');

  // 第 2 步：用记录里的真实手机号/userId 生成邀课链接
  const first = recList[0];
  const mobile = first?.mobile ?? first?.userMobile ?? first?.phone;
  const userId = first?.userId ?? first?.uid;
  if (!mobile && !userId) {
    console.log('!! 邀课记录里没有 mobile/userId 字段，请用真实手机号作为第2个参数重跑：node scripts/test-invite-link.js ' + liveRoomId + ' <真实手机号>');
    return;
  }
  console.log('=== 第2步：用真实学员生成邀课链接 (mobile=' + mobile + ', userId=' + userId + ') ===\n');
  const params = { liveRoomId, thirdPartyTraceId: 'internal_test_003' };
  if (userId) params.userId = String(userId);
  if (mobile) params.mobile = String(mobile);
  await call('/live-manage/open/invitation-link/list', params);
})().catch((e) => {
  console.error('请求失败：', e.message);
  process.exit(1);
});
