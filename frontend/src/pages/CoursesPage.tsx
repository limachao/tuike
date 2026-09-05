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
                <button
                  onClick={() => syncRecords(c)}
                  disabled={syncingId === c.id}
                  className="btn-ghost w-full mt-2 text-xs"
                >
                  {syncingId === c.id ? '同步中…' : '↻ 同步听课记录'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
