import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import dayjs from 'dayjs';

export default function CoursesPage() {
  const nav = useNavigate();
  const [list, setList] = useState<any[]>([]);
  const [kw, setKw] = useState('');
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  // 听课记录弹窗
  const [recCourse, setRecCourse] = useState<any | null>(null);
  const [recList, setRecList] = useState<any[]>([]);
  const [recKw, setRecKw] = useState('');
  const [recLoading, setRecLoading] = useState(false);

  const load = async () => {
    const { data } = await api.get('/feice/courses', { params: { keyword: kw || undefined } });
    setList(Array.isArray(data) ? data : []);
  };

  const sync = async () => {
    await api.post('/feice/sync/courses');
    load();
  };

  /** 同步单门课的听课记录（直播+回放+邀课），后端会自动做身份匹配+听课重算 */
  const syncRecords = async (c: any) => {
    setSyncingId(c.id);
    try {
      await Promise.all([
        api.post(`/feice/sync/course/${c.id}/live-records`),
        api.post(`/feice/sync/course/${c.id}/replay-records`),
        api.post('/feice/sync/invite-records', null, { params: { courseId: c.id } }),
      ]);
      alert(`「${c.name}」听课记录同步完成，可去监控任务查看数据`);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '同步失败，请稍后重试');
    } finally {
      setSyncingId(null);
    }
  };

  /** 打开某门课的飞策听课记录 */
  const openRecords = async (c: any) => {
    setRecCourse(c);
    setRecKw('');
    setRecList([]);
    setRecLoading(true);
    try {
      const { data } = await api.get(`/feice/courses/${c.id}/watch-records`);
      setRecList(Array.isArray(data) ? data : []);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '获取听课记录失败');
      setRecCourse(null);
    } finally {
      setRecLoading(false);
    }
  };

  const searchRecords = async () => {
    if (!recCourse) return;
    setRecLoading(true);
    try {
      const { data } = await api.get(`/feice/courses/${recCourse.id}/watch-records`, {
        params: { keyword: recKw || undefined },
      });
      setRecList(Array.isArray(data) ? data : []);
    } finally {
      setRecLoading(false);
    }
  };

  useEffect(() => { load(); }, [kw]);

  const playLabel = (s: string) => {
    switch (s) {
      case 'LIVE': return '● 进入直播';
      case 'ENDED':
      case 'REPLAY_ONLY': return '▶ 观看回放';
      default: return '▶ 进入课堂';
    }
  };

  const play = async (c: any) => {
    setPlayingId(c.id);
    try {
      const { data } = await api.get(`/feice/courses/${c.id}/play-link`);
      if (data?.url) {
        window.open(data.url, '_blank');
      } else {
        alert('未获取到观看链接，请稍后重试');
      }
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '获取链接失败，请稍后重试');
    } finally {
      setPlayingId(null);
    }
  };

  const statusTone = (s: string) => {
    switch (s) {
      case 'LIVE':        return 'bg-accent-mint/20 text-accent-mint';
      case 'ENDED':       return 'bg-white/10 text-text-secondary';
      case 'REPLAY_ONLY': return 'bg-brand-500/20 text-brand-300';
      default:            return 'bg-accent-amber/20 text-accent-amber';
    }
  };
  const statusLabel = (s: string) => {
    switch (s) {
      case 'LIVE': return '直播中';
      case 'ENDED': return '已结束';
      case 'REPLAY_ONLY': return '仅回放';
      case 'NOT_STARTED': return '未开始';
      default: return s;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Courses</div>
          <h1 className="text-2xl font-semibold tracking-tight">课程库</h1>
        </div>
        <div className="flex gap-2">
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            className="input w-64"
            placeholder="搜索课程名"
          />
          <button onClick={sync} className="btn-ghost">↻ 同步飞策课程</button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="glass-card py-20 text-center text-text-tertiary">
          暂无课程，请先点击右上角「同步飞策课程」
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {list.map((c) => (
            <div key={c.id} className="glass-card overflow-hidden flex flex-col">
              <div className="aspect-[16/9] relative overflow-hidden bg-gradient-to-br from-brand-600/30 to-accent-pink/30">
                {c.coverUrl ? (
                  <img src={c.coverUrl} className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-grid-pattern [background-size:16px_16px] opacity-60" />
                )}
                <span className={`chip absolute top-3 left-3 ${statusTone(c.status)} !border-transparent`}>
                  {statusLabel(c.status)}
                </span>
              </div>
              <div className="p-4 space-y-3 flex-1 flex flex-col">
                <div className="font-medium text-[15px] line-clamp-2 min-h-[2.75rem]">{c.name}</div>
                <div className="text-xs text-text-tertiary space-y-1">
                  {c.startTime && <div>开课：{dayjs(c.startTime).format('YYYY-MM-DD HH:mm')}</div>}
                  {c.totalDuration > 0 && <div>课程时长：{Math.round(c.totalDuration/60)} 分钟</div>}
                </div>
                <div className="flex gap-2 mt-auto">
                  <button
                    onClick={() => play(c)}
                    disabled={playingId === c.id}
                    className="btn-primary flex-1"
                  >
                    {playingId === c.id ? '生成中…' : playLabel(c.status)}
                  </button>
                  <button
                    onClick={() => nav(`/tasks/new?courseId=${c.id}`)}
                    className="btn-ghost flex-1"
                  >
                    建立监控任务
                  </button>
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => openRecords(c)}
                    className="btn-ghost flex-1 text-xs"
                  >
                    📊 听课记录
                  </button>
                  <button
                    onClick={() => syncRecords(c)}
                    disabled={syncingId === c.id}
                    className="btn-ghost flex-1 text-xs"
                  >
                    {syncingId === c.id ? '同步中…' : '↻ 同步听课记录'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 飞策听课记录弹窗 */}
      {recCourse && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 grid place-items-center p-4"
          onClick={() => setRecCourse(null)}
        >
          <div
            className="glass-card-strong w-full max-w-4xl max-h-[85vh] flex flex-col p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="min-w-0">
                <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Feice Records</div>
                <h2 className="text-lg font-semibold tracking-tight truncate">
                  {recCourse.name} · 听课记录
                </h2>
                <div className="text-xs text-text-tertiary mt-1">
                  共 {recList.length} 人观看 · 昵称来自飞策微信授权
                </div>
              </div>
              <button onClick={() => setRecCourse(null)} className="btn-ghost !py-2 shrink-0">关闭</button>
            </div>

            <div className="flex gap-2 mb-3">
              <input
                className="input flex-1"
                placeholder="搜索微信昵称 / 学员名"
                value={recKw}
                onChange={(e) => setRecKw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchRecords()}
              />
              <button onClick={searchRecords} className="btn-ghost">搜索</button>
            </div>

            <div className="overflow-y-auto scroll-thin flex-1">
              {recLoading ? (
                <div className="text-center py-16 text-text-tertiary">加载中…</div>
              ) : recList.length === 0 ? (
                <div className="text-center py-16 text-text-tertiary">
                  暂无听课记录，请先点该课程卡片上的「↻ 同步听课记录」
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#1c1c28]/95 backdrop-blur z-10">
                    <tr className="text-left text-xs text-text-tertiary">
                      <th className="py-3 pr-4">微信昵称（飞策）</th>
                      <th className="py-3 pr-4">对应学员</th>
                      <th className="py-3 pr-4">直播听课</th>
                      <th className="py-3 pr-4">回放听课</th>
                      <th className="py-3 pr-4">最大进度</th>
                      <th className="py-3 pr-4">最后听课</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recList.map((r) => {
                      const totalSec = recCourse.totalDuration ?? 1;
                      const totalListen = r.liveDurationSec + r.replayDurationSec;
                      const pct = Math.min(100, Math.round((Math.max(totalListen, r.maxProgressSec) / Math.max(totalSec, 1)) * 100));
                      return (
                        <tr key={r.personKey} className="border-t border-glass-border hover:bg-white/[0.02]">
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-3">
                              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-mint/30 grid place-items-center text-xs font-medium shrink-0">
                                {String(r.nickName ?? '·').slice(0, 1)}
                              </div>
                              <div className="font-medium">{r.nickName}</div>
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            {r.customerNickname
                              ? <span className="chip !text-accent-mint">✓ {r.customerNickname}</span>
                              : <span className="chip !text-text-tertiary">未匹配</span>}
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
                            <div className="progress-bar w-24 mt-1.5"><span style={{ width: `${pct}%` }} /></div>
                            <div className="text-[11px] text-text-tertiary mt-1">{pct}%</div>
                          </td>
                          <td className="py-3 pr-4 text-text-secondary whitespace-nowrap">
                            {r.lastWatchAt ? dayjs(r.lastWatchAt).format('MM-DD HH:mm') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="text-[11px] text-text-tertiary pt-3">
              「未匹配」指尚未与企微学员名单自动对应；微信开放平台认证通过并重新同步客户后会自动匹配，不影响此处查看听课数据。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
