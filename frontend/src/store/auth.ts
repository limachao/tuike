import { create } from 'zustand';

export interface UserInfo {
  id: number;
  name: string;
  phone: string;
  role: 'SALES' | 'SUPERVISOR' | 'SUPER_ADMIN';
  avatarUrl?: string | null;
  wecomUserId?: string | null;
}

interface AuthStore {
  token: string | null;
  user: UserInfo | null;
  setAuth: (token: string, user: UserInfo) => void;
  logout: () => void;
  hydrate: () => void;
}

export const useAuth = create<AuthStore>((set) => ({
  token: null,
  user: null,
  setAuth: (token, user) => {
    localStorage.setItem('tk_token', token);
    localStorage.setItem('tk_user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('tk_token');
    localStorage.removeItem('tk_user');
    set({ token: null, user: null });
    location.href = '/login';
  },
  hydrate: () => {
    const token = localStorage.getItem('tk_token');
    const raw = localStorage.getItem('tk_user');
    if (token && raw) {
      try {
        const user = JSON.parse(raw) as UserInfo;
        set({ token, user });
      } catch {}
    }
  },
}));
