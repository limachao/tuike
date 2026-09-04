import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

interface Stat {
  label: string;
  value: number | string;
  tone: 'brand' | 'mint' | 'amber' | 'pink';
}
const toneMap: Record<Stat['tone'], string> = {
  brand: 'from-brand-400/30 to-brand-600/10 border-brand-500/30',
  mint:  'from-accent-mint/25 to-emerald-500/5 border-accent-mint/25',
  amber: 'from-accent-amber/25 to-yellow-500/5 border-accent-amber/25',
  pink:  'from-accent-pink/25 to-fuchsia-500/5 border-accent-pink/25',
};

export default function DashboardPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [msgTasks, setMsgTasks] = useState<any[]>([]);
  const [stats, setStats] = useState<Stat[]>([
    { label: '进行中的监控任务', value: '-', tone: 'brand' },
    { label: '累计未听课学生', value: '-', tone: 'amber' },
    { label: '待企业微信确认', value: '-', tone: 'pink' },
    { label: '已发送提醒', value: '-', tone: 'mint' },
  ]);

  const load = async () => {
    try {
      const [t, m] = await Promise.all([
        api.get('/courses/tasks').then((r) => r.data),
        api.get('/reminder/message-tasks?status=PENDING_CONFIRM').catch(() => ({ data: [] })),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setMsgTasks(Array.isArray(m) ? m : []);
      const active = (Array.isArray(t) ? t : []).filter((x: any) => x.isActive);
      let notEntered = 0;
      let inc = 0;
      active.forEach((x: any) => {
        notEntered += x.notEnteredCount || 0;
        inc += x.incompleteCount || 0;
      });
      setStats([
        { label: '进行中的监控任务', value: active.length, tone: 'brand' },
        { label: '未听课学生总计', value: notEntered + inc, tone: 'amber' },
        { label: '待确认提醒任务', value: Array.isArray(m) ? m.length : 0, tone: 'pink' },
        { label: '已发送成功', value: '—', tone: 'mint' },
      ]);
    } catch (e) {}
  };

  useEffect(() => { load(); }, []);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const deleteTask = async (e: React.MouseEvent, t: any) => {
    e.preventDefault();
    e.stopPropagation();
    const name = t.course?.name ?? t.taskName ?? `#${t.id}`;
    if (!window.confirm(`确定删除监控任务「${name}」吗？\n\n该任务的学员名单、听课记录、群发提醒记录都会一并永久删除，无法恢复。`)) return;
    setDeletingId(t.id);
    try {
      await api.post(`/courses/tasks/${t.id}/delete`);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.message ?? '删除失败，请重试');
    } finally {
      setDeletingId(null);
    }
  };

  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      await Promise.all([
        api.post('/feice/sync/courses'),
        api.post('/wecom/sync/my-customers'),
      ]);
      // 名单匹配与考勤重算（基于当前已有数据；客户后台同步完可再点一次）
      try {
        await api.post('/identity/run-match');
        await Promise.all(tasks.map((t: any) => api.post(`/attendance/recompute/task/${t.id}`)));
      } catch {}
      load();
      alert('课程数据已更新。学员名单较多（数千人），正在后台同步，约3-5分钟后刷新页面即可看到客户数据。');
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 顶部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Dashboard</div>
          <h1 className="text-2xl font-semibold tracking-tight">今日待办</h1>
        </div>
        <div className="flex gap-2">
          <button onClick={sync} disabled={syncing} className="btn-ghost">
            {syncing ? '↻ 同步中…' : '↻ 立即同步数据'}
          </button>
          <Link to="/tasks/new" className="btn-primary">＋ 创建监控任务</Link>
        </div>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className={`glass-card p-5 bg-gradient-to-br ${toneMap[s.tone]}`}>
            <div className="text-xs text-text-secondary">{s.label}</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight">{s.value}</div>
          </div>
        ))}
      </div>

      {/* 双列 */}
      <div className="grid md:grid-cols-3 gap-6">
        {/* 任务概览 */}
        <div className="glass-card md:col-span-2 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="section-title">我的监控任务</div>
            <Link to="/courses" className="text-xs text-brand-300 hover:text-brand-200">去选课程 →</Link>
          </div>
          {tasks.length === 0 ? (
            <div className="py-14 text-center text-text-tertiary text-sm">
              还没有任务，先去
              <Link to="/tasks/new" className="mx-1 text-brand-300">创建一个监控任务</Link>
              吧
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.slice(0, 6).map((t: any) => (
                <Link
                  key={t.id}
                  to={`/tasks/${t.id}`}
                  className="block rounded-xl border border-glass-border bg-white/[0.03] hover:bg-white/[0.06] p-4 transition"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={
                          t.course?.coverUrl ||
                          'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=elegant%20online%20course%20cover%20dark%20gradient&image_size=square'
                        }
                        className="h-14 w-20 object-cover rounded-lg shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{t.course?.name ?? t.taskName}</div>
                        <div className="text-xs text-text-tertiary mt-0.5">
                          {t.course?.startTime ? dayjs(t.course.startTime).format('MM-DD HH:mm') : '时间未定'}
                          <span className="mx-2 text-glass-border">·</span>
                          {t.course?.status ?? '—'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-start gap-1 shrink-0">
                      <div className="text-right grid grid-cols-3 gap-3 text-center">
                        <ChipStat value={t.notEnteredCount ?? 0} label="从未进入" tone="amber" />
                        <ChipStat value={t.incompleteCount ?? 0} label="听课不足" tone="pink" />
                        <ChipStat value={t.completedCount ?? 0} label="已完成" tone="mint" />
                      </div>
                      <button
                        onClick={(e) => deleteTask(e, t)}
                        disabled={deletingId === t.id}
                        title="删除任务"
                        className="mt-1 px-2 py-1 rounded-lg text-text-tertiary hover:text-accent-red hover:bg-accent-red/10 transition text-sm disabled:opacity-40"
                      >
                        {deletingId === t.id ? '…' : '🗑'}
                      </button>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* 待确认提醒 */}
        <div className="glass-card p-5 space-y-4">
          <div className="section-title">待销售确认</div>
          {msgTasks.length === 0 ? (
            <div className="py-10 text-center text-text-tertiary text-sm">暂无待确认提醒</div>
          ) : (
            <div className="space-y-2">
              {msgTasks.slice(0, 8).map((m: any) => (
                <Link
                  key={m.id}
                  to={`/reminders/${m.id}`}
                  className="block rounded-lg border border-glass-border hover:bg-white/[0.05] p-3"
                >
                  <div className="text-sm truncate">
                    {m.monitoringTask?.course?.name ?? '任务'}
                  </div>
                  <div className="text-[11px] text-text-tertiary mt-1 flex justify-between">
                    <span>{m.totalRecipients ?? 0} 人</span>
                    <span className="text-accent-amber">待企业微信确认</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChipStat({
  value, label, tone,
}: { value: number; label: string; tone: 'amber' | 'pink' | 'mint' }) {
  const color =
    tone === 'amber' ? 'text-accent-amber' :
    tone === 'pink'  ? 'text-accent-pink'  : 'text-accent-mint';
  return (
    <div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] text-text-tertiary">{label}</div>
    </div>
  );
}
