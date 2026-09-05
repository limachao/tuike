import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/store/auth';

const MENU = [
  { to: '/dashboard', label: '工作台', icon: '⊞', roles: ['SALES', 'SUPERVISOR', 'SUPER_ADMIN'] },
  { to: '/courses', label: '课程库', icon: '◉', roles: ['SALES', 'SUPERVISOR', 'SUPER_ADMIN'] },
  { to: '/tasks/new', label: '新建任务', icon: '＋', roles: ['SUPERVISOR', 'SUPER_ADMIN'] },
  { to: '/reminders', label: '提醒任务', icon: '✉', roles: ['SALES', 'SUPERVISOR', 'SUPER_ADMIN'] },
  { to: '/quick-send', label: '快捷群发', icon: '⚡', roles: ['SALES', 'SUPERVISOR', 'SUPER_ADMIN'] },
  { to: '/users', label: '用户管理', icon: '⚙', roles: ['SUPERVISOR', 'SUPER_ADMIN'] },
];

export default function AppLayout() {
  const auth = useAuth();
  const loc = useLocation();

  return (
    <div className="min-h-screen w-full flex">
      {/* 侧边栏 */}
      <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-glass-border bg-glass/60 backdrop-blur-xl p-5 gap-6">
        <div className="flex items-center gap-2 px-1">
          <div className="h-9 w-9 rounded-xl grid place-items-center" style={{background: 'linear-gradient(145deg, #E8C547, #D4AF37, #947617)', boxShadow: '0 8px 20px -6px rgba(212,175,55,0.55), inset 0 1px 0 rgba(255,255,255,0.35)'}}>
            <span className="text-[#1a1508] font-bold text-sm">推</span>
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight">推课神器</div>
            <div className="text-[11px] text-text-tertiary">当当老师研发，仅供内部使用</div>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {MENU.filter((m) => !m.roles || m.roles.includes(auth.user?.role || '')).map((m) => {
            const active =
              m.to === loc.pathname ||
              (m.to === '/tasks/new' && loc.pathname.startsWith('/tasks')) ||
              (m.to === '/reminders' && loc.pathname.startsWith('/reminders')) ||
              (m.to === '/quick-send' && loc.pathname.startsWith('/quick-send')) ||
              (m.to === '/courses' && loc.pathname === '/courses');
            return (
              <NavLink
                key={m.to}
                to={m.to}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
                  active
                    ? 'bg-gradient-to-r from-brand-500/15 to-brand-400/5 text-white shadow-soft border border-brand-500/25'
                    : 'text-text-secondary hover:text-white hover:bg-white/5 border border-transparent'
                }`}
              >
                <span className={`text-lg ${active ? 'text-brand-400' : 'text-text-tertiary'}`}>
                  {m.icon}
                </span>
                <span className="font-medium">{m.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-4">
          <div className="divider" />
          <div className="flex items-center gap-3 rounded-xl p-2 bg-white/[0.03] border border-glass-border">
            <div className="h-9 w-9 rounded-full grid place-items-center text-sm font-semibold text-[#1a1508]" style={{background: 'linear-gradient(145deg, #EAD288, #D4AF37)'}}>
              {auth.user?.name?.slice(0, 1) ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{auth.user?.name}</div>
              <div className="text-[11px] text-text-tertiary">
                {auth.user?.role === 'SUPERVISOR' ? '主管' : '销售老师'}
              </div>
            </div>
            <button
              onClick={auth.logout}
              title="退出登录"
              className="text-text-tertiary hover:text-accent-red text-sm"
            >
              ⏻
            </button>
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto p-4 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
