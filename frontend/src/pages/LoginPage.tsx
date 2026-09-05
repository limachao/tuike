import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { useAuth } from '@/store/auth';

export default function LoginPage() {
  const setAuth = useAuth((s) => s.setAuth);
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [pwd, setPwd] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { phone, password: pwd });
      setAuth(data.token, data.user);
      navigate('/dashboard', { replace: true });
    } catch (e: any) {
      setErr(e?.response?.data?.message ?? '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full grid md:grid-cols-2">
      {/* 左：品牌展示 */}
      <div className="hidden md:flex relative overflow-hidden items-center justify-center p-10 bg-apple-gradient">
        <div className="absolute inset-0 bg-grid-pattern [background-size:24px_24px] opacity-30" />
        <div className="relative z-10 max-w-md space-y-6">
          <div className="inline-flex chip">V1.0 首期核心版</div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            让每个学员
            <br />
            都能<span className="bg-gradient-to-r from-brand-300 to-accent-pink bg-clip-text text-transparent">及时听完课</span>
          </h1>
          <p className="text-text-secondary leading-relaxed">
            一键选择自己的企业微信客户，为每场课程建立固定应听名单。
            自动同步飞策直播与回放数据，生成未听课名单，创建企业微信官方群发提醒任务。
          </p>
          <div className="grid grid-cols-2 gap-3 pt-2">
            {[
              ['从未进入名单', '自动生成，一键提醒'],
              ['听课不足 60%', '直播回放合并计算'],
              ['统一中转页', '身份追踪 + 一键停止'],
              ['官方群发接口', '不绕过销售确认'],
            ].map(([t, d]) => (
              <div key={t} className="glass-card p-3">
                <div className="text-sm font-semibold">{t}</div>
                <div className="text-[11px] text-text-tertiary mt-1">{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右：登录卡片 */}
      <div className="flex items-center justify-center p-6">
        <form
          onSubmit={submit}
          className="glass-card-strong w-full max-w-md p-8 space-y-6"
        >
          <div>
            <div className="text-2xl font-semibold tracking-tight">欢迎回来</div>
            <div className="text-sm text-text-secondary mt-1">
              请使用手机号和密码登录推课控制台
            </div>
          </div>

          <div>
            <label className="label">手机号</label>
            <input
              className="input"
              inputMode="numeric"
              placeholder="13800000000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="label">密码</label>
            <input
              type="password"
              className="input"
              placeholder="至少 6 位"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
            />
          </div>

          {err && (
            <div className="rounded-xl border border-accent-red/40 bg-accent-red/10 text-accent-red text-sm px-3 py-2">
              {err}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full py-3">
            {loading ? '登录中…' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
}
