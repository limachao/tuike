import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

type NeedType = 'all' | 'not_entered' | 'incomplete';
type RosterTab = 'roster' | NeedType | 'feice';
// 对应 Prisma MessageTemplateType（避免前端直接依赖 prisma 包）
const MT_NEVER_ENTERED = 'NEVER_ENTERED' as const;
const MT_INCOMPLETE    = 'INCOMPLETE'    as const;

export default function TaskDetailPage() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const [rosterType, setRosterType] = useState<RosterTab>('roster');
  const [task, setTask] = useState<any>(null);
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showReminder, setShowReminder] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [customContent, setCustomContent] = useState('');
  const [entryType, setEntryType] = useState<'live' | 'replay'>('live');

  const loadTask = async () => {
    try {
      const { data } = await api.get(`/courses/tasks/${taskId}/roster`, {
        params: { pageSize: 500 },
      });
      setTask(data.task);
    } catch {}
  };

  const loadList = async () => {
    try {
      if (rosterType === 'feice') {
        const courseId = task?.course?.id ?? task?.courseId;
        if (!courseId) { setList([]); setTotal(0); return; }
        const { data } = await api.get(`/feice/courses/${courseId}/watch-records`, {
          params: { keyword: keyword || undefined },
        });
        setList(data); setTotal(data.length);
      } else if (rosterType === 'roster') {
        const { data } = await api.get(`/courses/tasks/${taskId}/roster`, {
          params: { keyword: keyword || undefined, pageSize: 500 },
        });
        setList(data.list); setTotal(data.total);
      } else {
        const { data } = await api.get(`/attendance/tasks/${taskId}/need-reminder`, {
          params: { type: rosterType, keyword: keyword || undefined, pageSize: 500, excludeUnmatchedIdentity: 1 },
        });
        setList(data.list); setTotal(data.total);
      }
    } catch (e: any) {
      console.error(e);
    }
  };

  const refreshAll = async () => {
    // 听课重算
    try { await api.post(`/attendance/recompute/task/${taskId}`); } catch {}
    await Promise.all([loadTask(), loadList()]);
  };

  useEffect(() => { loadTask(); }, [taskId]);
  useEffect(() => { loadList(); }, [taskId, rosterType, keyword, task?.course?.id]);
  useEffect(() => { setSelectedIds(new Set()); }, [rosterType, keyword]);

  const toggleOne = (id: number) => {
    const s = new Set(selectedIds);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelectedIds(s);
  };
  const toggleAll = () => {
    if (selectedIds.size === list.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(list.map((r) => r.id)));
  };

  const openReminder = async () => {
    if (rosterType === 'roster' || rosterType === 'feice') {
      setRosterType('all');
      return;
    }
    const templateType =
      rosterType === 'not_entered' ? MT_NEVER_ENTERED :
      rosterType === 'incomplete'  ? MT_INCOMPLETE :
      (list.some((r) => r.status === 'NOT_ENTERED') ? MT_NEVER_ENTERED : MT_INCOMPLETE);
    setCustomContent('');
    setEntryType(task?.course?.status === 'ENDED' ? 'replay' : 'live');
    const { data } = await api.post('/reminder/preview', {
      taskId: Number(taskId),
      templateType,
      rosterIds: selectedIds.size ? [...selectedIds] : undefined,
      entryType,
    });
    setPreview(data);
    setCustomContent(data.finalContent);
    setShowReminder(true);
  };

  const submitReminder = async () => {
    if (!preview) return;
    const templateType = (preview.templateUsed?.type as string) ?? MT_NEVER_ENTERED;
    if (!confirm(`确定创建提醒任务并推送到企业微信吗？\n将发送给 ${preview.rosterTotal} 位客户。\n\n销售必须在企业微信中确认后客户才会真正收到消息。`)) return;
    setSending(true);
    try {
      const { data } = await api.post('/reminder/create', {
        taskId: Number(taskId),
        templateType,
        rosterIds: selectedIds.size ? [...selectedIds] : undefined,
        customContent: customContent || undefined,
        entryType,
      });
      alert('已创建任务！企业微信会通知销售确认发送。');
      setShowReminder(false);
      nav(`/reminders/${data.messageTask.id}`);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '创建失败');
    } finally { setSending(false); }
  };

  const stopOne = async (customerId: number, nickname: string) => {
    if (!confirm(`停止 ${nickname} 后续所有提醒？`)) return;
    await api.post(`/reminder/task/${taskId}/student/${customerId}/stop`);
    loadList();
  };

  const tabs = useMemo(() => ([
    { k: 'roster' as const,        label: '应听名单快照', count: task?.totalRosterCount },
    { k: 'not_entered' as const,   label: '从未进入',       tone: 'amber', count: task?.notEnteredCount },
    { k: 'incomplete' as const,    label: '听课不足 60%',   tone: 'pink',  count: task?.incompleteCount },
    { k: 'feice' as const,         label: '飞策听课记录',   tone: 'mint' },
  ]), [task]);

  const statusChip = (status: string) => {
    switch (status) {
      case 'NOT_ENTERED': return <span className="chip !text-accent-amber">从未进入</span>;
      case 'INCOMPLETE':  return <span className="chip !text-accent-pink">听课不足</span>;
      case 'COMPLETED':   return <span className="chip !text-accent-mint">已完成</span>;
      case 'EXCLUDED':    return <span className="chip !text-text-tertiary">已排除</span>;
      case 'STOPPED':     return <span className="chip !text-accent-red">已停止提醒</span>;
      default:            return <span className="chip">在名单中</span>;
    }
  };

  if (!task) return <div className="glass-card p-10 text-text-tertiary text-center">加载中…</div>;

  return (
    <div className="space-y-6">
      {/* 头 */}
      <div className="glass-card p-6 space-y-4">
        <div className="flex flex-wrap gap-4 items-start justify-between">
          <div className="flex gap-4 min-w-0">
            <img
              src={task.course?.coverUrl || 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=elegant%20online%20course%20cover%20dark%20gradient&image_size=square'}
              className="h-24 w-36 object-cover rounded-xl shrink-0"
            />
            <div className="min-w-0">
              <div className="text-[11px] text-text-tertiary">监控任务 #{task.id}</div>
              <h1 className="text-2xl font-semibold tracking-tight truncate">{task.course?.name ?? task.taskName}</h1>
              <div className="text-sm text-text-secondary mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {task.course?.startTime && <span>开课 {dayjs(task.course.startTime).format('YYYY-MM-DD HH:mm')}</span>}
                <span>完成标准 ≥ {task.completeDurationPercent}%</span>
                <span>最多提醒 {task.maxRemindersPerStudent} 次</span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                const url = `${window.location.origin}/course/${task.feiceLiveRoomId}`;
                navigator.clipboard
                  .writeText(url)
                  .then(() => alert('推课链接已复制，可直接在微信私发给学员：\n\n' + url))
                  .catch(() => prompt('复制下方链接发给学员：', url));
              }}
              className="btn-ghost"
              title="复制后可在微信中一对一私发给学员，不受企微群发每日一条的限制"
            >
              🔗 复制链接
            </button>
            <button onClick={refreshAll} className="btn-ghost">↻ 重算听课</button>
            <button
              onClick={async () => {
                const name = task.course?.name ?? task.taskName ?? `#${task.id}`;
                if (!window.confirm(`确定删除监控任务「${name}」吗？\n\n该任务的学员名单、听课记录、群发提醒记录都会一并永久删除，无法恢复。`)) return;
                try {
                  await api.post(`/courses/tasks/${task.id}/delete`);
                  nav('/');
                } catch (e: any) {
                  alert(e?.response?.data?.message ?? '删除失败，请重试');
                }
              }}
              className="btn-ghost !text-accent-red/90 hover:!bg-accent-red/10"
            >
              🗑 删除任务
            </button>
            <Link to="/feice/sync" className="btn-ghost hidden"></Link>
            <button onClick={openReminder} className="btn-primary">
              ✉ 创建提醒任务
              <span className="ml-1 text-xs opacity-80">
                （{selectedIds.size ? `已选${selectedIds.size}` : rosterType === 'roster' ? '点此切到未听课视图' : `共${total}`}）
              </span>
            </button>
          </div>
        </div>

        {/* 统计带色卡 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="应听总数"      value={task.totalRosterCount ?? 0} />
          <StatCard label="从未进入"      value={task.notEnteredCount   ?? 0} tone="amber" />
          <StatCard label="听课不足 60%"  value={task.incompleteCount   ?? 0} tone="pink" />
          <StatCard label="已完成"        value={task.completedCount    ?? 0} tone="mint" />
          <StatCard label="已排除"        value={task.excludedCount     ?? 0} />
        </div>
      </div>

      {/* 过滤条 */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-glass-border">
            {tabs.map((t) => (
              <button key={t.k}
                onClick={() => setRosterType(t.k)}
                className={`px-4 py-2 rounded-lg text-sm transition ${
                  rosterType === t.k
                    ? 'bg-white/10 text-white border border-glass-borderStrong'
                    : 'text-text-secondary hover:text-white'
                }`}>
                {t.label}
                {t.count != null && (
                  <span className={`ml-2 chip !py-0.5 !text-[11px]
                    ${t.tone === 'amber' ? '!text-accent-amber' : t.tone === 'pink' ? '!text-accent-pink' : ''}
                  `}>{t.count}</span>
                )}
              </button>
            ))}
          </div>
          <input className="input w-64" placeholder="搜索客户"
            value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <div className="flex-1" />
          {rosterType !== 'feice' && (
            <button onClick={toggleAll} className="btn-ghost !py-2">
              {selectedIds.size === list.length && list.length > 0 ? '取消全选' : '全选当前页'}
            </button>
          )}
        </div>

        {rosterType === 'feice' ? (
          /* 飞策原始听课记录：昵称来自微信，未匹配企微也能查看 */
          <div className="overflow-x-auto scroll-thin -mx-2 px-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-tertiary">
                  <th className="py-3 pr-4">微信昵称（飞策）</th>
                  <th className="py-3 pr-4">对应企微学员</th>
                  <th className="py-3 pr-4">直播听课</th>
                  <th className="py-3 pr-4">回放听课</th>
                  <th className="py-3 pr-4">最大进度</th>
                  <th className="py-3 pr-4">最后听课</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-16 text-text-tertiary">
                    暂无飞策听课记录，请先在课程库点「同步听课记录」
                  </td></tr>
                ) : list.map((r) => {
                  const totalSec = task.course?.totalDuration ?? 1;
                  const totalListen = r.liveDurationSec + r.replayDurationSec;
                  const pct = Math.min(100, Math.round((Math.max(totalListen, r.maxProgressSec) / Math.max(totalSec, 1)) * 100));
                  return (
                    <tr key={r.personKey} className="border-t border-glass-border hover:bg-white/[0.02]">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-mint/30 grid place-items-center text-xs font-medium">
                            {String(r.nickName ?? '·').slice(0, 1)}
                          </div>
                          <div className="font-medium">{r.nickName}</div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        {r.customerNickname
                          ? <span className="chip !text-accent-mint">✓ {r.customerNickname}</span>
                          : <span className="chip !text-text-tertiary" title="微信开放平台认证通过并重新同步客户后自动匹配">未匹配</span>}
                      </td>
                      <td className="py-3 pr-4 tabular-nums">
                        {Math.round(r.liveDurationSec / 60)} 分钟
                        {r.liveSessions > 0 && <div className="text-[11px] text-text-tertiary">{r.liveSessions} 次进入</div>}
                      </td>
                      <td className="py-3 pr-4 tabular-nums">
                        {Math.round(r.replayDurationSec / 60)} 分钟
                        {r.replaySessions > 0 && <div className="text-[11px] text-text-tertiary">{r.replaySessions} 次观看</div>}
                      </td>
                      <td className="py-3 pr-4 tabular-nums">
                        {Math.round(r.maxProgressSec / 60)} 分钟 <span className="text-xs text-text-tertiary">/ {Math.round(totalSec / 60)}m</span>
                        <div className="progress-bar w-28 mt-1.5"><span style={{ width: `${pct}%` }} /></div>
                        <div className="text-[11px] text-text-tertiary mt-1">{pct}%</div>
                      </td>
                      <td className="py-3 pr-4 text-text-secondary">
                        {r.lastWatchAt ? dayjs(r.lastWatchAt).format('MM-DD HH:mm') : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.length > 0 && (
              <div className="text-xs text-text-tertiary pt-2">
                共 {total} 人 · 数据来自飞策直播/回放记录（按微信身份聚合）
              </div>
            )}
          </div>
        ) : (
        /* 表 */
        <div className="overflow-x-auto scroll-thin -mx-2 px-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-tertiary">
                {rosterType !== 'roster' && <th className="py-3 pr-3 w-10"></th>}
                <th className="py-3 pr-4">客户</th>
                <th className="py-3 pr-4">累计有效时长</th>
                <th className="py-3 pr-4">最大进度</th>
                <th className="py-3 pr-4">最后听课</th>
                <th className="py-3 pr-4">已提醒</th>
                <th className="py-3 pr-4">状态</th>
                <th className="py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-16 text-text-tertiary">暂无数据</td></tr>
              ) : list.map((r) => {
                const duration = r.totalDurationSec ?? 0;
                const progress = r.maxProgressSec ?? 0;
                const totalSec = task.course?.totalDuration ?? 1;
                const pct = Math.min(100, Math.round((Math.max(duration, progress) / Math.max(totalSec,1)) * 100));
                return (
                  <tr key={r.id} className="border-t border-glass-border hover:bg-white/[0.02]">
                    {rosterType !== 'roster' && (
                      <td className="py-3 pr-3">
                        <input type="checkbox" className="w-4 h-4"
                          checked={selectedIds.has(r.id)}
                          onChange={() => toggleOne(r.id)} />
                      </td>
                    )}
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-xs font-medium">
                          {r.customer?.nickname?.slice(0,1) ?? '·'}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{r.customer?.nickname}</div>
                          <div className="text-[11px] text-text-tertiary font-mono truncate">{r.customer?.externalUserid}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 pr-4 tabular-nums">
                      {Math.round(duration/60)} 分钟
                      <div className="progress-bar w-28 mt-1.5"><span style={{ width: `${Math.min(100, Math.round((duration/totalSec)*100))}%` }} /></div>
                    </td>
                    <td className="py-3 pr-4 tabular-nums">
                      {Math.round(progress/60)} 分钟 <span className="text-xs text-text-tertiary">/ {Math.round(totalSec/60)}m</span>
                      <div className="text-[11px] text-text-tertiary mt-1">{pct}%</div>
                    </td>
                    <td className="py-3 pr-4 text-text-secondary">
                      {r.lastWatchTime ? dayjs(r.lastWatchTime).format('MM-DD HH:mm') : '—'}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="chip">{r.reminderCount ?? 0} 次</span>
                      {r.lastReminderAt && <div className="text-[10px] text-text-tertiary mt-1">上次 {dayjs(r.lastReminderAt).format('MM-DD')}</div>}
                    </td>
                    <td className="py-3 pr-4">{statusChip(r.status)}</td>
                    <td className="py-3 text-right">
                      {r.status !== 'STOPPED' && r.status !== 'COMPLETED' && r.status !== 'EXCLUDED' && (
                        <button onClick={() => stopOne(r.customerId, r.customer?.nickname)}
                          className="text-xs px-3 py-1.5 rounded-lg border border-accent-red/30 text-accent-red hover:bg-accent-red/10">
                          停止提醒
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
        {rosterType !== 'feice' && list.length > 0 && (
          <div className="text-xs text-text-tertiary pt-2">
            共 {total} 条 · 已选择 {selectedIds.size} 条
            {rosterType !== 'roster' && (
              <span className="ml-3">· 未勾选默认使用当前完整名单创建提醒</span>
            )}
          </div>
        )}
      </div>

      {/* 创建提醒弹窗 */}
      {showReminder && preview && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 grid place-items-center p-4"
             onClick={() => !sending && setShowReminder(false)}>
          <div className="glass-card-strong w-full max-w-2xl p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Preview · 群发预览</div>
              <h2 className="text-xl font-semibold tracking-tight mt-1">确认创建企业微信提醒任务</h2>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="glass-card p-3 text-center">
                <div className="text-2xl font-semibold text-brand-300">{preview.rosterTotal}</div>
                <div className="text-[11px] text-text-tertiary">接收客户</div>
              </div>
              <div className="glass-card p-3 text-center">
                <div className="text-sm font-semibold text-accent-amber">
                  {preview.entryType === 'live' ? '直播入口' : '回放入口'}
                </div>
                <div className="text-[11px] text-text-tertiary">
                  <select className="bg-transparent text-center text-[11px] outline-none"
                    value={entryType} onChange={(e) => setEntryType(e.target.value as any)}>
                    <option value="live">直播</option>
                    <option value="replay">回放</option>
                  </select>
                </div>
              </div>
              <div className="glass-card p-3 text-center">
                <div className="text-sm font-semibold truncate">{preview.templateUsed?.name ?? '自定义'}</div>
                <div className="text-[11px] text-text-tertiary">消息模板</div>
              </div>
            </div>

            <div>
              <label className="label">群发内容（统一文案，不含个性化字段）</label>
              <textarea rows={4} className="input resize-none"
                value={customContent}
                onChange={(e) => setCustomContent(e.target.value)} />
            </div>
            <div>
              <label className="label">统一链接（课程中转页；企业微信限制不能给每人不同链接）</label>
              <div className="input !py-3 break-all text-xs font-mono text-brand-200 bg-white/[0.03]">
                {preview.finalUrl}
              </div>
            </div>

            <div className="rounded-xl border border-glass-border p-4 space-y-2 bg-white/[0.02]">
              <div className="text-[11px] text-text-tertiary uppercase tracking-widest">⚠ 发送须知</div>
              <ul className="text-xs text-text-secondary space-y-1 list-disc pl-4">
                <li>任务创建后，<b className="text-white">销售会在企业微信收到待确认提示</b>；客户不会立即收到。</li>
                <li>销售在企业微信确认后，系统才真正发出；<b>不会绕过销售确认。</b></li>
                <li>同一学生同一课程每天最多提醒 1 次；默认最多 3 次。</li>
                <li>创建前系统已自动过滤「已完成、手动停止、身份未确认」的学生。</li>
                <li>消息发出后无法撤回；已创建任务只支持整体停止，不支持单独移除个别客户。</li>
              </ul>
            </div>

            <div className="flex justify-end gap-2">
              <button disabled={sending} onClick={() => setShowReminder(false)} className="btn-ghost">取消</button>
              <button disabled={sending} onClick={submitReminder} className="btn-primary">
                {sending ? '正在创建…' : '✓ 创建任务并推送至企业微信'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'amber' | 'pink' | 'mint' }) {
  const color =
    tone === 'amber' ? 'text-accent-amber' :
    tone === 'pink'  ? 'text-accent-pink'  :
    tone === 'mint'  ? 'text-accent-mint'  : 'text-white';
  return (
    <div className="glass-card p-4">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
