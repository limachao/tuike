import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/store/auth';
import AppLayout from '@/layouts/AppLayout';

// 路由级懒加载：各页面（含 hls.js 播放库等大依赖）拆成独立 chunk，
// 首屏只加载当前路由，显著降低首屏 JS 体积
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const CoursesPage = lazy(() => import('@/pages/CoursesPage'));
const CustomersPage = lazy(() => import('@/pages/CustomersPage'));
const TaskCreatePage = lazy(() => import('@/pages/TaskCreatePage'));
const TaskDetailPage = lazy(() => import('@/pages/TaskDetailPage'));
const ReminderTasksPage = lazy(() => import('@/pages/ReminderTasksPage'));
const ReminderTaskDetailPage = lazy(() => import('@/pages/ReminderTaskDetailPage'));
const QuickSendPage = lazy(() => import('@/pages/QuickSendPage'));
const TransferPage = lazy(() => import('@/pages/TransferPage'));
const PlayPage = lazy(() => import('@/pages/PlayPage'));
const UsersPage = lazy(() => import('@/pages/UsersPage'));

/** 页面 chunk 加载中的占位 */
function PageLoading() {
  return (
    <div className="min-h-[60vh] grid place-items-center text-text-tertiary text-sm">
      加载中…
    </div>
  );
}

function RequireAuth({ children, roles }: { children: JSX.Element; roles?: string[] }) {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  if (roles && user && !roles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}

function App() {
  const hydrate = useAuth((s) => s.hydrate);
  useEffect(() => hydrate(), [hydrate]);

  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        {/* 公开中转页 */}
        <Route path="/course/:feiceLiveRoomId" element={<TransferPage />} />
        {/* 登录 */}
        <Route path="/login" element={<LoginPage />} />
        {/* 管理端（需要登录） */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="courses" element={<CoursesPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="tasks/new" element={<TaskCreatePage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="reminders" element={<ReminderTasksPage />} />
          <Route path="reminders/:id" element={<ReminderTaskDetailPage />} />
          <Route path="quick-send" element={<QuickSendPage />} />
          <Route path="play/:courseId" element={<PlayPage />} />
          <Route
            path="users"
            element={
              <RequireAuth roles={['SUPERVISOR', 'SUPER_ADMIN']}>
                <UsersPage />
              </RequireAuth>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
