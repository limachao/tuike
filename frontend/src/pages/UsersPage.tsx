import { useEffect, useState } from 'react';
import api from '@/lib/api';

type Role = 'SALES' | 'SUPERVISOR' | 'SUPER_ADMIN';

interface UserRow {
  id: number;
  name: string;
  phone: string;
  role: Role;
  isActive: boolean;
  wecomUserId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

const roleLabel: Record<Role, string> = {
  SALES: '销售',
  SUPERVISOR: '主管',
  SUPER_ADMIN: '超管',
};

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState({ phone: '', name: '', password: '', role: 'SALES' as Role });
  const [bindTarget, setBindTarget] = useState<UserRow | null>(null);
  const [bindId, setBindId] = useState('');
  const [bindBusy, setBindBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/users');
      setUsers(data);
    } catch (e: any) {
      alert(e.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm({ phone: '', name: '', password: '', role: 'SALES' });
    setShowForm(true);
  };

  const openEdit = (u: UserRow) => {
    setEditing(u);
    setForm({ phone: u.phone, name: u.name, password: '', role: u.role });
    setShowForm(true);
  };

  const submit = async () => {
    try {
      if (editing) {
        const payload: any = { name: form.name, role: form.role };
        if (form.password) payload.password = form.password;
        await api.patch(`/users/${editing.id}`, payload);
      } else {
        await api.post('/users', form);
      }
      setShowForm(false);
      load();
    } catch (e: any) {
      alert(e.response?.data?.message || '保存失败');
    }
  };

  const toggleActive = async (u: UserRow) => {
    await api.patch(`/users/${u.id}`, { isActive: !u.isActive });
    load();
  };

  const resetPassword = async (u: UserRow) => {
    if (!confirm(`确认将「${u.name}」的密码重置为 123456？`)) return;
    await api.patch(`/users/${u.id}`, { password: '123456' });
    alert('已重置为 123456');
  };

  const doBind = async () => {
    if (!bindTarget || !bindId) return;
    setBindBusy(true);
    try {
      await api.patch(`/users/${bindTarget.id}/bind-wecom`, { wecomUserId: bindId });
      setBindTarget(null);
      load();
    } catch (e: any) {
      alert(e.response?.data?.message || '绑定失败，请检查 userid 是否正确');
    } finally {
      setBindBusy(false);
    }
  };

  const doDelete = async (u: UserRow) => {
    if (!confirm(`确认彻底删除「${u.name}」的账号？\n\n将同时删除其名下的监控任务、学员名单、听课记录等全部数据，且不可恢复！`)) return;
    try {
      await api.delete(`/users/${u.id}`);
      alert(`已删除「${u.name}」的账号及相关数据`);
      load();
    } catch (e: any) {
      alert(e.response?.data?.message || '删除失败');
    }
  };

  return (
    <div className="page-enter space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用户管理</h1>
          <p className="text-sm text-text-tertiary mt-1">管理销售账号 · 绑定企业微信 ID · 删除账号及其数据</p>
        </div>
        <button className="btn-primary" onClick={openNew}>+ 新增账号</button>
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-text-tertiary">加载中...</div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-text-tertiary">暂无用户</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-tertiary border-b border-glass-border">
                <th className="px-5 py-3 font-medium">姓名</th>
                <th className="px-5 py-3 font-medium">手机号</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 font-medium">企微绑定</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">最近登录</th>
                <th className="px-5 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-glass-border/60 hover:bg-white/[0.02]">
                  <td className="px-5 py-3 font-medium">{u.name}</td>
                  <td className="px-5 py-3 text-text-secondary">{u.phone}</td>
                  <td className="px-5 py-3">
                    <span className={`chip ${u.role === 'SUPER_ADMIN' ? 'text-brand-400 border-brand-500/30' : ''}`}>
                      {roleLabel[u.role]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-text-tertiary">
                    {u.wecomUserId ? (
                      <span className="text-accent-mint">{u.wecomUserId}</span>
                    ) : (
                      <span className="text-accent-red/80">未绑定</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {u.isActive ? (
                      <span className="text-accent-mint">● 启用</span>
                    ) : (
                      <span className="text-accent-red">● 停用</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-text-tertiary">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '—'}
                  </td>
                  <td className="px-5 py-3 text-right space-x-2 whitespace-nowrap">
                    <button
                      className="text-brand-400 hover:text-brand-300"
                      onClick={() => { setBindTarget(u); setBindId(u.wecomUserId ?? ''); }}
                    >
                      {u.wecomUserId ? '换绑' : '绑定ID'}
                    </button>
                    <button className="text-brand-400 hover:text-brand-300" onClick={() => openEdit(u)}>编辑</button>
                    <button className="text-text-secondary hover:text-text-primary" onClick={() => resetPassword(u)}>重置密码</button>
                    <button
                      className={u.isActive ? 'text-accent-red hover:text-red-400' : 'text-accent-mint hover:text-green-400'}
                      onClick={() => toggleActive(u)}
                    >
                      {u.isActive ? '停用' : '启用'}
                    </button>
                    {u.role !== 'SUPER_ADMIN' && (
                      <button className="text-accent-red hover:text-red-400 font-medium" onClick={() => doDelete(u)}>
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 创建/编辑弹窗 */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 grid place-items-center" onClick={() => setShowForm(false)}>
          <div className="glass-card-strong w-[440px] p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">{editing ? '编辑账号' : '新增账号'}</h3>
            <div className="space-y-3">
              <div>
                <label className="label">姓名</label>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：张三" />
              </div>
              {!editing && (
                <div>
                  <label className="label">手机号（登录账号）</label>
                  <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="11位手机号" />
                </div>
              )}
              {editing && (
                <div>
                  <label className="label">手机号</label>
                  <input className="input opacity-60" value={form.phone} disabled />
                </div>
              )}
              <div>
                <label className="label">密码 {editing && '（留空则不修改）'}</label>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={editing ? '留空不修改' : '默认 123456'}
                />
              </div>
              <div>
                <label className="label">角色</label>
                <select
                  className="input"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
                >
                  <option value="SALES">销售</option>
                  <option value="SUPERVISOR">主管</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-6">
              <button className="btn-ghost" onClick={() => setShowForm(false)}>取消</button>
              <button className="btn-primary" onClick={submit}>{editing ? '保存修改' : '创建账号'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 绑定企微 ID 弹窗 */}
      {bindTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 grid place-items-center" onClick={() => setBindTarget(null)}>
          <div className="glass-card-strong w-[440px] p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-1">绑定企业微信 ID</h3>
            <p className="text-xs text-text-tertiary mb-4 leading-relaxed">
              为「{bindTarget.name}」绑定企微 userid，绑定后该账号登录即可看到自己名下的学员。
              userid 在企业微信管理后台「通讯录」→ 对应成员详情 →「账号」字段查看。
            </p>
            <input
              className="input"
              value={bindId}
              onChange={(e) => setBindId(e.target.value.trim())}
              placeholder="输入企微 userid，如 zhangsan"
              onKeyDown={(e) => e.key === 'Enter' && doBind()}
            />
            <div className="flex gap-3 justify-end mt-6">
              <button className="btn-ghost" onClick={() => setBindTarget(null)}>取消</button>
              <button className="btn-primary" disabled={bindBusy || !bindId} onClick={doBind}>
                {bindBusy ? '绑定中…' : '确认绑定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
