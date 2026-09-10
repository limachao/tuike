import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';
type StatusKey =
  | 'ALL' | 'DRAFT' | 'SCHEDULED' | 'PENDING_CONFIRM' | 'EXECUTED' | 'PARTIAL_SUCCESS'
  | 'ALL_SUCCESS' | 'FAILED' | 'UNKNOWN' | 'STOPPED';

const statusTone: Record<string, string> = {
  DRAFT:            'text-text-tertiary',
  SCHEDULED:        'text-sky-300',
  PENDING_CONFIRM:  'text-accent-amber',
  EXECUTED:         'text-brand-300',
  PARTIAL_SUCCESS:  'text-accent-amber',
  ALL_SUCCESS:      'text-accent-mint',
  FAILED:           'text-accent-red',
  UNKNOWN:          'text-text-secondary',
  STOPPED:          'text-text-tertiary',
};
const statusLabel: Record<string, string> = {
  DRAFT:            '草稿',
  SCHEDULED:        '待定时发送',
  PENDING_CONFIRM:  '待销售在企业微信确认',
  EXECUTED:         '销售已执行',
  PARTIAL_SUCCESS:  '部分成功',
  ALL_SUCCESS:      '全部发送成功',
  FAILED:           '发送失败',
  UNKNOWN:          '结果未知',
  STOPPED:          '已停止',
};

export default function ReminderTasksPage() {
  const [statusFilter, setStatusFilter] = useState<StatusKey>('ALL');
  const [list, setList] = useState<any[]>([]);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const load = async () => {
    const params: any = {};
    if (statusFilter !== 'ALL') params.status = statusFilter;
    const { data } = await api.get('/reminder/message-tasks', { params });
    setList(Array.isArray(data) ? data : []);
  };
  useEffect(() => { load(); }, [statusFilter]);

  /** 取消尚未到点的定时发送 */
  const cancelScheduled = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('确定取消这条定时发送吗？\n取消后不会提交给企业微信，也不会占用客户的群发限额。')) return;
    setCancellingId(id);
    try {
      await api.post(`/reminder/quick-send/${id}/cancel`);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err?.message ?? '取消失败，请重试');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Reminders</div>
          <h1 className="text-2xl font-semibold tracking-tight">提醒任务</h1>
        </div>
        <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-glass-border overflow-x-auto scroll-thin">
          {(['ALL','SCHEDULED','PENDING_CONFIRM','EXECUTED','PARTIAL_SUCCESS','ALL_SUCCESS','FAILED','STOPPED'] as const).map((s) => (
            <button key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-2 rounded-lg text-xs whitespace-nowrap transition ${
                statusFilter === s ? 'bg-white/10 text-white border border-glass-borderStrong' : 'text-text-secondary hover:text-white'
              }`}>
              {s === 'ALL' ? '全部' : s === 'SCHEDULED' ? '待发送' : statusLabel[s] ?? s}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="glass-card py-20 text-center text-text-tertiary">
          暂无提醒任务，到
          <Link to="/tasks" className="mx-1 text-brand-300">任务详情</Link>
          里创建第一条吧
        </div>
      ) : (
        <div className="glass-card divide-y divide-glass-border overflow-hidden">
          {list.map((m) => (
            <Link key={m.id} to={`/reminders/${m.id}`}
              className="flex flex-wrap items-center gap-4 p-5 hover:bg-white/[0.03] transition">
              <div className="shrink-0 text-center min-w-[76px]">
                <div className="text-[10px] text-text-tertiary">任务编号</div>
                <div className="font-mono text-xs text-text-secondary mt-0.5">{m.taskNo}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{m.monitoringTask?.course?.name ?? m.finalContent}</div>
                <div className="text-xs text-text-tertiary mt-0.5">
                  {m.status === 'SCHEDULED' ? (
                    <>
                      <span className="text-sky-300">⏰ 将于 {dayjs(m.scheduledAt).format('MM-DD HH:mm')} 自动提交</span>
                      <span className="mx-2 text-glass-border">·</span>
                      创建于 {dayjs(m.createdAt).format('MM-DD HH:mm')}
                    </>
                  ) : (
                    <>
                      创建于 {dayjs(m.createdAt).format('MM-DD HH:mm')}
                      <span className="mx-2 text-glass-border">·</span>
                      模板 {m.templateType === 'NEVER_ENTERED' ? '从未进入' : '听课不足'}
                      <span className="mx-2 text-glass-border">·</span>
                      入口 {m.entryType === 'live' ? '直播' : '回放'}
                    </>
                  )}
                  {m.status === 'FAILED' && m.scheduleError && (
                    <div className="text-accent-red mt-0.5 truncate">失败原因：{m.scheduleError}</div>
                  )}
                </div>
              </div>
              {m.status === 'SCHEDULED' && (
                <button
                  onClick={(e) => cancelScheduled(e, m.id)}
                  disabled={cancellingId === m.id}
                  className="shrink-0 btn-ghost !py-1.5 !px-3 text-xs !text-accent-red !border-accent-red/40 hover:bg-accent-red/10 whitespace-nowrap"
                >
                  {cancellingId === m.id ? '取消中…' : '取消发送'}
                </button>
              )}
              <div className="grid grid-cols-4 gap-3 text-center text-xs shrink-0">
                <div>
                  <div className="text-lg font-semibold tabular-nums">{m._count?.recipients ?? m.totalRecipients ?? 0}</div>
                  <div className="text-[10px] text-text-tertiary">人数</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums text-accent-mint">{m.sentSuccessCount ?? 0}</div>
                  <div className="text-[10px] text-text-tertiary">成功</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums text-accent-red">{m.sentFailCount ?? 0}</div>
                  <div className="text-[10px] text-text-tertiary">失败</div>
                </div>
                <div>
                  <div className={`text-xs font-semibold ${statusTone[m.status]}`}>
                    {statusLabel[m.status] ?? m.status}
                  </div>
                  <div className="text-[10px] text-text-tertiary mt-1">状态</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
