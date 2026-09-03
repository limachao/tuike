import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('tk_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('tk_token');
      localStorage.removeItem('tk_user');
      if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/course/')) {
        location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

export default api;

// 中转页用的公开接口（前缀 /transfer，不走 /api）
export const transferApi = axios.create({
  baseURL: '/transfer',
  timeout: 30000,
});
