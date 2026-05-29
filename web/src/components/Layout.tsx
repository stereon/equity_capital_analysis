import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Sparkles, LineChart, History, Activity, Briefcase, Bell, TrendingUp, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const nav = [
  { to: '/', label: '大盘', icon: LayoutDashboard, end: true },
  { to: '/recommend', label: '荐股', icon: Sparkles },
  { to: '/analyze', label: '分析', icon: LineChart },
  { to: '/portfolio', label: '持仓', icon: Briefcase },
  { to: '/alerts', label: '告警', icon: Bell },
  { to: '/backtest', label: '回测', icon: TrendingUp },
  { to: '/history', label: '历史', icon: History },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

export default function Layout() {
  return (
    <div className="flex min-h-screen">
      {/* 侧栏 */}
      <aside className="border-border bg-card flex w-56 flex-col border-r">
        <div className="flex h-14 items-center gap-2 border-b px-5">
          <Activity className="text-primary size-5" />
          <span className="font-semibold tracking-tight">DSA Agent</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-4 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">本地 Agent</div>
          <div className="mt-0.5">本地 Claude + Tavily</div>
        </div>
      </aside>

      {/* 主内容 */}
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
