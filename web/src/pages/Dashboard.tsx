import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Activity,
  Loader2,
  Newspaper,
  CheckCircle2,
  AlertCircle,
  Sunrise,
  Sunset,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type BriefingTaskStatus } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn, formatPercent, formatPrice, changeColor } from '@/lib/utils';

type Region = 'cn' | 'hk' | 'us';
const REGION_LABEL: Record<Region, string> = { cn: 'A 股', hk: '港股', us: '美股' };

interface MarketReviewTask {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  message?: string;
  error?: string;
}

export default function Dashboard() {
  const [region, setRegion] = useState<Region>('cn');
  const [mrTask, setMrTask] = useState<MarketReviewTask | null>(null);
  const [briefingTask, setBriefingTask] = useState<BriefingTaskStatus | null>(null);
  const pollingRef = useRef<number | null>(null);
  const briefingPollingRef = useRef<number | null>(null);
  const navigate = useNavigate();

  const q = useQuery({
    queryKey: ['dashboard', region],
    queryFn: () => api.dashboard(region),
    refetchInterval: 30_000,
  });

  const mrMutation = useMutation({
    mutationFn: () => api.marketReview(),
    onSuccess: (data) => {
      if (data.task_id) {
        setMrTask({ taskId: data.task_id, status: (data.status as MarketReviewTask['status']) || 'pending' });
      } else {
        toast.success('大盘复盘已完成');
      }
    },
    onError: (e: Error) => toast.error(`触发大盘复盘失败: ${e.message}`),
  });

  const briefingMutation = useMutation({
    mutationFn: (kind: 'morning' | 'closing') => api.briefingStart(kind),
    onSuccess: async (data) => {
      try {
        const first = await api.briefingStatus(data.task_id);
        setBriefingTask(first);
      } catch {
        setBriefingTask(null);
      }
      if (briefingPollingRef.current) window.clearInterval(briefingPollingRef.current);
      briefingPollingRef.current = window.setInterval(async () => {
        try {
          const s = await api.briefingStatus(data.task_id);
          setBriefingTask(s);
          if (s.status === 'completed') {
            window.clearInterval(briefingPollingRef.current!);
            briefingPollingRef.current = null;
            const label = s.kind === 'morning' ? '早盘播报' : '收盘总结';
            toast.success(`${label}完成,可去「历史」查看`);
          } else if (s.status === 'failed') {
            window.clearInterval(briefingPollingRef.current!);
            briefingPollingRef.current = null;
            toast.error(`生成失败: ${s.error || '未知错误'}`);
          }
        } catch {
          /* 静默 */
        }
      }, 3000);
    },
    onError: (e: Error) => toast.error(`触发失败: ${e.message}`),
  });

  useEffect(() => () => {
    if (briefingPollingRef.current) window.clearInterval(briefingPollingRef.current);
  }, []);

  const briefingRunning = briefingTask && (briefingTask.status === 'pending' || briefingTask.status === 'running');

  useEffect(() => {
    if (!mrTask || mrTask.status === 'completed' || mrTask.status === 'failed') {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    pollingRef.current = window.setInterval(async () => {
      try {
        const s = await api.taskStatus(mrTask.taskId);
        setMrTask((prev) =>
          prev
            ? {
                ...prev,
                status: (s.status as MarketReviewTask['status']) || prev.status,
                progress: s.progress,
                message: s.message,
                error: s.error,
              }
            : prev,
        );
        if (s.status === 'completed') toast.success('大盘复盘已完成,可去「历史」查看');
        if (s.status === 'failed') toast.error(`大盘复盘失败: ${s.error || '未知错误'}`);
      } catch {
        /* 静默 */
      }
    }, 3000);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [mrTask?.taskId, mrTask?.status]);

  const mrRunning = mrTask && (mrTask.status === 'pending' || mrTask.status === 'processing');

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">大盘概览</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            实时主要指数、市场统计与领涨/领跌板块。每 60s 自动刷新。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* region 切换 */}
          <div className="bg-muted/40 inline-flex rounded-md border p-0.5">
            {(['cn', 'hk', 'us'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRegion(r)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors',
                  region === r
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {REGION_LABEL[r]}
              </button>
            ))}
          </div>
          {region === 'cn' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => mrMutation.mutate()}
              disabled={mrMutation.isPending || !!mrRunning}
            >
              {mrMutation.isPending || mrRunning ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Newspaper />
              )}
              {mrRunning ? '复盘中' : '跑大盘复盘'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => briefingMutation.mutate('morning')}
            disabled={briefingMutation.isPending || !!briefingRunning}
          >
            {briefingMutation.isPending || (briefingRunning && briefingTask?.kind === 'morning') ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Sunrise />
            )}
            早盘播报
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => briefingMutation.mutate('closing')}
            disabled={briefingMutation.isPending || !!briefingRunning}
          >
            {briefingMutation.isPending || (briefingRunning && briefingTask?.kind === 'closing') ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Sunset />
            )}
            收盘总结
          </Button>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </header>

      {/* 早盘 / 收盘任务状态 */}
      {briefingTask && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {briefingTask.kind === 'morning' ? (
                <Sunrise className="size-4" />
              ) : (
                <Sunset className="size-4" />
              )}
              {briefingTask.kind === 'morning' ? '早盘播报' : '收盘总结'}
              <Badge
                variant={
                  briefingTask.status === 'completed'
                    ? 'success'
                    : briefingTask.status === 'failed'
                      ? 'destructive'
                      : 'info'
                }
              >
                {briefingTask.status === 'completed'
                  ? '完成'
                  : briefingTask.status === 'failed'
                    ? '失败'
                    : briefingTask.status === 'running'
                      ? '运行中'
                      : '排队中'}
              </Badge>
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {briefingTask.task_id} · 已耗时 {briefingTask.elapsed_seconds ?? 0}s
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {briefingTask.message && (
              <p className="text-muted-foreground text-sm">{briefingTask.message}</p>
            )}
            {briefingTask.error && <p className="text-sm text-destructive">{briefingTask.error}</p>}
            {briefingTask.status === 'completed' && briefingTask.query_id && (
              <div className="flex justify-end pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/history/${briefingTask.query_id}`)}
                >
                  查看完整报告 →
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 大盘复盘任务状态 */}
      {mrTask && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {mrTask.status === 'completed' ? (
                <CheckCircle2 className="text-[color:var(--success)] size-4" />
              ) : mrTask.status === 'failed' ? (
                <AlertCircle className="text-destructive size-4" />
              ) : (
                <Loader2 className="animate-spin size-4" />
              )}
              大盘复盘任务
              <Badge
                variant={
                  mrTask.status === 'completed'
                    ? 'success'
                    : mrTask.status === 'failed'
                      ? 'destructive'
                      : 'info'
                }
              >
                {mrTask.status === 'completed'
                  ? '完成'
                  : mrTask.status === 'failed'
                    ? '失败'
                    : '运行中'}
              </Badge>
            </CardTitle>
            <CardDescription className="font-mono text-xs">{mrTask.taskId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {mrTask.progress !== undefined && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>进度</span>
                  <span>{Math.round((mrTask.progress || 0) * 100)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-primary h-full transition-all"
                    style={{ width: `${(mrTask.progress || 0) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {mrTask.message && <p className="text-sm text-muted-foreground">{mrTask.message}</p>}
            {mrTask.error && <p className="text-sm text-destructive">{mrTask.error}</p>}
            {mrTask.status === 'completed' && (
              <div className="flex justify-end pt-1">
                <Button variant="outline" size="sm" onClick={() => navigate('/history')}>
                  查看历史 →
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 主要指数 */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          主要指数 · {REGION_LABEL[region]}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {q.isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="mt-2 h-8 w-32" />
                  </CardHeader>
                </Card>
              ))
            : q.data?.indices && q.data.indices.length > 0
              ? q.data.indices.map((idx) => (
                  <Card key={idx.code}>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        {idx.name}
                      </CardTitle>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-2xl font-bold tracking-tight">
                          {formatPrice(idx.current)}
                        </span>
                        <span className={cn('text-sm font-medium', changeColor(idx.change_pct))}>
                          {formatPercent(idx.change_pct)}
                        </span>
                      </div>
                    </CardHeader>
                  </Card>
                ))
              : (
                <Card className="sm:col-span-2 lg:col-span-4">
                  <CardContent className="text-muted-foreground py-8 text-center text-sm">
                    {REGION_LABEL[region]}指数数据不可用,请检查 yfinance 连接(美股/港股)或稍后重试。
                  </CardContent>
                </Card>
              )}
        </div>
      </section>

      {/* 市场统计 — 仅 A 股 */}
      {region === 'cn' && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">市场统计</h2>
          <Card>
            <CardContent className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {q.isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)
                ) : (
                  <>
                    <Stat label="上涨" value={q.data?.market_stats?.up} icon={TrendingUp} positive />
                    <Stat label="下跌" value={q.data?.market_stats?.down} icon={TrendingDown} negative />
                    <Stat label="涨停" value={q.data?.market_stats?.limit_up} badge="destructive" />
                    <Stat label="跌停" value={q.data?.market_stats?.limit_down} badge="success" />
                    <Stat label="平盘" value={q.data?.market_stats?.unchanged} icon={Activity} />
                  </>
                )}
              </div>
              {q.data?.market_stats?.total_amount != null && (
                <div className="flex items-center justify-between border-t pt-3 text-sm">
                  <span className="text-muted-foreground">总成交额</span>
                  <span className="font-semibold tabular-nums">
                    {q.data.market_stats.total_amount.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}{' '}
                    亿元
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* 板块 */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {region === 'cn' ? '领涨板块 Top 5' : '领涨代表 Top 5'}
            </CardTitle>
            <CardDescription>
              {region === 'cn'
                ? '按今日涨幅排序'
                : region === 'us'
                  ? '11 个 SPDR Sector ETF,按当日涨幅'
                  : '6 只代表 ETF(恒指/国企/科技/央企/医疗/亚洲50)'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {q.isLoading
              ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7" />)
              : (q.data?.top_sectors || []).length === 0
                ? <p className="text-muted-foreground text-sm">暂无数据</p>
                : (q.data?.top_sectors || []).map((s, i) => (
                    <SectorRow key={s.name + i} name={s.name} change={s.change_pct} positive />
                  ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {region === 'cn' ? '领跌板块 Top 5' : '领跌代表 Top 5'}
            </CardTitle>
            <CardDescription>
              {region === 'cn' ? '按今日跌幅排序' : '按当日跌幅(同上数据源)'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {q.isLoading
              ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7" />)
              : (q.data?.bottom_sectors || []).length === 0
                ? <p className="text-muted-foreground text-sm">暂无数据</p>
                : (q.data?.bottom_sectors || []).map((s, i) => (
                    <SectorRow key={s.name + i} name={s.name} change={s.change_pct} />
                  ))}
          </CardContent>
        </Card>
      </section>

      {region !== 'cn' && (
        <p className="text-muted-foreground text-xs">
          注:港美股的「市场统计」(涨跌停家数等)暂无可达的数据源,因此本页仅展示主要指数与代表 ETF 的走势。
        </p>
      )}

      {q.data?.generated_at && (
        <p className="text-xs text-muted-foreground">数据时间: {q.data.generated_at}</p>
      )}
      {q.isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          数据加载失败: {(q.error as Error)?.message || '未知错误'}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  positive,
  negative,
  badge,
}: {
  label: string;
  value?: number | null;
  icon?: typeof Activity;
  positive?: boolean;
  negative?: boolean;
  badge?: 'success' | 'destructive';
}) {
  const cls = positive
    ? 'text-[color:var(--success)]'
    : negative
      ? 'text-[color:var(--destructive)]'
      : badge === 'success'
        ? 'text-[color:var(--success)]'
        : badge === 'destructive'
          ? 'text-[color:var(--destructive)]'
          : '';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {Icon && <Icon className={cn('size-4', cls)} />}
        <span className={cn('text-xl font-bold tabular-nums', cls)}>{value ?? '—'}</span>
      </div>
    </div>
  );
}

function SectorRow({ name, change }: { name: string; change?: number; positive?: boolean }) {
  // 按真实涨跌符号上色,而不是按所在卡片的方向(港股全跌时领涨 Top 仍可能是负值)
  return (
    <div className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent/50">
      <span className="text-sm">{name}</span>
      <span className={cn('text-sm font-medium tabular-nums', changeColor(change))}>
        {formatPercent(change)}
      </span>
    </div>
  );
}
