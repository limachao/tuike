import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { transferApi } from '@/lib/api';
import dayjs from 'dayjs';

/**
 * 统一课程中转页 - 公开路由（无鉴权）
 * 流程：
 *  1. 首屏 bootstrap：展示课程信息、登录状态、完成状态
 *  2. 未登录：手机号 + 验证码
 *  3. 登录后：进入课程按钮生成带追踪飞策入口，一键停止提醒按钮
 */
export default function TransferPage() {
  const { feiceLiveRoomId } = useParams<{ feiceLiveRoomId: string }>();
  const [sp] = useSearchParams();
  const tokenFromQuery = sp.get('token');

  const [boot, setBoot] = useState<any>(null);
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [enterLoading, setEnterLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const bootstrap = async (token?: string) => {
    try {
      const { data } = await transferApi.get(`/course/${feiceLiveRoomId}`, {
        params: { token },
      });
      setBoot(data);
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? '加载失败');
    }
  };

  useEffect(() => {
    const t = localStorage.getItem(`tk_transfer_token_${feiceLiveRoomId}`) || tokenFromQuery || undefined;
    bootstrap(t);
  }, [feiceLiveRoomId]);

  useEffect(() => {
    if (codeCountdown <= 0) return;
    const t = setTimeout(() => setCodeCountdown(codeCountdown - 1), 1000);
    return () => clearTimeout(t);
  }, [codeCountdown]);

  const sendCode = async () => {
    if (!/^1\d{10}$/.test(mobile)) return showToast('请输入正确手机号');
    setSending(true);
    try {
      const { data } = await transferApi.post('/send-sms', { mobile });
      if (data?.codeInDev) showToast(`开发环境验证码：${data.codeInDev}`);
      else showToast('验证码已发送');
      setCodeCountdown(60);
    } catch (e: any) { showToast(e?.response?.data?.message ?? '发送失败'); }
    finally { setSending(false); }
  };

  const login = async () => {
    if (!/^1\d{10}$/.test(mobile)) return showToast('请输入正确手机号');
    if (code.length < 4) return showToast('请输入验证码');
    try {
      const { data } = await transferApi.post('/login', {
        method: 'sms', mobile, code, feiceLiveRoomId: feiceLiveRoomId!,
      });
      localStorage.setItem(`tk_transfer_token_${feiceLiveRoomId}`, data.visitToken);
      showToast('验证成功');
      bootstrap(data.visitToken);
    } catch (e: any) { showToast(e?.response?.data?.message ?? '验证失败'); }
  };

  const enterCourse = async () => {
    const token = boot?.visitToken;
    if (!token) return;
    setEnterLoading(true);
    try {
      const { data } = await transferApi.post(`/course/${feiceLiveRoomId}/enter`, { visitToken: token });
      if (data?.feiceUrl) location.href = data.feiceUrl;
    } catch (e: any) { showToast(e?.response?.data?.message ?? '跳转失败'); }
    finally { setEnterLoading(false); }
  };

  const stopReminder = async () => {
    if (!confirm('确认取消本课程后续所有提醒吗？')) return;
    try {
      await transferApi.post(`/course/${feiceLiveRoomId}/stop-reminder`, { visitToken: boot.visitToken });
      showToast('已停止后续提醒。感谢你的反馈。');
      bootstrap(boot.visitToken);
    } catch (e: any) { showToast(e?.response?.data?.message ?? '操作失败'); }
  };

  if (!boot) return (
    <div className="min-h-screen grid place-items-center text-text-tertiary">加载中…</div>
  );

  const { course, customer, roster, completed } = boot;
  const totalMin = course.totalDuration > 0 ? Math.round(course.totalDuration / 60) : 0;
  const progressMin = roster ? Math.round(roster.maxProgressSec / 60) : 0;
  const pct = totalMin > 0 ? Math.min(100, Math.round((Math.max(roster?.totalDurationSec ?? 0, roster?.maxProgressSec ?? 0) / course.totalDuration) * 100)) : 0;

  return (
    <div className="min-h-screen w-full">
      {/* 背景装饰 */}
      <div className="fixed inset-0 -z-10 bg-apple-gradient" />
      <div className="fixed inset-0 -z-10 bg-grid-pattern [background-size:24px_24px] opacity-25" />

      {/* Toast */}
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 glass-card-strong px-4 py-2.5 text-sm shadow-glow">
          {toast}
        </div>
      )}

      <div className="min-h-screen grid md:grid-cols-2">
        {/* 左：课程介绍 + 状态 */}
        <div className="flex items-end p-6 md:p-10">
          <div className="w-full max-w-lg space-y-6">
            <span className="chip">
              {course.status === 'LIVE' ? '🔴 直播中' :
               course.status === 'ENDED' || course.status === 'REPLAY_ONLY' ? '🟢 可观看回放' : '⏳ 未开始'}
            </span>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
              {course.name}
            </h1>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-text-secondary">
              {course.startTime && (
                <span>开课时间 {dayjs(course.startTime).format('YYYY-MM-DD HH:mm')}</span>
              )}
              {totalMin > 0 && <span>总时长 {totalMin} 分钟</span>}
            </div>

            {customer ? (
              <div className="glass-card p-5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-gradient-to-br from-accent-mint to-brand-400 grid place-items-center text-white font-semibold">
                    {customer.nickname?.slice(0, 1) ?? 'U'}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      你好，{customer.nickname}
                      {completed && '  🎉'}
                    </div>
                    <div className="text-xs text-text-tertiary">已验证身份 · 学习会被记录</div>
                  </div>
                  {completed ? (
                    <span className="ml-auto chip !text-accent-mint">已完成学习</span>
                  ) : roster?.stopReminder ? (
                    <span className="ml-auto chip">已停止提醒</span>
                  ) : null}
                </div>

                {totalMin > 0 && (
                  <>
                    <div className="flex items-end justify-between text-xs">
                      <span className="text-text-secondary">
                        学习进度 {progressMin}/{totalMin} 分钟 · {pct}%
                      </span>
                    </div>
                    <div className="progress-bar h-2"><span style={{ width: `${pct}%` }} /></div>
                  </>
                )}

                <div className="text-xs text-text-tertiary pt-1">
                  累计有效听课 {Math.round((roster?.totalDurationSec ?? 0)/60)} 分钟 ·
                  最大进度 {progressMin} 分钟 ·
                  已提醒 {roster?.reminderCount ?? 0} 次
                </div>
              </div>
            ) : (
              <div className="glass-card p-5">
                <div className="text-sm font-medium mb-1">需要先验证身份</div>
                <div className="text-xs text-text-secondary">
                  验证后系统会自动记录你的学习进度，达到 60% 后会自动停止后续提醒。
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右：登录 / 进入课程 */}
        <div className="flex items-center justify-center p-6 md:p-10">
          <div className="w-full max-w-md glass-card-strong p-8 space-y-6">
            {!customer ? (
              <>
                <div>
                  <div className="text-xl font-semibold tracking-tight">身份验证</div>
                  <div className="text-sm text-text-secondary mt-1">
                    输入手机号后，系统会识别你的听课记录并生成专属课程入口。
                  </div>
                </div>
                <div>
                  <label className="label">手机号</label>
                  <input className="input" inputMode="numeric"
                    value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </div>
                <div>
                  <label className="label">验证码</label>
                  <div className="flex gap-2">
                    <input className="input" inputMode="numeric"
                      value={code} onChange={(e) => setCode(e.target.value)} />
                    <button
                      onClick={sendCode}
                      disabled={sending || codeCountdown > 0}
                      className="btn-ghost shrink-0 whitespace-nowrap"
                    >
                      {codeCountdown > 0 ? `${codeCountdown}s 后重发` : sending ? '发送中…' : '发送验证码'}
                    </button>
                  </div>
                </div>
                <button onClick={login} className="btn-primary w-full py-3">验证并进入</button>
                <div className="text-[11px] text-text-tertiary leading-relaxed">
                  点击验证即代表你同意我们使用手机号进行身份匹配，用于记录课程学习进度并提供后续提醒服务。
                  你可以在本页一键停止后续提醒。
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-xl font-semibold tracking-tight">
                    {completed ? '已完成学习 🎉' : '准备好开始了吗？'}
                  </div>
                  <div className="text-sm text-text-secondary mt-1">
                    {completed
                      ? '你已达到课程学习要求，系统已自动停止后续提醒。如需再看一遍，仍可点击下方入口。'
                      : course.status === 'LIVE'
                        ? '直播正在进行，点击立即加入。'
                        : '可随时进入回放学习，系统将持续记录你的进度。'}
                  </div>
                </div>

                <button
                  onClick={enterCourse}
                  disabled={enterLoading}
                  className="btn-primary w-full py-4 text-base !rounded-2xl"
                >
                  {enterLoading ? '正在生成入口…' :
                    course.status === 'LIVE' ? '▶  进入直播' : '▶  进入课程回放'}
                </button>

                {!completed && !roster?.stopReminder && (
                  <button onClick={stopReminder}
                    className="w-full text-sm text-text-tertiary hover:text-accent-red transition py-2">
                    不再接收本课程提醒
                  </button>
                )}

                <div className="divider" />
                <div className="text-[11px] text-text-tertiary space-y-2">
                  <div className="flex gap-2 items-start">
                    <span className="mt-0.5">🛡</span>
                    <span>本页使用 HTTPS，手机号与验证码仅用于身份识别，不会被第三方用于其他用途。</span>
                  </div>
                  <div className="flex gap-2 items-start">
                    <span className="mt-0.5">⚙</span>
                    <span>达到累计时长 + 最大进度 ≥ 60% 双条件后，系统将自动停止本课程后续提醒。</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
