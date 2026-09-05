import { useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import dayjs from 'dayjs';

type ListenFilter = 'all' | 'listened' | 'not_listened';

export default function CustomersPage() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [keyword, setKeyword] = useState('');
  const [listenFilter, setListenFilter] = useState<ListenFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** 分批渲染：先画 200 行，滚动到底部每次追加 300 行 */
  const [visibleCount, setVisibleCount] = useState(200);

  const load = async () => {
    try {
      const { data } = await api.get('/reminder/quick-send/customers');
      setCustomers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setCustomers([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { load(); }, []);

  const syncCustomers = async () => {
    setSyncing(true);
    try {
      await api.post('/wecom/sync/my-customers');
      alert('已开始从企业微信获取你的客户（学员较多时约需几分钟），稍后刷新本页查看。');
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '获取客户信息失败');
    } finally {
      setSyncing(false);
    }
  };

  const listened = useMemo(() => customers.filter((c) => (c.listenSec ?? 0) > 0), [customers]);

  /** 本地筛选：关键词（昵称/手机号）+ 听课状态（数据已一次性拉到本地） */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return customers.filter((c) => {
      if (listenFilter === 'listened' && (c.listenSec ?? 0) <= 0) return false;
      if (listenFilter === 'not_listened' && (c.listenSec ?? 0) > 0) return false;
      if (kw) {
        const nick = String(c.nickname ?? '').toLowerCase();
        const mobile = String(c.remarkMobiles ?? '');
        if (!nick.includes(kw) && !mobile.includes(kw)) return false;
      }
      return true;
    });
  }, [customers, keyword, listenFilter]);

  const listenCell = (sec: number) => {
    if (!sec || sec <= 0) return <span className="text-text-tertiary">未听课</span>;
    const min = Math.round(sec / 60);
    return (
      <span className="text-text-secondary tabular-nums">
        {min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}` : `${min} 分钟`}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-text-tertiary uppercase tracking-widest">My Customers</div>
          <h1 className="text-2xl font-semibold tracking-tight">客户信息</h1>
          <div className="text-sm text-text-secondary mt-1">
            你企业微信名下的所有客户 · 是否听过飞策课程 · 加入企微时间
          </div>
        </div>
        <button onClick={syncCustomers} disabled={syncing} className="btn-ghost">
          {syncing ? '↻ 获取中…' : '👤 获取我的客户信息'}
        </button>
      </div>

      {/* 统计 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="glass-card p-4">
          <div className="text-[11px] text-text-tertiary">我的客户总数</div>
          <div className="text-2xl font-semibold mt-1">{customers.length}</div>
        </div>
        <div className="glass-card p-4">
          <div className="text-[11px] text-text-tertiary">听过飞策课程</div>
          <div className="text-2xl font-semibold mt-1 text-brand-300">{listened.length}</div>
        </div>
        <div className="glass-card p-4">
          <div className="text-[11px] text-text-tertiary">还没听过课</div>
          <div className="text-2xl font-semibold mt-1 text-accent-amber">{customers.length - listened.length}</div>
        </div>
      </div>

      {/* 列表 */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-64"
            placeholder="搜索客户昵称 / 手机号"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="flex gap-1">
            {([['all', '全部'], ['listened', '听过课'], ['not_listened', '未听课']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setListenFilter(v)}
                className={`btn-ghost !py-1.5 !px-3 text-xs ${listenFilter === v ? '!border-brand-400/60 !text-brand-300' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div
          className="overflow-x-auto scroll-thin -mx-2 px-2 max-h-[560px] overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
              setVisibleCount((v) => (v < filtered.length ? v + 300 : v));
            }
          }}
        >
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#1c1c28]/95 backdrop-blur z-10">
              <tr className="text-left text-xs text-text-tertiary">
                <th className="py-2 pr-4">客户</th>
                <th className="py-2 pr-4">飞策听课</th>
                <th className="py-2 pr-4">加入企微</th>
                <th className="py-2 pr-4">备注手机</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-12 text-text-tertiary">
                  {loaded ? '暂无客户，点右上「获取我的客户信息」从企业微信同步' : '加载中…'}
                </td></tr>
              ) : filtered.slice(0, visibleCount).map((c) => (
                <tr key={c.id} className="border-t border-glass-border hover:bg-white/[0.02]">
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-[11px] font-medium shrink-0">
                        {c.nickname?.slice(0, 1) ?? '·'}
                      </div>
                      <span className="font-medium truncate max-w-[260px]">{c.nickname}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{listenCell(c.listenSec ?? 0)}</td>
                  <td className="py-2 pr-4 text-text-secondary text-xs whitespace-nowrap">
                    {c.addTime ? dayjs(c.addTime).format('YYYY-MM-DD') : '—'}
                  </td>
                  <td className="py-2 pr-4 text-text-secondary text-xs">{c.remarkMobiles || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-text-tertiary pt-1">
          共 {filtered.length} 人
          {filtered.length > visibleCount && <span className="ml-2">（滚动加载更多）</span>}
          <span className="ml-3 text-[11px]">听课时长来自飞策直播+回放记录（未匹配身份的学员显示未听课，微信认证后自动补全）</span>
        </div>
      </div>
    </div>
  );
}
