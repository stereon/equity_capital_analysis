import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp,
  Play,
  Loader2,
  Target,
  Activity,
  Trophy,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type BacktestResult,
  type BacktestPerformance,
} from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn, formatPercent, formatPrice, changeColor } from '@/lib/utils';

const PAGE_SIZE = 20;
const DEFAULT_WINDOW = 20;

export default function Backtest() {
  const [evalWindow, setEvalWindow] = useState(DEFAULT_WINDOW);
  const [filterCode, setFilterCode] = useState('');
  const [page, setPage] = useState(1);

  const perfQ = useQuery({
    queryKey: ['backtest-performance', evalWindow],
    queryFn: () => api.backtestPerformance({ eval_window_days: evalWindow }),
  });

  const resultsQ = useQuery({
    queryKey: ['backtest-results', evalWindow, filterCode, page],
    queryFn: () =>
      api.backtestResults({
        eval_window_days: evalWindow,
        code: filterCode.trim() || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <TrendingUp className="size-5" />
          回测
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          基于历史分析记录,在到期后回查实际行情,计算方向命中率、止盈止损命中、模拟收益。
        </p>
      </header>

      <RunBacktestCard
        defaultWindow={evalWindow}
        onWindowChange={setEvalWindow}
      />

      <PerformanceCards perf={perfQ.data} loading={perfQ.isLoading} />

      <ResultsCard
        results={resultsQ.data?.items || []}
        total={resultsQ.data?.total ?? 0}
        page={page}
        loading={resultsQ.isLoading}
        filterCode={filterCode}
        onFilterCodeChange={(c) => {
          setFilterCode(c);
          setPage(1);
        }}
        onPageChange={setPage}
      />
    </div>
  );
}

function RunBacktestCard({
  defaultWindow,
  onWindowChange,
}: {
  defaultWindow: number;
  onWindowChange: (n: number) => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [force, setForce] = useState(false);
  const [evalWindow, setEvalWindow] = useState(defaultWindow);
  const [limit, setLimit] = useState(200);

  const mut = useMutation({
    mutationFn: () =>
      api.backtestRun({
        code: code.trim() || undefined,
        force,
        eval_window_days: evalWindow,
        limit,
      }),
    onSuccess: (r) => {
      toast.success(
        `回测完成 — 处理 ${r.processed} / 写入 ${r.saved} / 完成 ${r.completed} / 数据不足 ${r.insufficient} / 错误 ${r.errors}`,
        { duration: 8000 },
      );
      onWindowChange(evalWindow);
      qc.invalidateQueries({ queryKey: ['backtest-performance'] });
      qc.invalidateQueries({ queryKey: ['backtest-results'] });
    },
    onError: (e: Error) => toast.error(`回测失败: ${e.message}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">运行回测</CardTitle>
        <CardDescription>
          扫描历史分析记录,等待窗口过期后从行情拉真实走势,评估方向准确性和模拟收益
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="flex flex-col gap-1.5">
            <Label>限定股票(可选)</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="如 600519,留空跑全部"
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>评估窗口(交易日)</Label>
            <Input
              type="number"
              min={1}
              max={120}
              value={evalWindow}
              onChange={(e) => setEvalWindow(Math.max(1, Number(e.target.value) || DEFAULT_WINDOW))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>处理上限</Label>
            <Input
              type="number"
              min={1}
              max={2000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 200))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>强制重算</Label>
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="size-4"
              />
              <span className="text-xs">忽略已有结果</span>
            </label>
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              className="w-full"
            >
              {mut.isPending ? <Loader2 className="animate-spin" /> : <Play />}
              {mut.isPending ? '运行中' : '运行回测'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PerformanceCards({
  perf,
  loading,
}: {
  perf?: BacktestPerformance;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-2 h-8 w-24" />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }
  if (!perf || perf.total_evaluations === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center text-sm">
          <Activity className="text-muted-foreground mx-auto mb-2 size-6" />
          尚无回测结果。先点上方「运行回测」生成数据。
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="方向准确率"
          value={perf.direction_accuracy_pct}
          suffix="%"
          icon={Target}
          accent={
            (perf.direction_accuracy_pct ?? 0) >= 60
              ? 'success'
              : (perf.direction_accuracy_pct ?? 0) >= 50
                ? 'info'
                : 'destructive'
          }
        />
        <MetricCard
          label="胜率"
          value={perf.win_rate_pct}
          suffix="%"
          icon={Trophy}
          accent={(perf.win_rate_pct ?? 0) >= 50 ? 'success' : 'destructive'}
        />
        <MetricCard
          label="平均实际收益"
          value={perf.avg_stock_return_pct}
          suffix="%"
          icon={TrendingUp}
          accent={(perf.avg_stock_return_pct ?? 0) >= 0 ? 'success' : 'destructive'}
        />
        <MetricCard
          label="平均模拟收益"
          value={perf.avg_simulated_return_pct}
          suffix="%"
          icon={Activity}
          accent={(perf.avg_simulated_return_pct ?? 0) >= 0 ? 'success' : 'destructive'}
        />
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 py-2 text-sm sm:grid-cols-6">
          <Mini label="评估总数" value={perf.total_evaluations} />
          <Mini label="完成" value={perf.completed_count} />
          <Mini label="数据不足" value={perf.insufficient_count} />
          <Mini label="多头" value={perf.long_count} />
          <Mini label="空仓" value={perf.cash_count} />
          <Mini label="窗口" value={`${perf.eval_window_days}d`} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 py-2 text-sm sm:grid-cols-4">
          <Mini
            label="止损命中率"
            value={
              perf.stop_loss_trigger_rate != null
                ? `${perf.stop_loss_trigger_rate.toFixed(1)}%`
                : '—'
            }
            accent="destructive"
          />
          <Mini
            label="止盈命中率"
            value={
              perf.take_profit_trigger_rate != null
                ? `${perf.take_profit_trigger_rate.toFixed(1)}%`
                : '—'
            }
            accent="success"
          />
          <Mini
            label="模糊率"
            value={perf.ambiguous_rate != null ? `${perf.ambiguous_rate.toFixed(1)}%` : '—'}
          />
          <Mini
            label="首次命中均天数"
            value={
              perf.avg_days_to_first_hit != null
                ? perf.avg_days_to_first_hit.toFixed(1)
                : '—'
            }
          />
        </CardContent>
      </Card>
    </>
  );
}

function ResultsCard({
  results,
  total,
  page,
  loading,
  filterCode,
  onFilterCodeChange,
  onPageChange,
}: {
  results: BacktestResult[];
  total: number;
  page: number;
  loading: boolean;
  filterCode: string;
  onFilterCodeChange: (s: string) => void;
  onPageChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">回测结果</CardTitle>
            <CardDescription>{total > 0 ? `共 ${total} 条 · 第 ${page} / ${totalPages} 页` : '加载中…'}</CardDescription>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>按代码筛选</Label>
            <Input
              value={filterCode}
              onChange={(e) => onFilterCodeChange(e.target.value)}
              placeholder="如 600519"
              className="font-mono w-48"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-sm">
            <AlertTriangle className="size-6 opacity-60" />
            无回测结果
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>分析日期</TableHead>
                  <TableHead>代码</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>建议</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead className="text-right">入场价</TableHead>
                  <TableHead className="text-right">实际收益</TableHead>
                  <TableHead className="text-right">模拟收益</TableHead>
                  <TableHead>结果</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <ResultRow key={r.analysis_history_id} r={r} />
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  <ChevronLeft />
                  上一页
                </Button>
                <span className="text-muted-foreground text-sm">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => onPageChange(page + 1)}
                >
                  下一页
                  <ChevronRight />
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ResultRow({ r }: { r: BacktestResult }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-xs">{r.analysis_date || '—'}</TableCell>
      <TableCell className="font-mono text-sm">
        <a className="hover:underline" href={`/stock/${encodeURIComponent(r.code)}`}>
          {r.code}
        </a>
      </TableCell>
      <TableCell className="text-sm">{r.stock_name || '—'}</TableCell>
      <TableCell>
        <Badge variant={adviceVariant(r.operation_advice)}>
          {r.operation_advice || '—'}
        </Badge>
      </TableCell>
      <TableCell>
        <DirectionBadge
          expected={r.direction_expected}
          correct={r.direction_correct}
          actual={r.actual_movement}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.start_price != null ? formatPrice(r.start_price, 2) : '—'}
      </TableCell>
      <TableCell className={cn('text-right font-medium tabular-nums', changeColor(r.stock_return_pct))}>
        {formatPercent(r.stock_return_pct)}
      </TableCell>
      <TableCell
        className={cn('text-right tabular-nums', changeColor(r.simulated_return_pct))}
      >
        {formatPercent(r.simulated_return_pct)}
      </TableCell>
      <TableCell>
        <OutcomeBadge
          outcome={r.outcome}
          hitTakeProfit={r.hit_take_profit}
          hitStopLoss={r.hit_stop_loss}
          firstHit={r.first_hit}
        />
      </TableCell>
    </TableRow>
  );
}

function adviceVariant(advice?: string | null): 'success' | 'destructive' | 'warning' | 'secondary' {
  const s = (advice || '').toLowerCase();
  if (s.includes('买') || s.includes('buy')) return 'success';
  if (s.includes('卖') || s.includes('减') || s.includes('sell')) return 'destructive';
  if (s.includes('持') || s.includes('观望') || s.includes('hold')) return 'warning';
  return 'secondary';
}

function DirectionBadge({
  expected,
  correct,
  actual,
}: {
  expected?: string | null;
  correct?: boolean | null;
  actual?: string | null;
}) {
  if (!expected && !actual) return <span className="text-muted-foreground text-xs">—</span>;
  const variant: 'success' | 'destructive' | 'secondary' = correct === true
    ? 'success'
    : correct === false
      ? 'destructive'
      : 'secondary';
  return (
    <div className="flex items-center gap-1">
      <Badge variant={variant} className="text-[10px]">
        预期 {expected || '?'}
      </Badge>
      {actual && (
        <span className="text-muted-foreground text-xs">→ {actual}</span>
      )}
    </div>
  );
}

function OutcomeBadge({
  outcome,
  hitTakeProfit,
  hitStopLoss,
  firstHit,
}: {
  outcome?: string | null;
  hitTakeProfit?: boolean | null;
  hitStopLoss?: boolean | null;
  firstHit?: string | null;
}) {
  if (hitTakeProfit) {
    return <Badge variant="success">止盈{firstHit === 'take_profit' ? '✓' : ''}</Badge>;
  }
  if (hitStopLoss) {
    return <Badge variant="destructive">止损{firstHit === 'stop_loss' ? '✓' : ''}</Badge>;
  }
  if (!outcome) return <span className="text-muted-foreground text-xs">—</span>;
  const s = outcome.toLowerCase();
  const variant: 'success' | 'destructive' | 'warning' | 'secondary' = s.includes('win')
    ? 'success'
    : s.includes('loss')
      ? 'destructive'
      : s.includes('neutral')
        ? 'warning'
        : 'secondary';
  return <Badge variant={variant}>{outcome}</Badge>;
}

function MetricCard({
  label,
  value,
  suffix,
  icon: Icon,
  accent,
}: {
  label: string;
  value?: number | null;
  suffix?: string;
  icon?: typeof Target;
  accent?: 'success' | 'destructive' | 'info';
}) {
  const cls =
    accent === 'success'
      ? 'text-[color:var(--success)]'
      : accent === 'destructive'
        ? 'text-[color:var(--destructive)]'
        : accent === 'info'
          ? 'text-[color:var(--info)]'
          : '';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-muted-foreground flex items-center justify-between text-xs font-medium">
          {label}
          {Icon && <Icon className={cn('size-4', cls)} />}
        </CardTitle>
        <div className="flex items-baseline gap-1">
          <span className={cn('text-2xl font-bold tabular-nums', cls)}>
            {value == null ? '—' : value.toFixed(2)}
          </span>
          {value != null && suffix && (
            <span className="text-muted-foreground text-xs">{suffix}</span>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function Mini({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: 'success' | 'destructive';
}) {
  const cls =
    accent === 'success'
      ? 'text-[color:var(--success)]'
      : accent === 'destructive'
        ? 'text-[color:var(--destructive)]'
        : '';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-base font-semibold tabular-nums', cls)}>{value}</span>
    </div>
  );
}
