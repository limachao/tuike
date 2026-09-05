import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/store/auth';
import AppLayout from '@/layouts/AppLayout';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import CoursesPage from '@/pages/CoursesPage';
import CustomersPage from '@/pages/CustomersPage';
import TaskCreatePage from '@/pages/TaskCreatePage';
import TaskDetailPage from '@/pages/TaskDetailPage';
import ReminderTasksPage from '@/pages/ReminderTasksPage';
import ReminderTaskDetailPage from '@/pages/ReminderTaskDetailPage';
import QuickSendPage from '@/pages/QuickSendPage';
import TransferPage from '@/pages/TransferPage';
import UsersPage from '@/pages/UsersPage';

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
  );
}

export default App;
