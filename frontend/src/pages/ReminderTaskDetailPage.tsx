import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

export default function ReminderTaskDetailPage() {
  const { id } = useParams();
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const { data } = await api.get(`/reminder/message-tasks/${id}`);
    setTask(data);
  };
  useEffect(() => { load(); }, [id]);

  const refresh = async () => {
    setLoading(true);
    try { await api.post(`/reminder/message-tasks/${id}/refresh-status`); await load(); }
    catch (e: any) { alert(e?.response?.data?.message ?? '刷新失败'); }
    finally { setLoading(false); }
  };
  const stop = async () => {
    if (!confirm('确认停止整个群发任务？\n（未发出的消息将不再发送；已发出的消息无法撤回）')) return;
    await api.post(`/reminder/message-tasks/${id}/stop`);
    load();
  };

  if (!task) return <div className="glass-card p-10 text-center text-text-tertiary">加载中…</div>;

  const recipients = task.recipients ?? [];
  const total = recipients.length;
  const openCount = recipients.filter((r: any) => r.openedTransferPage).length;
  const jumpedCount = recipients.filter((r: any) => r.jumpedToFeice).length;
  const completedCount = recipients.filter((r: any) => r.completed).length;
  const failedCount = recipients.filter((r: any) => r.customerReceived === false).length;
  const successCount = recipients.filter((r: any) => r.customerReceived === true).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Reminder · Task #{task.id}</div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {task.monitoringTask?.course?.name ?? '提醒任务详情'}
          </h1>
          <div className="text-xs text-text-tertiary mt-1 font-mono">
            业务编号 {task.taskNo} · 企业微信 msgid {task.wecomMsgid ?? '(未提交)'}
          </div>
        </div>
        <div className="flex gap-2">
          <Link to={`/tasks/${task.monitoringTaskId}`} className="btn-ghost">返回课程任务</Link>
          <button onClick={refresh} disabled={loading} className="btn-ghost">
            {loading ? '刷新中…' : '↻ 同步企业微信状态'}
          </button>
          {task.status !== 'STOPPED' && task.status !== 'ALL_SUCCESS' && task.status !== 'FAILED' && (
            <button onClick={stop} className="btn-danger">停止任务</button>
          )}
        </div>
      </div>

      {/* 指标 */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <MetricCard label="名单人数" value={total} />
        <MetricCard label="销售确认" value={task.confirmedCount ?? 0} tone={task.confirmedCount > 0 ? 'mint' : 'amber'} />
        <MetricCard label="发送成功" value={successCount} tone="mint" />
        <MetricCard label="发送失败" value={failedCount} tone="pink" />
        <MetricCard label="中转页打开" value={openCount} tone="brand" />
        <MetricCard label="已跳转飞策" value={jumpedCount} tone="brand" />
        <MetricCard label="完成课程" value={completedCount} tone="mint" />
      </div>

      {/* 文案+URL */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="glass-card p-5 space-y-3">
          <div className="section-title">发送内容</div>
          <div className="text-sm whitespace-pre-wrap leading-relaxed rounded-xl border border-glass-border bg-white/[0.03] p-4">
            {task.finalContent}
            <div className="mt-3 pt-3 border-t border-glass-border/60">
              <div className="text-[11px] text-text-tertiary mb-1">
                附加链接 · {task.entryType === 'live' ? '直播入口' : '回放入口'}
              </div>
              <a href={task.finalUrl} target="_blank" rel="noreferrer"
                className="text-brand-300 text-xs font-mono break-all hover:text-brand-200">
                {task.finalUrl}
              </a>
            </div>
          </div>
          <div className="text-[11px] text-text-tertiary">
            模板版本 v{task.templateVersion} · 创建于 {dayjs(task.createdAt).format('YYYY-MM-DD HH:mm:ss')}
          </div>
        </div>
        <div className="glass-card p-5 space-y-3">
          <div className="section-title">转化漏斗</div>
          <Funnel label="名单客户" value={total} total={total} />
          <Funnel label="销售确认后送达" value={successCount} total={total} />
          <Funnel label="打开中转页" value={openCount} total={total} />
          <Funnel label="跳转飞策课程" value={jumpedCount} total={total} />
          <Funnel label="完成听课 ≥60%" value={completedCount} total={total} tone="mint" />
        </div>
      </div>

      {/* 客户明细 */}
      <div className="glass-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="section-title">客户明细（{recipients.length} 人）</div>
        </div>
        <div className="overflow-x-auto scroll-thin -mx-2 px-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-tertiary">
                <th className="py-3 pr-4">客户</th>
                <th className="py-3 pr-4">企业微信结果</th>
                <th className="py-3 pr-4">打开中转页</th>
                <th className="py-3 pr-4">跳转飞策</th>
                <th className="py-3 pr-4">听课状态</th>
                <th className="py-3 pr-4">转化时间</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r: any) => (
                <tr key={r.id} className="border-t border-glass-border">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-xs">
                        {r.customer?.nickname?.slice(0,1) ?? '·'}
                      </div>
                      <div>
                        <div className="font-medium">{r.customer?.nickname}</div>
                        <div className="text-[11px] text-text-tertiary font-mono truncate max-w-[180px]">
                          {r.customer?.externalUserid}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    {r.customerReceived === true  && <span className="chip !text-accent-mint">已送达</span>}
                    {r.customerReceived === false && (
                      <span className="chip !text-accent-red" title={r.wecomFailReason}>
                        失败 · {r.wecomFailReason ?? r.wecomSendStatus ?? '未知'}
                      </span>
                    )}
                    {r.customerReceived == null && (
                      <span className="chip">待确认/查询中</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {r.openedTransferPage ? (
                      <span className="chip !text-brand-300">已打开 · {dayjs(r.firstOpenedAt).format('MM-DD HH:mm')}</span>
                    ) : <span className="chip">—</span>}
                  </td>
                  <td className="py-3 pr-4">
                    {r.jumpedToFeice ? (
                      <span className="chip !text-accent-mint">已进入 · {dayjs(r.jumpedAt).format('HH:mm')}</span>
                    ) : <span className="chip">—</span>}
                  </td>
                  <td className="py-3 pr-4">
                    {r.completed ? <span className="chip !text-accent-mint">已完成</span>
                      : r.startedLearning ? <span className="chip !text-brand-300">学习中</span>
                      : r.enteredCourse ? <span className="chip">进入课程</span>
                      : <span className="chip text-text-tertiary">未开始</span>}
                  </td>
                  <td className="py-3 pr-4 text-text-secondary text-xs">
                    <div className="space-y-0.5">
                      {r.firstOpenedAt && <div>打开 {dayjs(r.firstOpenedAt).format('HH:mm:ss')}</div>}
                      {r.jumpedAt && <div>跳转 {dayjs(r.jumpedAt).format('HH:mm:ss')}</div>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone?: 'brand' | 'amber' | 'pink' | 'mint' }) {
  const color =
    tone === 'amber' ? 'text-accent-amber' :
    tone === 'pink'  ? 'text-accent-pink' :
    tone === 'mint'  ? 'text-accent-mint' :
    tone === 'brand' ? 'text-brand-300' : 'text-white';
  return (
    <div className="glass-card p-4">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${color}`}>{value}</div>
    </div>
  );
}
function Funnel({ label, value, total, tone }: { label: string; value: number; total: number; tone?: 'mint' }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-text-secondary">{label}</span>
        <span className={`tabular-nums ${tone === 'mint' ? 'text-accent-mint' : 'text-text-primary'}`}>
          {value} <span className="text-text-tertiary">({pct}%)</span>
        </span>
      </div>
      <div className="progress-bar mt-1.5"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
