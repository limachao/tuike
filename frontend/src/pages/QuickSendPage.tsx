import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

/** 听课时长阈值（分钟）：超过的可用一键按钮从已选中移除 */
const LISTEN_THRESHOLD_MIN = 100;

export default function QuickSendPage() {
  const nav = useNavigate();
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [keyword, setKeyword] = useState('');
  const [addFrom, setAddFrom] = useState('');
  const [addTo, setAddTo] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadCustomers = async () => {
    try {
      const { data } = await api.get('/reminder/quick-send/customers', {
        params: {
          keyword: keyword || undefined,
          addFrom: addFrom || undefined,
          addTo: addTo || undefined,
        },
      });
      setCustomers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setCustomers([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { loadCustomers(); }, [keyword, addFrom, addTo]);

  // 链接来源：manual=手动填 / live=正在直播 / replay=我生成过的回放链接
  const [linkSource, setLinkSource] = useState<'manual' | 'live' | 'replay'>('manual');
  const [courses, setCourses] = useState<any[]>([]);
  const [liveCourseId, setLiveCourseId] = useState<number | ''>('');
  const [generatedLinks, setGeneratedLinks] = useState<any[]>([]);
  const [genLinkId, setGenLinkId] = useState<number | ''>('');

  useEffect(() => {
    api.get('/feice/courses').then((r) => setCourses(Array.isArray(r.data) ? r.data : []));
    api.get('/feice/generated-links').then((r) => setGeneratedLinks(Array.isArray(r.data) ? r.data : []));
  }, []);

  const liveCourses = useMemo(() => courses.filter((c) => c.status === 'LIVE'), [courses]);

  /** 选中直播课程 → 填入追踪链接 + 默认文案 */
  const fillLive = (id: number | '') => {
    setLiveCourseId(id);
    const c = courses.find((x) => x.id === id);
    if (c) {
      setUrl(`${window.location.origin}/course/${c.feiceLiveRoomId}`);
      if (!content.trim()) setContent(`【${c.name}】正在直播中！\n点击下方链接进入直播间听课：`);
    }
  };

  /** 选中生成过的回放链接 → 填入链接 */
  const fillGenerated = (id: number | '') => {
    setGenLinkId(id);
    const g = generatedLinks.find((x) => x.id === id);
    if (g) {
      setUrl(g.url);
      if (!content.trim()) setContent(`【${g.title}】回放来了！\n点击下方链接观看：`);
    }
  };

  // 选中的人里，听课超过阈值会被一键移除
  const overThresholdSelected = useMemo(() => {
    const map = new Map(customers.map((c) => [c.id, c.listenSec ?? 0]));
    return [...selected].filter((id) => (map.get(id) ?? 0) > LISTEN_THRESHOLD_MIN * 60).length;
  }, [selected, customers]);

  const toggle = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  const toggleAll = () => {
    if (selected.size === customers.length && customers.length > 0) setSelected(new Set());
    else setSelected(new Set(customers.map((c) => c.id)));
  };

  /** 一键移除已选中、且累计听课时长 > 阈值 的客户 */
  const removeHeavyListeners = () => {
    const map = new Map(customers.map((c) => [c.id, c.listenSec ?? 0]));
    const kept = [...selected].filter((id) => (map.get(id) ?? 0) <= LISTEN_THRESHOLD_MIN * 60);
    const removed = selected.size - kept.length;
    setSelected(new Set(kept));
    alert(removed > 0
      ? `已从已选中移除 ${removed} 位听课超过 ${LISTEN_THRESHOLD_MIN} 分钟的客户`
      : `已选中的人里没有听课超过 ${LISTEN_THRESHOLD_MIN} 分钟的`);
  };

  const clearDateFilter = () => { setAddFrom(''); setAddTo(''); };

  const send = async () => {
    if (!content.trim()) { alert('请输入文案'); return; }
    if (!url.trim()) { alert('请输入网址'); return; }
    if (selected.size === 0) { alert('请至少选择一位客户'); return; }
    if (!confirm(`确定发送给 ${selected.size} 位客户吗？\n\n销售需要在企业微信手机端确认后，客户才会收到消息。`)) return;
    setSending(true);
    try {
      const { data } = await api.post('/reminder/quick-send', {
        content: content.trim(),
        url: url.trim(),
        customerIds: [...selected],
      });
      alert(`已创建群发任务 #${data.messageTask.id}！\n请到企业微信手机端确认发送。`);
      nav(`/reminders/${data.messageTask.id}`);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '发送失败，请重试');
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
          写文案 + 粘贴网址 → 按加入日期/听课情况筛选客户 → 发送 → 企业微信手机端确认
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
                value={linkSource}
                onChange={(e) => setLinkSource(e.target.value as any)}
              >
                <option value="manual">请手动输入课程链接</option>
                <option value="live">正在直播的课程</option>
                <option value="replay">我手动生成过的回放链接</option>
              </select>
              {linkSource === 'live' && (
                liveCourses.length === 0 ? (
                  <div className="text-[11px] text-text-tertiary mt-1">当前没有正在直播的课程</div>
                ) : (
                  <select
                    className="input mt-2"
                    value={liveCourseId}
                    onChange={(e) => fillLive(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">— 选择直播间 —</option>
                    {liveCourses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )
              )}
              {linkSource === 'replay' && (
                generatedLinks.length === 0 ? (
                  <div className="text-[11px] text-text-tertiary mt-1">
                    还没有生成记录：到「课程库」点课程卡片的「▶ 观看回放」会自动记录
                  </div>
                ) : (
                  <select
                    className="input mt-2"
                    value={genLinkId}
                    onChange={(e) => fillGenerated(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">— 选择链接 —</option>
                    {generatedLinks.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}（{dayjs(g.createdAt).format('MM-DD HH:mm')}生成）
                      </option>
                    ))}
                  </select>
                )
              )}
              {linkSource === 'manual' && (
                <div className="text-[11px] text-text-tertiary mt-1">在下方「附带网址」里粘贴课程链接</div>
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
              <label className="label">附带网址（链接标题默认「点击进入」）</label>
              <input
                className="input"
                placeholder="https://…"
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
              <div className="flex-1" />
              <button
                onClick={removeHeavyListeners}
                disabled={overThresholdSelected === 0}
                className={`btn-ghost !py-2 text-xs whitespace-nowrap ${
                  overThresholdSelected > 0 ? '!text-accent-amber !border-accent-amber/40' : 'opacity-50'
                }`}
                title={`从已选中移除听课超过 ${LISTEN_THRESHOLD_MIN} 分钟的客户`}
              >
                ⚡ 去掉听课&gt;{LISTEN_THRESHOLD_MIN}分钟
                {overThresholdSelected > 0 && <span className="ml-1 chip !py-0 !text-[10px] !text-accent-amber">{overThresholdSelected}</span>}
              </button>
              <button onClick={toggleAll} className="btn-ghost !py-2 text-xs whitespace-nowrap">
                {selected.size === customers.length && customers.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>

            <div className="overflow-x-auto scroll-thin -mx-2 px-2 max-h-[480px] overflow-y-auto">
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
                  {customers.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-12 text-text-tertiary">
                      {loaded ? '暂无客户，试试调整搜索或日期筛选' : '加载中…'}
                    </td></tr>
                  ) : customers.map((c) => (
                    <tr key={c.id} className="border-t border-glass-border hover:bg-white/[0.02]">
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          className="w-4 h-4"
                          checked={selected.has(c.id)}
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
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-text-tertiary pt-1">
              共 {customers.length} 人 · 已选 {selected.size} 人
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

            <button
              onClick={send}
              disabled={sending}
              className="btn-primary w-full"
            >
              {sending ? '正在提交…' : `✉ 发送给 ${selected.size} 位客户`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
