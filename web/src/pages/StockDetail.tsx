import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  LineChart as ChartIcon,
  RefreshCw,
  Loader2,
  Play,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatPercent, formatPrice, changeColor } from '@/lib/utils';

// echarts chunk 较大,懒加载
const KLineChart = lazy(() => import('@/components/KLineChart'));

type Period = 'daily' | 'weekly' | 'monthly';
type Days = 30 | 60 | 120 | 250;

export default function StockDetail() {
  const { code } = useParams<{ code: string }>();
  const [period, setPeriod] = useState<Period>('daily');
  const [days, setDays] = useState<Days>(120);

  const quoteQ = useQuery({
    queryKey: ['stock-quote', code],
    queryFn: () => api.stockQuote(code!),
    enabled: !!code,
    refetchInterval: 30_000,
  });

  const histQ = useQuery({
    queryKey: ['stock-history', code, period, days],
    queryFn: () => api.stockHistory(code!, { period, days }),
    enabled: !!code,
  });

  if (!code) return null;

  const quote = quoteQ.data;
  const name = quote?.stock_name || histQ.data?.stock_name || '';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
            <Link to="/recommend">
              <ArrowLeft />
              返回
            </Link>
          </Button>
          <h1 className="flex items-baseline gap-3">
            <span className="text-2xl font-bold tracking-tight">{name || '加载中…'}</span>
            <span className="text-muted-foreground font-mono text-base">{code}</span>
          </h1>
          {quote && (
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-3xl font-bold tabular-nums">{formatPrice(quote.current_price)}</span>
              <span className={cn('text-base font-semibold tabular-nums', changeColor(quote.change_percent))}>
                {formatPercent(quote.change_percent)}
              </span>
              <span className={cn('text-sm tabular-nums', changeColor(quote.change))}>
                {quote.change != null ? `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}` : ''}
              </span>
              {quote.update_time && (
                <span className="text-muted-foreground text-xs">· {quote.update_time}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => { quoteQ.refetch(); histQ.refetch(); }} disabled={quoteQ.isFetching || histQ.isFetching}>
            {(quoteQ.isFetching || histQ.isFetching) ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
          <Button size="sm" asChild>
            <Link to={`/analyze?code=${encodeURIComponent(code)}`}>
              <Play />
              触发 AI 分析
            </Link>
          </Button>
        </div>
      </header>

      {/* 关键指标 */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-2 sm:grid-cols-6">
          {quoteQ.isLoading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)
          ) : (
            <>
              <Stat label="开盘" value={quote?.open} />
              <Stat label="最高" value={quote?.high} accent="destructive" />
              <Stat label="最低" value={quote?.low} accent="success" />
              <Stat label="昨收" value={quote?.prev_close} />
              <Stat label="成交量" value={quote?.volume} unit="股" big />
              <Stat label="成交额" value={quote?.amount} unit="元" big />
            </>
          )}
        </CardContent>
      </Card>

      {/* 周期 + 天数切换 */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ChartIcon className="size-4" />
                K 线图
              </CardTitle>
              <CardDescription>
                {period === 'daily' ? '日 K' : period === 'weekly' ? '周 K' : '月 K'} · 近 {days} 个周期
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="bg-muted/40 inline-flex rounded-md border p-0.5">
                {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={cn(
                      'rounded px-3 py-1 text-xs font-medium transition-colors',
                      period === p
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {p === 'daily' ? '日' : p === 'weekly' ? '周' : '月'}
                  </button>
                ))}
              </div>
              <div className="bg-muted/40 inline-flex rounded-md border p-0.5">
                {([30, 60, 120, 250] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={cn(
                      'rounded px-3 py-1 text-xs font-medium transition-colors',
                      days === d
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {histQ.isLoading ? (
            <Skeleton className="h-[480px] w-full" />
          ) : histQ.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              加载 K 线失败: {(histQ.error as Error)?.message}
            </div>
          ) : !histQ.data?.data || histQ.data.data.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              暂无 K 线数据
            </div>
          ) : (
            <Suspense fallback={<Skeleton className="h-[480px] w-full" />}>
              <KLineChart data={histQ.data.data} />
            </Suspense>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  accent,
  big,
}: {
  label: string;
  value?: number | null;
  unit?: string;
  accent?: 'success' | 'destructive';
  big?: boolean;
}) {
  const cls =
    accent === 'success'
      ? 'text-[color:var(--success)]'
      : accent === 'destructive'
        ? 'text-[color:var(--destructive)]'
        : '';
  let display: string;
  if (value == null) display = '—';
  else if (big) {
    if (Math.abs(value) >= 1e8) display = (value / 1e8).toFixed(2) + ' 亿';
    else if (Math.abs(value) >= 1e4) display = (value / 1e4).toFixed(2) + ' 万';
    else display = value.toLocaleString();
  } else display = value.toFixed(2);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className={cn('text-lg font-bold tabular-nums', cls)}>{display}</span>
        {value != null && unit && <span className="text-muted-foreground text-xs">{unit}</span>}
      </div>
    </div>
  );
}
