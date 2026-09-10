import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

/** 听课时长阈值（分钟）：超过的可用一键按钮从已选中移除 */
const LISTEN_THRESHOLD_MIN = 100;

/** 听课状态分层：未听课 / 已听课（≤阈值）/ 听课充分（>阈值，不用再推） */
type ListenStatus = 'none' | 'light' | 'heavy';
function listenStatus(sec: number): ListenStatus {
  if (!sec || sec <= 0) return 'none';
  return sec > LISTEN_THRESHOLD_MIN * 60 ? 'heavy' : 'light';
}
const STATUS_META: Record<ListenStatus, { label: string; cls: string }> = {
  none: { label: '未听课', cls: 'bg-white/5 text-text-tertiary border-white/10' },
  light: { label: '已听课', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  heavy: { label: '听课充分', cls: 'bg-amber-500/10 text-accent-amber border-amber-500/30' },
};
const STATUS_FILTERS: Array<{ key: 'all' | ListenStatus; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'none', label: '未听课' },
  { key: 'light', label: '已听课' },
  { key: 'heavy', label: `听课≥${LISTEN_THRESHOLD_MIN}分` },
];

export default function QuickSendPage() {
  const nav = useNavigate();
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [keyword, setKeyword] = useState('');
  const [addFrom, setAddFrom] = useState('');
  const [addTo, setAddTo] = useState('');
  const [listenFilter, setListenFilter] = useState<'all' | ListenStatus>('all');
  /** 第一排「客户标签」：点亮的标签 = 直接勾选对应客户（可多选，取并集） */
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  /** 第二排「过滤标签」：点亮后命中的客户强制不推送（自动取消勾选且不可选） */
  const [excludeVIP, setExcludeVIP] = useState(false);
  const [excludeListened, setExcludeListened] = useState(false);
  /** 发送方式：now=立即提交企微 / scheduled=定时到点自动提交 */
  const [sendMode, setSendMode] = useState<'now' | 'scheduled'>('now');
  const [scheduleTime, setScheduleTime] = useState(''); // datetime-local 格式
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** 分批渲染：先画 200 行，滚动到底部每次追加 300 行 */
  const [visibleCount, setVisibleCount] = useState(200);

  const loadCustomers = async () => {
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

  useEffect(() => { loadCustomers(); }, []);

  // 链接来源下拉：manual=手动填 / live:{id}=正在直播的课程链接 / gen:{id}=生成过的回放链接
  const [linkChoice, setLinkChoice] = useState('manual');
  const [courses, setCourses] = useState<any[]>([]);
  const [generatedLinks, setGeneratedLinks] = useState<any[]>([]);

  useEffect(() => {
    api.get('/feice/courses').then((r) => setCourses(Array.isArray(r.data) ? r.data : []));
    api.get('/feice/generated-links').then((r) => setGeneratedLinks(Array.isArray(r.data) ? r.data : []));
  }, []);

  const liveCourses = useMemo(() => courses.filter((c) => c.status === 'LIVE'), [courses]);

  const onLinkChoice = (v: string) => {
    setLinkChoice(v);
    if (v === 'manual') return; // 手动模式：不清空已填链接
    const [kind, idStr] = v.split(':');
    if (kind === 'live') fillLive(Number(idStr));
    else if (kind === 'gen') fillGenerated(Number(idStr));
  };

  /** 客户身上出现过的全部企微标签（按人数倒序），用于标签筛选下拉 */
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of customers) {
      for (const t of (c.wecomTags ?? []) as string[]) {
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [customers]);

  /** 基础筛选：昵称/手机号关键词 + 加入企微日期区间 + 听课状态（不含标签） */
  const baseFiltered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const from = addFrom ? dayjs(addFrom).startOf('day').valueOf() : null;
    const to = addTo ? dayjs(addTo).endOf('day').valueOf() : null;
    return customers.filter((c) => {
      if (kw) {
        const nick = String(c.nickname ?? '').toLowerCase();
        const mobile = String(c.remarkMobiles ?? '');
        if (!nick.includes(kw) && !mobile.includes(kw)) return false;
      }
      if (from || to) {
        if (!c.addTime) return false;
        const t = dayjs(c.addTime).valueOf();
        if (from && t < from) return false;
        if (to && t > to) return false;
      }
      if (listenFilter !== 'all' && listenStatus(c.listenSec ?? 0) !== listenFilter) return false;
      return true;
    });
  }, [customers, keyword, addFrom, addTo, listenFilter]);

  /**
   * 最终列表：基础筛选之上，点亮了客户标签时只显示命中任一选中标签的客户，
   * 其他客户全部隐藏（标签同时决定勾选与列表可见范围）。
   */
  const filteredCustomers = useMemo(() => {
    if (activeTags.size === 0) return baseFiltered;
    return baseFiltered.filter((c) =>
      ((c.wecomTags ?? []) as string[]).some((t) => activeTags.has(t)),
    );
  }, [baseFiltered, activeTags]);

  const customerById = useMemo(
    () => new Map<number, any>(customers.map((c) => [c.id, c])),
    [customers],
  );

  /** VIP：企微标签名正好是 VIP（忽略大小写和首尾空格） */
  const isVIP = (c: any) =>
    ((c?.wecomTags ?? []) as string[]).some((t) => String(t).trim().toUpperCase() === 'VIP');

  /** 命中「过滤标签」任一规则的客户：不推送（勾选被拦截、全选跳过、行置灰） */
  const isExcluded = (c: any) =>
    (excludeVIP && isVIP(c)) || (excludeListened && (c?.listenSec ?? 0) > 0);

  /** 第二排过滤标签上的人数统计（全部客户口径） */
  const vipCount = useMemo(() => customers.filter(isVIP).length, [customers]);
  const listenedCount = useMemo(
    () => customers.filter((c) => (c.listenSec ?? 0) > 0).length,
    [customers],
  );

  /** 选中直播课程 → 填入追踪链接 + 默认文案 */
  const fillLive = (id: number) => {
    const c = courses.find((x) => x.id === id);
    if (c) {
      setUrl(`${window.location.origin}/course/${c.feiceLiveRoomId}`);
      if (!content.trim()) setContent(`【${c.name}】正在直播中！\n点击下方链接进入直播间听课：`);
    }
  };

  /** 选中生成过的回放链接 → 填入链接 */
  const fillGenerated = (id: number) => {
    const g = generatedLinks.find((x) => x.id === id);
    if (g) {
      setUrl(g.url);
      if (!content.trim()) setContent(`【${g.title}】回放来了！\n点击下方链接观看：`);
    }
  };

  /** 单个勾选：被过滤标签排除的客户不允许选 */
  const toggle = (id: number) => {
    const c = customerById.get(id);
    if (c && isExcluded(c)) return;
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  /** 全选当前可见列表（搜索/日期/听课状态筛选后），自动跳过被排除的人 */
  const toggleAll = () => {
    const selectable = filteredCustomers.filter((c) => !isExcluded(c));
    const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectable.map((c) => c.id)));
  };

  /**
   * 第一排标签点击：点亮 = 勾选该标签下的可见客户（可多选取并集，自动跳过被排除的人）；
   * 熄灭 = 取消该批，但仍被其他点亮标签覆盖的客户保留勾选。
   */
  const toggleTagChip = (tag: string) => {
    const turningOn = !activeTags.has(tag);
    const nextTags = new Set(activeTags);
    if (turningOn) nextTags.add(tag); else nextTags.delete(tag);
    setActiveTags(nextTags);
    setSelected((prev) => {
      const s = new Set(prev);
      // 注意：遍历「基础筛选」结果（不含标签筛选），
      // 否则点亮新标签时列表还停留在旧标签的范围里，新标签的客户选不进来
      for (const c of baseFiltered) {
        const tags = (c.wecomTags ?? []) as string[];
        if (!tags.includes(tag)) continue;
        if (turningOn) {
          if (!isExcluded(c)) s.add(c.id);
        } else if (![...nextTags].some((t) => tags.includes(t))) {
          s.delete(c.id);
        }
      }
      return s;
    });
  };

  /** 第二排过滤开关：点亮的瞬间把已选中的命中客户立即剔除 */
  const toggleExcludeVIP = () => {
    const next = !excludeVIP;
    setExcludeVIP(next);
    if (next) {
      setSelected((prev) => new Set([...prev].filter((id) => {
        const c = customerById.get(id);
        return c ? !isVIP(c) : true;
      })));
    }
  };

  const toggleExcludeListened = () => {
    const next = !excludeListened;
    setExcludeListened(next);
    if (next) {
      setSelected((prev) => new Set([...prev].filter((id) => {
        const c = customerById.get(id);
        return c ? (c.listenSec ?? 0) <= 0 : true;
      })));
    }
  };

  const clearDateFilter = () => { setAddFrom(''); setAddTo(''); };

  const send = async (withUrl: boolean) => {
    if (!content.trim()) { alert('请输入文案'); return; }
    if (withUrl && !url.trim()) { alert('请输入网址'); return; }
    if (selected.size === 0) { alert('请至少选择一位客户'); return; }

    // 定时发送：校验时间（至少 2 分钟后）
    let scheduledIso = '';
    let scheduleLabel = '';
    if (sendMode === 'scheduled') {
      if (!scheduleTime) { alert('请选择定时发送时间'); return; }
      const d = dayjs(scheduleTime);
      if (!d.isValid()) { alert('定时时间格式不正确'); return; }
      if (d.valueOf() - Date.now() < 2 * 60 * 1000) {
        alert('定时发送时间至少要在 2 分钟之后');
        return;
      }
      scheduledIso = d.toISOString();
      scheduleLabel = d.format('M月D日 HH:mm');
    }

    const confirmMsg = sendMode === 'scheduled'
      ? `确定设定定时发送吗？\n\n将于 ${scheduleLabel} 自动提交给 ${selected.size} 位客户。\n到点后你仍需在企业微信手机端点「发送」，客户才会收到。`
      : `确定发送给 ${selected.size} 位客户吗？\n\n销售需要在企业微信手机端确认后，客户才会收到消息。`;
    if (!confirm(confirmMsg)) return;
    setSending(true);
    try {
      const { data } = await api.post('/reminder/quick-send', {
        content: content.trim(),
        url: withUrl ? url.trim() : '',
        customerIds: [...selected],
        scheduledAt: scheduledIso || undefined,
      });
      if (sendMode === 'scheduled') {
        alert(`已设定定时发送！\n将于 ${scheduleLabel} 自动提交，届时请到企业微信手机端确认发送。\n发送前可在「提醒任务」里取消。`);
        nav('/reminders');
      } else {
        alert(`已创建群发任务 #${data.messageTask.id}！\n请到企业微信手机端确认发送。`);
        nav(`/reminders/${data.messageTask.id}`);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? '发送失败，请重试';
      // 超时或网络异常时，后端可能已成功但前端没收到响应——引导用户查任务列表确认
      if (e?.code === 'ECONNABORTED' || e?.response?.status === 504) {
        alert(`请求超时，但任务可能已提交。\n请到「提醒任务」页面查看是否有新任务，不要重复发送！`);
      } else {
        alert(msg);
      }
    } finally {
      setSending(false);
    }
  };

  const listenCell = (sec: number) => {
    if (!sec || sec <= 0) return <span className="text-text-tertiary">—</span>;
    const min = Math.round(sec / 60);
    const heavy = sec > LISTEN_THRESHOLD_MIN * 60;
    return (
      <span className={heavy ? 'text-accent-amber font-medium' : 'text-text-secondary'}>
        {min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}` : `${min} 分钟`}
        {heavy && <span className="ml-1 text-[10px] chip !py-0 !text-[10px] !text-accent-amber">≥{LISTEN_THRESHOLD_MIN}m</span>}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Quick Send</div>
        <h1 className="text-2xl font-semibold tracking-tight">快捷群发</h1>
        <div className="text-sm text-text-secondary mt-1">
          写文案（网址可选）→ 按加入日期/听课情况筛选客户 → 发送 → 企业微信手机端确认
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_420px] gap-6">
        {/* 左：文案 + 客户列表 */}
        <div className="space-y-4">
          {/* 文案输入 */}
          <div className="glass-card p-5 space-y-4">
            <div>
              <label className="label">课程链接来源</label>
              <select
                className="input"
                value={linkChoice}
                onChange={(e) => onLinkChoice(e.target.value)}
              >
                <option value="manual">请手动输入课程链接</option>
                {liveCourses.length === 0 ? (
                  <option value="no-live" disabled>还没有开始直播</option>
                ) : liveCourses.map((c) => (
                  <option key={`live-${c.id}`} value={`live:${c.id}`}>
                    【直播中】{c.name} 的直播链接
                  </option>
                ))}
                {generatedLinks.length === 0 ? (
                  <option value="no-replay" disabled>还没有生成过回放链接（到课程库点「观看回放」生成）</option>
                ) : generatedLinks.map((g) => (
                  <option key={`gen-${g.id}`} value={`gen:${g.id}`}>
                    【回放】{g.title}（{dayjs(g.createdAt).format('MM-DD HH:mm')} 生成）
                  </option>
                ))}
              </select>
              {linkChoice === 'manual' && (
                <div className="text-[11px] text-text-tertiary mt-1">在下方「附带网址」里粘贴课程链接</div>
              )}
              {linkChoice.startsWith('live') && (
                <div className="text-[11px] text-text-tertiary mt-1">直播链接已填入：学员点开 → 登录 → 进直播间，听课自动归因</div>
              )}
              {linkChoice.startsWith('gen') && (
                <div className="text-[11px] text-text-tertiary mt-1">回放链接已填入下方「附带网址」</div>
              )}
            </div>
            <div>
              <label className="label">发送文案</label>
              <textarea
                rows={4}
                className="input resize-none"
                placeholder="输入要发送给客户的文案内容…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
              <div className="text-[11px] text-text-tertiary mt-1">{content.length} 字</div>
            </div>
            <div>
              <label className="label">附带网址（选填，仅「文案+网址」需要；链接标题默认「点击进入」）</label>
              <input
                className="input"
                placeholder="https://…（只发文案可留空）"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>

          {/* 客户列表 */}
          <div className="glass-card p-4 space-y-3">
            {/* 筛选条 */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-56"
                placeholder="搜索昵称 / 手机号"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
                <span className="whitespace-nowrap">加入企微</span>
                <input
                  type="date"
                  className="input !py-1.5 !px-2 text-xs"
                  value={addFrom}
                  max={addTo || undefined}
                  onChange={(e) => setAddFrom(e.target.value)}
                />
                <span>~</span>
                <input
                  type="date"
                  className="input !py-1.5 !px-2 text-xs"
                  value={addTo}
                  min={addFrom || undefined}
                  onChange={(e) => setAddTo(e.target.value)}
                />
                {(addFrom || addTo) && (
                  <button onClick={clearDateFilter} className="btn-ghost !py-1.5 !px-2 text-xs">清除</button>
                )}
              </div>
              {/* 听课状态分段筛选：销售快速区分该推谁、不用推谁 */}
              <div className="flex items-center gap-1 flex-wrap">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setListenFilter(f.key)}
                    className={`btn-ghost !py-1.5 !px-2.5 text-xs whitespace-nowrap ${
                      listenFilter === f.key ? '!border-brand-500/60 !text-brand-300 bg-brand-500/10' : ''
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <button onClick={toggleAll} className="btn-ghost !py-2 text-xs whitespace-nowrap">
                {filteredCustomers.some((c) => !isExcluded(c) && !selected.has(c.id)) ? '全选' : '取消全选'}
              </button>

              {/* 第一排：客户标签 —— 点亮标签直接勾选该批客户（可多选，取并集；被过滤的人自动跳过） */}
              <div className="w-full pt-1">
                <div className="text-[11px] text-text-tertiary mb-1.5">
                  客户标签<span className="ml-1 text-text-tertiary/70">（点亮后列表只显示这批客户并自动勾选，可叠加多个）</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {allTags.length === 0 && (
                    <span className="text-xs text-text-tertiary">暂无企微标签</span>
                  )}
                  {allTags.map(([t, n]) => {
                    const active = activeTags.has(t);
                    return (
                      <button
                        key={t}
                        onClick={() => toggleTagChip(t)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${
                          active
                            ? 'border-brand-500/60 bg-brand-500/15 text-brand-200'
                            : 'border-white/10 bg-white/5 text-text-secondary hover:border-white/25'
                        }`}
                      >
                        {active ? '✓ ' : ''}{t}
                        <span className={`text-[10px] ${active ? 'text-brand-300' : 'text-text-tertiary'}`}>{n}人</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 第二排：过滤标签 —— 点亮后命中的客户不推送（自动取消勾选，且勾不上、全选跳过） */}
              <div className="w-full">
                <div className="text-[11px] text-text-tertiary mb-1.5">
                  过滤标签<span className="ml-1 text-red-300/80">（点亮后，命中的客户不会收到消息）</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={toggleExcludeVIP}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${
                      excludeVIP
                        ? 'border-red-500/60 bg-red-500/15 text-red-200'
                        : 'border-white/10 bg-white/5 text-text-secondary hover:border-white/25'
                    }`}
                    title="按企微标签名 VIP 匹配（忽略大小写）"
                  >
                    🚫 VIP{excludeVIP ? '·已排除' : ''}
                    <span className={`text-[10px] ${excludeVIP ? 'text-red-300' : 'text-text-tertiary'}`}>{vipCount}人</span>
                  </button>
                  <button
                    onClick={toggleExcludeListened}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${
                      excludeListened
                        ? 'border-red-500/60 bg-red-500/15 text-red-200'
                        : 'border-white/10 bg-white/5 text-text-secondary hover:border-white/25'
                    }`}
                    title="飞策听课时长 > 0 即视为已听课"
                  >
                    🚫 已听课{excludeListened ? '·已排除' : ''}
                    <span className={`text-[10px] ${excludeListened ? 'text-red-300' : 'text-text-tertiary'}`}>{listenedCount}人</span>
                  </button>
                </div>
              </div>
            </div>

            <div
              className="overflow-x-auto scroll-thin -mx-2 px-2 max-h-[480px] overflow-y-auto"
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
                  setVisibleCount((v) => (v < filteredCustomers.length ? v + 300 : v));
                }
              }}
            >
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#1c1c28]/95 backdrop-blur z-10">
                  <tr className="text-left text-xs text-text-tertiary">
                    <th className="py-2 pr-3 w-10"></th>
                    <th className="py-2 pr-4">客户</th>
                    <th className="py-2 pr-4">飞策听课</th>
                    <th className="py-2 pr-4">加入企微</th>
                    <th className="py-2 pr-4">备注手机</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-12 text-text-tertiary">
                      {loaded ? '暂无客户，试试调整搜索、日期或标签筛选' : '加载中…'}
                    </td></tr>
                  ) : filteredCustomers.slice(0, visibleCount).map((c) => {
                    const excluded = isExcluded(c);
                    return (
                    <tr key={c.id} className={`border-t border-glass-border hover:bg-white/[0.02] ${excluded ? 'opacity-45' : ''}`}>
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          className="w-4 h-4"
                          checked={selected.has(c.id)}
                          disabled={excluded}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-[11px] font-medium shrink-0">
                            {c.nickname?.slice(0, 1) ?? '·'}
                          </div>
                          <span className="font-medium truncate max-w-[220px]">{c.nickname}</span>
                        </div>
                        {/* 听课状态标记（系统自动）+ 企微标签（销售在企微后台打的） */}
                        <div className="flex flex-wrap items-center gap-1 mt-1 pl-9">
                          {(() => {
                            const st = STATUS_META[listenStatus(c.listenSec ?? 0)];
                            return (
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] leading-4 whitespace-nowrap ${st.cls}`}>
                                {st.label}
                              </span>
                            );
                          })()}
                          {/* 命中过滤标签：红色「不推送」标记 */}
                          {excluded && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-[10px] leading-4 whitespace-nowrap">
                              不推送{excludeVIP && isVIP(c) ? '·VIP' : ''}
                              {excludeListened && (c.listenSec ?? 0) > 0 ? '·已听课' : ''}
                            </span>
                          )}
                          {((c.wecomTags ?? []) as string[]).slice(0, 2).map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-300 text-[10px] leading-4 whitespace-nowrap"
                            >
                              {t}
                            </span>
                          ))}
                          {((c.wecomTags ?? []) as string[]).length > 2 && (
                            <span className="text-[10px] text-text-tertiary">
                              +{((c.wecomTags ?? []) as string[]).length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                        {listenCell(c.listenSec ?? 0)}
                      </td>
                      <td className="py-2 pr-4 text-text-secondary text-xs whitespace-nowrap">
                        {c.addTime ? dayjs(c.addTime).format('YYYY-MM-DD') : '—'}
                      </td>
                      <td className="py-2 pr-4 text-text-secondary text-xs">
                        {c.remarkMobiles || '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-text-tertiary pt-1">
              共 {filteredCustomers.length} 人 · 已选 {selected.size} 人
              {filteredCustomers.filter(isExcluded).length > 0 && (
                <span className="ml-2 text-red-300/90">· 不推送 {filteredCustomers.filter(isExcluded).length} 人</span>
              )}
              {filteredCustomers.length > visibleCount && <span className="ml-2">（滚动加载更多）</span>}
              <span className="ml-3 text-[11px]">听课时长来自飞策直播+回放记录（未匹配身份的学员暂计 0，微信认证后自动补全）</span>
            </div>
          </div>
        </div>

        {/* 右：预览 + 发送 */}
        <div className="space-y-4">
          <div className="glass-card-strong p-5 space-y-4 sticky top-4">
            <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Preview</div>

            {/* 模拟微信消息卡片 */}
            <div className="rounded-xl bg-[#2a2a3a] border border-glass-border p-4 space-y-3">
              <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-all">
                {content || <span className="text-text-tertiary">（文案预览区域）</span>}
              </div>
              {url && (
                <div className="flex items-center gap-3 rounded-lg bg-white/[0.04] border border-glass-border p-3">
                  <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-brand-500/30 to-accent-pink/30 grid place-items-center shrink-0">
                    <span className="text-lg">🔗</span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">点击进入</div>
                    <div className="text-[11px] text-text-tertiary truncate">{url}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="glass-card p-3 text-center">
                <div className="text-xl font-semibold text-brand-300">{selected.size}</div>
                <div className="text-[11px] text-text-tertiary">接收客户</div>
              </div>
              <div className="glass-card p-3 text-center">
                <div className="text-sm font-semibold text-accent-amber">{content.length}</div>
                <div className="text-[11px] text-text-tertiary">文案字数</div>
              </div>
            </div>

            <div className="rounded-xl border border-glass-border p-3 space-y-1.5 bg-white/[0.02]">
              <div className="text-[11px] text-text-tertiary uppercase tracking-widest">发送须知</div>
              <ul className="text-xs text-text-secondary space-y-1 list-disc pl-4">
                <li>提交后<b className="text-white">销售在企业微信收到待确认</b>，客户不会立即收到</li>
                <li>每位客户每天最多收到 1 条 API 群发消息</li>
                <li>销售手机确认后客户才真正收到</li>
              </ul>
            </div>

            {/* 发送方式切换：立即 / 定时 */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setSendMode('now')}
                className={`btn-ghost !py-2 text-xs whitespace-nowrap ${
                  sendMode === 'now' ? '!border-brand-500/60 !text-brand-300 bg-brand-500/10' : ''
                }`}
              >
                ⚡ 立即发送
              </button>
              <button
                onClick={() => setSendMode('scheduled')}
                className={`btn-ghost !py-2 text-xs whitespace-nowrap ${
                  sendMode === 'scheduled' ? '!border-brand-500/60 !text-brand-300 bg-brand-500/10' : ''
                }`}
              >
                ⏰ 定时发送
              </button>
            </div>
            {sendMode === 'scheduled' && (
              <div className="space-y-1.5 -mt-1">
                <input
                  type="datetime-local"
                  className="input text-sm"
                  value={scheduleTime}
                  min={dayjs().add(2, 'minute').format('YYYY-MM-DDTHH:mm')}
                  onChange={(e) => setScheduleTime(e.target.value)}
                />
                <div className="text-[11px] text-text-tertiary">
                  到点系统自动提交企微，你仍需在手机端点「发送」；发送前可在提醒任务里取消
                </div>
              </div>
            )}

            <div className="space-y-2">
              <button
                onClick={() => send(false)}
                disabled={sending || !content.trim() || selected.size === 0 || (sendMode === 'scheduled' && !scheduleTime)}
                className="btn-primary w-full"
                title={!content.trim() ? '请先输入文案' : selected.size === 0 ? '请先选择客户' : sendMode === 'scheduled' && !scheduleTime ? '请先选择定时时间' : ''}
              >
                {sending ? '正在提交…' : sendMode === 'scheduled'
                  ? `⏰ 定时·只发文案（${selected.size} 位客户）`
                  : `✉ 只发文案（${selected.size} 位客户）`}
              </button>
              <button
                onClick={() => send(true)}
                disabled={sending || !content.trim() || !url.trim() || selected.size === 0 || (sendMode === 'scheduled' && !scheduleTime)}
                className="btn-ghost w-full"
                title={!url.trim() ? '请先在下方输入网址' : !content.trim() ? '请先输入文案' : selected.size === 0 ? '请先选择客户' : sendMode === 'scheduled' && !scheduleTime ? '请先选择定时时间' : ''}
              >
                {sending ? '正在提交…' : sendMode === 'scheduled'
                  ? `⏰ 定时·文案 + 网址（${selected.size} 位客户）`
                  : `🔗 文案 + 网址（${selected.size} 位客户）`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
