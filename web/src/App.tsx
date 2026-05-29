import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { Toaster } from 'sonner';
import { Loader2 } from 'lucide-react';
import Layout from '@/components/Layout';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Recommend = lazy(() => import('@/pages/Recommend'));
const Analyze = lazy(() => import('@/pages/Analyze'));
const Chat = lazy(() => import('@/pages/Chat'));
const History = lazy(() => import('@/pages/History'));
const HistoryDetail = lazy(() => import('@/pages/HistoryDetail'));
const Portfolio = lazy(() => import('@/pages/Portfolio'));
const Alerts = lazy(() => import('@/pages/Alerts'));
const Backtest = lazy(() => import('@/pages/Backtest'));
const StockDetail = lazy(() => import('@/pages/StockDetail'));
const Settings = lazy(() => import('@/pages/Settings'));

const ONE_MIN = 60_000;
const ONE_HOUR = 60 * ONE_MIN;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // 服务端已有缓存(Dashboard 5min / quote 30s / history 1h),
      // 前端默认 5min staleTime 减少重复发请求;关键页可在自己的 useQuery 里覆盖
      staleTime: 5 * ONE_MIN,
      gcTime: ONE_HOUR, // 旧 cacheTime,1 小时后才从内存清掉
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// 持久化到 localStorage,F5 刷新后立即显示上次的数据,后台再静默 revalidate
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'dsa-rq-cache',
  throttleTime: 1000,
});

function PageLoader() {
  return (
    <div className="text-muted-foreground flex h-[60vh] items-center justify-center gap-2 text-sm">
      <Loader2 className="animate-spin size-4" />
      加载中…
    </div>
  );
}

export default function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * ONE_MIN, // 缓存最长 24 小时
        // buster 用于版本变化时强制清缓存(以后 schema 变了可以 bump)
        buster: 'v1',
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route
              index
              element={
                <Suspense fallback={<PageLoader />}>
                  <Dashboard />
                </Suspense>
              }
            />
            <Route
              path="/recommend"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Recommend />
                </Suspense>
              }
            />
            <Route
              path="/analyze"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Analyze />
                </Suspense>
              }
            />
            <Route
              path="/chat"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Chat />
                </Suspense>
              }
            />
            <Route
              path="/portfolio"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Portfolio />
                </Suspense>
              }
            />
            <Route
              path="/alerts"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Alerts />
                </Suspense>
              }
            />
            <Route
              path="/backtest"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Backtest />
                </Suspense>
              }
            />
            <Route
              path="/stock/:code"
              element={
                <Suspense fallback={<PageLoader />}>
                  <StockDetail />
                </Suspense>
              }
            />
            <Route
              path="/settings"
              element={
                <Suspense fallback={<PageLoader />}>
                  <Settings />
                </Suspense>
              }
            />
            <Route
              path="/history"
              element={
                <Suspense fallback={<PageLoader />}>
                  <History />
                </Suspense>
              }
            />
            <Route
              path="/history/:id"
              element={
                <Suspense fallback={<PageLoader />}>
                  <HistoryDetail />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster theme="dark" position="bottom-right" richColors />
    </PersistQueryClientProvider>
  );
}
