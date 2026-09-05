import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';

export default function QuickSendPage() {
  const nav = useNavigate();
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadCustomers = async () => {
    try {
      const { data } = await api.get('/courses/my-customers', {
        params: { keyword: keyword || undefined },
      });
      setCustomers(data.list ?? []);
      setLoaded(true);
    } catch (e) {
      console.error(e);
      setLoaded(true);
    }
  };

  useEffect(() => { loadCustomers(); }, [keyword]);

  const toggle = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  };

  const toggleAll = () => {
    if (selected.size === customers.length) setSelected(new Set());
    else setSelected(new Set(customers.map((c) => c.id)));
  };

  const send = async () => {
    if (!content.trim()) { alert('请输入文案'); return; }
    if (!url.trim()) { alert('请输入网址'); return; }
    if (selected.size === 0) { alert('请至少选择一位客户'); return; }
    if (!confirm(`确定发送给 ${selected.size} 位客户吗？\n\n销售需要在企业微信手机端确认后，客户才会收到消息。`)) return;
    setSending(true);
    try {
      const { data } = await api.post('/reminder/quick-send', {
        content: content.trim(),
        url: url.trim(),
        customerIds: [...selected],
      });
      alert(`已创建群发任务 #${data.messageTask.id}！\n请到企业微信手机端确认发送。`);
      nav(`/reminders/${data.messageTask.id}`);
    } catch (e: any) {
      alert(e?.response?.data?.message ?? '发送失败，请重试');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Quick Send</div>
        <h1 className="text-2xl font-semibold tracking-tight">快捷群发</h1>
        <div className="text-sm text-text-secondary mt-1">
          写文案 + 粘贴网址 → 选客户 → 发送 → 企业微信手机端确认 → 客户收到
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_420px] gap-6">
        {/* 左：文案 + 客户列表 */}
        <div className="space-y-4">
          {/* 文案输入 */}
          <div className="glass-card p-5 space-y-4">
            <div>
              <label className="label">发送文案</label>
              <textarea
                rows={4}
                className="input resize-none"
                placeholder="输入要发送给客户的文案内容…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
              <div className="text-[11px] text-text-tertiary mt-1">{content.length} 字</div>
            </div>
            <div>
              <label className="label">附带网址（链接标题默认「点击进入」）</label>
              <input
                className="input"
                placeholder="https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>

          {/* 客户列表 */}
          <div className="glass-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                placeholder="搜索客户昵称 / 手机号"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <button onClick={toggleAll} className="btn-ghost !py-2 whitespace-nowrap">
                {selected.size === customers.length && customers.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>

            <div className="overflow-x-auto scroll-thin -mx-2 px-2 max-h-[480px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#1c1c28]/95 backdrop-blur z-10">
                  <tr className="text-left text-xs text-text-tertiary">
                    <th className="py-2 pr-3 w-10"></th>
                    <th className="py-2 pr-4">客户</th>
                    <th className="py-2 pr-4">备注手机</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.length === 0 ? (
                    <tr><td colSpan={3} className="text-center py-12 text-text-tertiary">
                      {loaded ? '暂无客户或未搜索到' : '加载中…'}
                    </td></tr>
                  ) : customers.map((c) => (
                    <tr key={c.id} className="border-t border-glass-border hover:bg-white/[0.02]">
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          className="w-4 h-4"
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-brand-500/40 to-accent-pink/40 grid place-items-center text-[11px] font-medium shrink-0">
                            {c.nickname?.slice(0, 1) ?? '·'}
                          </div>
                          <span className="font-medium truncate">{c.nickname}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-text-secondary text-xs">
                        {c.remarkMobiles || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-text-tertiary pt-1">
              共 {customers.length} 人 · 已选 {selected.size} 人
            </div>
          </div>
        </div>

        {/* 右：预览 + 发送 */}
        <div className="space-y-4">
          <div className="glass-card-strong p-5 space-y-4 sticky top-4">
            <div className="text-[11px] text-text-tertiary uppercase tracking-widest">Preview</div>

            {/* 模拟微信消息卡片 */}
            <div className="rounded-xl bg-[#2a2a3a] border border-glass-border p-4 space-y-3">
              <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-all">
                {content || <span className="text-text-tertiary">（文案预览区域）</span>}
              </div>
              {url && (
                <div className="flex items-center gap-3 rounded-lg bg-white/[0.04] border border-glass-border p-3">
                  <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-brand-500/30 to-accent-pink/30 grid place-items-center shrink-0">
                    <span className="text-lg">🔗</span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">点击进入</div>
                    <div className="text-[11px] text-text-tertiary truncate">{url}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="glass-card p-3 text-center">
                <div className="text-xl font-semibold text-brand-300">{selected.size}</div>
                <div className="text-[11px] text-text-tertiary">接收客户</div>
              </div>
              <div className="glass-card p-3 text-center">
                <div className="text-sm font-semibold text-accent-amber">{content.length}</div>
                <div className="text-[11px] text-text-tertiary">文案字数</div>
              </div>
            </div>

            <div className="rounded-xl border border-glass-border p-3 space-y-1.5 bg-white/[0.02]">
              <div className="text-[11px] text-text-tertiary uppercase tracking-widest">发送须知</div>
              <ul className="text-xs text-text-secondary space-y-1 list-disc pl-4">
                <li>提交后<b className="text-white">销售在企业微信收到待确认</b>，客户不会立即收到</li>
                <li>每位客户每天最多收到 1 条 API 群发消息</li>
                <li>销售手机确认后客户才真正收到</li>
              </ul>
            </div>

            <button
              onClick={send}
              disabled={sending}
              className="btn-primary w-full"
            >
              {sending ? '正在提交…' : `✉ 发送给 ${selected.size} 位客户`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
