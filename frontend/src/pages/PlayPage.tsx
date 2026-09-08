import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import Hls from 'hls.js';
import api from '@/lib/api';

/**
 * 内部员工点播视频播放页（飞策手动生成的回放课程）。
 * 飞策点播 playUrl 是带签名的 m3u8（桌面 Chrome 不原生支持 HLS），
 * 因此用 hls.js 播放；后端 play-link 接口会在打开时实时取最新地址。
 */
export default function PlayPage() {
  const { courseId } = useParams();
  const nav = useNavigate();
  const location = useLocation() as { state?: { name?: string } };
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let hls: Hls | null = null;
    (async () => {
      try {
        const { data } = await api.get(`/feice/courses/${courseId}/play-link`);
        const url: string | undefined = data?.url;
        if (!url) {
          setError('未获取到播放地址，请稍后重试');
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        if (url.includes('.m3u8') && Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_evt, d) => {
            if (d.fatal) setError('视频加载失败，链接可能已过期，请返回课程库重新打开');
          });
        } else {
          // iOS Safari 等原生支持 HLS 的环境直接播
          video.src = url;
        }
        video.play().catch(() => {});
      } catch (e: any) {
        setError(e?.response?.data?.message ?? '获取播放链接失败');
      }
    })();
    return () => {
      hls?.destroy();
    };
  }, [courseId]);

  return (
    <div className="min-h-screen bg-[#0d0d14] text-white flex flex-col">
      <div className="flex items-center justify-between gap-4 p-4">
        <button onClick={() => nav(-1)} className="btn-ghost !py-2 shrink-0">
          ← 返回
        </button>
        <div className="text-sm text-text-secondary truncate">
          {location.state?.name ?? '视频回放'}
        </div>
        <div className="w-20 shrink-0" />
      </div>
      <div className="flex-1 grid place-items-center p-4">
        {error ? (
          <div className="glass-card p-8 text-center text-text-secondary max-w-md">
            {error}
          </div>
        ) : (
          <video
            ref={videoRef}
            controls
            playsInline
            className="w-full max-w-5xl max-h-[80vh] rounded-xl bg-black"
          />
        )}
      </div>
    </div>
  );
}
