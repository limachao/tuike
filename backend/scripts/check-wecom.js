/**
 * 临时诊断脚本：排查企微客户同步 60011 权限问题
 * 用法（容器内）：node scripts/check-wecom.js
 * 1. 拉取配置了客户联系功能的成员列表（follow_user）
 * 2. 对比系统内销售绑定的 wecomUserId 是否在其中
 * 3. 对在范围内的 userid 试拉客户列表
 */
const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const corpId = process.env.WECOM_CORP_ID;
  const secret = process.env.WECOM_CONTACT_SECRET;
  if (!corpId || !secret) {
    console.error('缺少 WECOM_CORP_ID / WECOM_CONTACT_SECRET');
    process.exit(1);
  }

  // 1. 获取 access_token
  const tok = await get(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`,
  );
  if (tok.errcode) {
    console.log('获取 token 失败：', JSON.stringify(tok));
    process.exit(1);
  }
  const token = tok.access_token;
  console.log('token 获取成功（说明 secret/IP 白名单正常）\n');

  // 2. 客户联系可用成员列表
  const fu = await get(
    `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get_follow_user_list?access_token=${token}`,
  );
  console.log('get_follow_user_list 返回：errcode =', fu.errcode, 'errmsg =', fu.errmsg || 'ok');
  const followUsers = fu.follow_user || [];
  console.log('配置了客户联系功能的成员（' + followUsers.length + '个）：', JSON.stringify(followUsers));
  console.log('');

  // 3. 查系统内销售绑定的 userid
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const sales = await prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true, name: true, role: true, wecomUserId: true },
  });
  console.log('系统内销售账号绑定情况：');
  for (const s of sales) {
    const bound = s.wecomUserId || '(未绑定)';
    const inScope = s.wecomUserId && followUsers.includes(s.wecomUserId);
    console.log(
      `  - ${s.name} [${s.role}] userid=${bound} => ${
        !s.wecomUserId ? '未绑定' : inScope ? '✅ 在客户联系范围内' : '❌ 不在范围内（这就是60011的原因）'
      }`,
    );
  }
  console.log('');

  // 4. 对在范围内的成员试拉客户
  for (const s of sales) {
    if (!s.wecomUserId || !followUsers.includes(s.wecomUserId)) continue;
    const r = await get(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/list?access_token=${token}&userid=${encodeURIComponent(s.wecomUserId)}`,
    );
    const n = Array.isArray(r.external_userid) ? r.external_userid.length : 0;
    console.log(`试拉 ${s.name} 的客户：errcode=${r.errcode} 客户数=${n}`);
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('脚本异常：', e.message);
  process.exit(1);
});
