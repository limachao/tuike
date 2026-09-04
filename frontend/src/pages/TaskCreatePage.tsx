import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

/**
 * 创建监控任务流程：
 * Step 1 - 选择课程
 * Step 2 - 展示销售名下客户 → 一键全选 → 排除个别
 * Step 3 - 预览 & 确认（快照确定）
 */
export default function TaskCreatePage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const courseId = Number(sp.get('courseId')) || 0;

  const [courses, setCourses] = useState<any[]>([]);
  const [selCourseId, setSelCourseId] = useState<number>(courseId);
  const [taskName, setTaskName] = useState('');
  const [completePercent, setCompletePercent] = useState(60);
  const [maxReminders, setMaxReminders] = useState(3);

  // 任务创建后返回的 taskId（用于名单操作）
  const [taskId, setTaskId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [rosterTotal, setRosterTotal] = useState(0);
  const [excludedTotal, setExcludedTotal] = useState(0);

  const applyRosterData = (data: any) => {
    setRoster(data.list ?? []);
    setRosterTotal(data.total ?? (data.list ?? []).length);
    setExcludedTotal(data.task?.excludedCount ?? 0);
  };
  const [roster, setRoster] = useState<any[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [finalized, setFinalized] = useState(false);

  // 预加载课程
  useEffect(() => {
    api.get('/feice/courses').then((r) => setCourses(Array.isArray(r.data) ? r.data : []));
  }, []);

  const selCourse = useMemo(
    () => courses.find((c) => c.id === selCourseId),
    [courses, selCourseId],
  );

  // 选中课程 → 自动创建任务草稿并加载名下客户
  const startDraft = async () => {
    if (!selCourseId) return alert('请先选择课程');
    setLoading(true);
    try {
      const { data: task } = await api.post('/courses/tasks', {
        courseId: selCourseId,
        taskName: taskName || selCourse?.name,
        completeDurationPercent: completePercent,
        completeProgressPercent: completePercent,
        maxRemindersPerStudent: maxReminders,
      });
      setTaskId(task.id);
      // 拉名下客户
      const { data: cdata } = await api.get('/courses/my-customers');
      setCustomers(cdata.list ?? []);
      // 列表还空，先加载 roster（空）
      const { data: rdata } = await api.get(`/courses/tasks/${task.id}/roster`, {
        params: { pageSize: 10000 },
      });
      applyRosterData(rdata);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '创建失败');
    } finally { setLoading(false); }
  };

  const selectAll = async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      await api.post(`/courses/tasks/${taskId}/select-all`);
      const { data } = await api.get(`/courses/tasks/${taskId}/roster`, {
        params: { pageSize: 10000 },
      });
      applyRosterData(data);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '全选失败，请重试');
    } finally { setLoading(false); }
  };

  const refreshRoster = async () => {
    if (!taskId) return;
    const { data } = await api.get(`/courses/tasks/${taskId}/roster`, {
      params: { pageSize: 10000 },
    });
    applyRosterData(data);
  };

  const toggleExclude = async (entry: any) => {
    if (!taskId) return;
    if (entry.isExcluded) {
      await api.post(`/courses/tasks/${taskId}/add-customer`, { customerId: entry.customerId });
    } else {
      await api.post(`/courses/tasks/${taskId}/exclude`, { customerIds: [entry.customerId] });
    }
    refreshRoster();
  };

  const finalize = async () => {
    if (!taskId) return;
    const effective = activeCount;
    if (effective === 0) return alert('应听名单为空');
    if (!confirm(`确认固定应听名单？共 ${effective} 人。确认后名单将作为后续提醒的唯一依据。`)) return;
    await api.post(`/courses/tasks/${taskId}/finalize`);
    setFinalized(true);
    setTimeout(() => nav(`/tasks/${taskId}`), 500);
  };

  const filteredRoster = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return roster;
    return roster.filter((r) =>
      r.customer?.nickname?.toLowerCase().includes(kw) ||
      r.customer?.externalUserid?.includes(kw),
    );
  }, [roster, keyword]);

  const activeCount = rosterTotal - excludedTotal;
  const excludedCount = excludedTotal;
  // 名单可能有数千人，浏览器一次只渲染前 200 行，用搜索框查找具体学员
  const visibleRoster = filteredRoster.slice(0, 200);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Step · 建立监控</div>
        <h1 className="text-2xl font-semibold tracking-tight">创建课程监控任务</h1>
      </div>

      {/* Step 1: 课程 + 任务参数 */}
      <div className="glass-card p-6 space-y-5">
        <div className="section-title">① 选择课程 & 任务参数</div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">选择课程</label>
            <select
              className="input"
              value={selCourseId}
              onChange={(e) => {
                setSelCourseId(Number(e.target.value));
                const c = courses.find((x) => x.id === Number(e.target.value));
                if (c) setTaskName(c.name);
              }}
              disabled={!!taskId}
            >
              <option value={0}>请选择课程（先到「课程库」同步）</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.startTime ? `(${dayjs(c.startTime).format('MM-DD HH:mm')})` : ''}
                </option>
              ))}
            </select>
            {selCourse && (
              <div className="mt-2 text-xs text-text-secondary">
                课程时长 {selCourse.totalDuration > 0 ? `${Math.round(selCourse.totalDuration/60)} 分钟` : '未设置'}
                · 当前状态 {selCourse.status}
              </div>
            )}
          </div>
          <div>
            <label className="label">任务名称（销售内部可见）</label>
            <input className="input" value={taskName} onChange={(e) => setTaskName(e.target.value)} disabled={!!taskId} />
          </div>
          <div>
            <label className="label">完成标准（时长 & 进度 %，默认 60%）</label>
            <input type="number" min={10} max={100} className="input"
              value={completePercent} onChange={(e) => setCompletePercent(Number(e.target.value))} disabled={!!taskId} />
          </div>
          <div>
            <label className="label">每位学生最多提醒次数</label>
            <input type="number" min={1} max={10} className="input"
              value={maxReminders} onChange={(e) => setMaxReminders(Number(e.target.value))} disabled={!!taskId} />
          </div>
        </div>
        {!taskId && (
          <div className="flex justify-end">
            <button className="btn-primary" onClick={startDraft} disabled={loading || !selCourseId}>
              {loading ? '创建中…' : '下一步：选择客户名单'}
            </button>
          </div>
        )}
      </div>

      {/* Step 2: 客户名单 */}
      {taskId && (
        <div className="glass-card p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="section-title">② 选择应听名单</div>
            <div className="flex items-center gap-3 text-xs">
              <span className="chip !text-brand-300">应听 {activeCount} 人</span>
              <span className="chip">已排除 {excludedCount} 人</span>
              <span className="chip !text-text-tertiary">名下共 {customers.length || '—'} 位客户</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={selectAll} disabled={loading} className="btn-primary">🗂 一键全选名下客户</button>
            <input className="input w-64" placeholder="搜索昵称 / external_userid"
              value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <div className="flex-1" />
            <button onClick={refreshRoster} className="btn-ghost">刷新</button>
            <button onClick={finalize}
              disabled={finalized || activeCount === 0}
              className="btn-success">✓ 确认名单 & 开始监控</button>
          </div>

          {roster.length === 0 ? (
            <div className="py-16 text-center text-text-tertiary text-sm">
              名单为空，点击上方「🗂 一键全选名下客户」开始
            </div>
          ) : (
            <div className="overflow-x-auto scroll-thin -mx-2 px-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-text-tertiary">
                    <th className="py-3 pr-4">客户</th>
                    <th className="py-3 pr-4">加入方式</th>
                    <th className="py-3 pr-4">加入时间</th>
                    <th className="py-3 pr-4">状态</th>
                    <th className="py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRoster.map((r) => (
                    <tr key={r.id} className={`border-t border-glass-border ${r.isExcluded ? 'opacity-50' : ''}`}>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-xs font-medium">
                            {r.customer?.nickname?.slice(0,1) ?? '·'}
                          </div>
                          <div>
                            <div className="font-medium">{r.customer?.nickname}</div>
                            <div className="text-[11px] text-text-tertiary font-mono">{r.customer?.externalUserid}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="chip">{r.joinMethod === 'select_all' ? '一键全选' : r.joinMethod}</span>
                      </td>
                      <td className="py-3 pr-4 text-text-secondary">
                        {dayjs(r.joinedAt).format('MM-DD HH:mm')}
                      </td>
                      <td className="py-3 pr-4">
                        {r.isExcluded ? (
                          <span className="chip !text-accent-red/90">已排除 · {r.excludeReason ?? '—'}</span>
                        ) : (
                          <span className="chip !text-accent-mint">已在名单内</span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          onClick={() => toggleExclude(r)}
                          className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                            r.isExcluded
                              ? 'border-accent-mint/40 text-accent-mint hover:bg-accent-mint/10'
                              : 'border-accent-red/30 text-accent-red hover:bg-accent-red/10'
                          }`}
                        >
                          {r.isExcluded ? '恢复进名单' : '从此课程排除'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredRoster.length > visibleRoster.length && (
                <div className="py-3 text-center text-xs text-text-tertiary">
                  仅显示前 {visibleRoster.length} 条，共 {filteredRoster.length} 条；在搜索框输入昵称可查找具体学员
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
