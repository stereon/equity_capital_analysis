import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Loader2, Flame, Hash, FileText, History as HistoryIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type RecommendCandidate, type RecommendTaskStatus } from '@/lib/api';

const LAST_TASK_KEY = ['recommend-last-task'] as const;
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn, formatPercent, formatPrice, changeColor } from '@/lib/utils';

type Pool = 'hs300' | 'watchlist' | 'both';

const STAGE_LABELS: Record<string, string> = {
  sectors: '拉取领涨板块',
  pool: '构建候选池',
  score: '逐只评分',
  report: '生成报告',
  done: '完成',
};

export default function Recommend() {
  const queryClient = useQueryClient();
  // 切走再回来要保留最近一次结果:写入 react-query cache,由 PersistQueryClient 持久化到 localStorage
  const persistedTask = queryClient.getQueryData<RecommendTaskStatus | null>(LAST_TASK_KEY) || null;
  const [top, setTop] = useState(10);
  const [pool, setPool] = useState<Pool>('hs300');
  const [task, setTaskState] = useState<RecommendTaskStatus | null>(persistedTask);
  const [submitting, setSubmitting] = useState(false);
  const pollingRef = useRef<number | null>(null);

  const setTask = (t: RecommendTaskStatus | null) => {
    setTaskState(t);
    // 全部状态都写 cache,这样切走再回来运行中任务能继续轮询
    queryClient.setQueryData(LAST_TASK_KEY, t);
  };

  const stopPolling = () => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  // 单一轮询入口:监听 task 状态,运行中自动开始轮询;终态自动停。
  // 切走再回来,组件重新 mount 时从 cache 恢复 task,这个 effect 会自动续上轮询。
  useEffect(() => {
    if (!task || task.task_id === 'restored') {
      stopPolling();
      return;
    }
    if (task.status === 'completed' || task.status === 'failed') {
      stopPolling();
      return;
    }
    const taskId = task.task_id;
    pollingRef.current = window.setInterval(async () => {
      try {
        const s = await api.recommendStatus(taskId);
        setTask(s);
        if (s.status === 'completed') {
          stopPolling();
          toast.success(`完成,共 ${s.result?.candidates.length ?? 0} 只候选`);
        } else if (s.status === 'failed') {
          stopPolling();
          toast.error(`推荐失败: ${s.error || '未知错误'}`);
        }
      } catch (err) {
        // 后端重启 / GC 后内存里的 task 会消失;持续 404 时停止轮询并提示重跑
        if (err instanceof ApiError && err.status === 404) {
          stopPolling();
          setTask(null);
          toast.error('任务已丢失（可能因后端重启），请重新触发推荐');
          return;
        }
        /* 单次网络抖动忽略,下次再试 */
      }
    }, 2000);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.task_id, task?.status]);

  const historyQuery = useQuery({
    queryKey: ['recommend-history'],
    // 后端 history list 暂不支持 report_type 过滤,这里拉多一点再客户端筛
    queryFn: () => api.history({ limit: 50 }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const historyItems = (historyQuery.data?.items || [])
    .filter((h) => h.report_type === 'recommendation')
    .slice(0, 10);

  // 如果 cache 里没有最近任务结果,但 DB 里有历史记录,自动加载最新一条还原显示
  // 这样首次访问 / 浏览器刷新 / 切换设备 都能看到最近一次荐股
  useEffect(() => {
    if (task || !historyItems.length) return;
    let cancelled = false;
    const latest = historyItems[0];
    const id = latest.query_id || latest.record_id;
    if (!id) return;
    (async () => {
      try {
        const detail = await api.historyDetail(id);
        if (cancelled) return;
        const ctx = (detail.details?.context_snapshot as Record<string, unknown>) || {};
        const candidates = (ctx.candidates as RecommendCandidate[]) || [];
        const hot_sectors = (ctx.hot_sectors as string[]) || [];
        if (!candidates.length) return;
        const restored: RecommendTaskStatus = {
          task_id: 'restored',
          status: 'completed',
          stage: 'done',
          progress: 1,
          message: `已还原最近一次荐股 (${latest.created_at || ''})`,
          elapsed_seconds: null,
          error: null,
          result: {
            hot_sectors,
            candidates,
            pool_size: (ctx.pool_size as number) ?? candidates.length,
            report_path: null,
            query_id: detail.query_id,
            price_as_of: (ctx.price_as_of as string) ?? null,
          },
        };
        setTaskState(restored);
        queryClient.setQueryData(LAST_TASK_KEY, restored);
      } catch {
        /* 还原失败不影响主流程,用户可以重新生成 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // 故意只跟历史首条 id 联动,task 进入运行态后不再覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyItems[0]?.query_id, historyItems[0]?.record_id]);

  const handleStart = async () => {
    stopPolling();
    setTask(null);
    setSubmitting(true);
    try {
      const { task_id } = await api.recommendStart({ top, pool });
      // 立刻拉一次 status 把 UI 切到「运行中」,后续轮询由 useEffect 自动接管
      const first = await api.recommendStatus(task_id).catch(() => null);
      setTask(first || { task_id, status: 'pending', progress: 0 });
    } catch (e) {
      toast.error(`触发失败: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const running = task && (task.status === 'pending' || task.status === 'running');
  const result = task?.result || null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">候选股推荐</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          基于今日领涨板块 + 技术筛选(MA 排列 / 动量 / 量比 / 距 20 日高点 / 涨跌幅 + 命中热门板块加成)。
          异步任务,可随时切走再回来看进度。
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">参数</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">输出 Top N</label>
            <Input
              type="number"
              min={1}
              max={50}
              value={top}
              onChange={(e) => setTop(Number(e.target.value) || 10)}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">候选池</label>
            <div className="flex gap-1.5">
              {(['hs300', 'watchlist', 'both'] as const).map((p) => (
                <Button
                  key={p}
                  variant={pool === p ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPool(p)}
                >
                  {p === 'hs300' ? 'HS300' : p === 'watchlist' ? '自选股' : '两者'}
                </Button>
              ))}
            </div>
          </div>
          <Button onClick={handleStart} disabled={submitting || !!running} className="ml-auto">
            {submitting || running ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitting ? '提交中' : running ? '运行中' : '生成推荐'}
          </Button>
        </CardContent>
      </Card>

      {task && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {running ? (
                <Loader2 className="animate-spin size-4" />
              ) : task.status === 'completed' ? (
                <Sparkles className="text-[color:var(--success)] size-4" />
              ) : (
                <Hash className="text-destructive size-4" />
              )}
              任务进度
              <Badge variant={task.status === 'completed' ? 'success' : task.status === 'failed' ? 'destructive' : 'info'}>
                {task.status === 'pending'
                  ? '排队中'
                  : task.status === 'running'
                    ? '运行中'
                    : task.status === 'completed'
                      ? '完成'
                      : '失败'}
              </Badge>
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {task.task_id} · 已耗时 {task.elapsed_seconds ?? 0}s
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{task.stage ? STAGE_LABELS[task.stage] || task.stage : '准备中'}</span>
                <span>{Math.round((task.progress || 0) * 100)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-primary h-full transition-all"
                  style={{ width: `${(task.progress || 0) * 100}%` }}
                />
              </div>
            </div>
            {task.message && <p className="text-sm text-muted-foreground">{task.message}</p>}
            {task.error && <p className="text-sm text-destructive">{task.error}</p>}
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          {result.hot_sectors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Flame className="text-[color:var(--warning)] size-4" />
                  今日领涨板块 Top 5
                </CardTitle>
                <CardDescription>命中下列板块的候选股会额外加分</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {result.hot_sectors.map((s) => (
                  <Badge key={s} variant="warning" className="text-sm">
                    {s}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">候选 Top {result.candidates.length}</CardTitle>
                  <CardDescription>
                    按评分降序;点击代码可直接跳到分析页生成完整 AI 报告
                    {result.price_as_of && (
                      <span className="ml-2 text-xs">
                        · 现价 / 涨跌幅: 实时报价 ({result.price_as_of})
                      </span>
                    )}
                  </CardDescription>
                </div>
                {result.query_id && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/history/${result.query_id}`}>
                      <FileText className="size-4" />
                      查看完整报告
                    </Link>
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>代码</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>行业</TableHead>
                    <TableHead className="text-right">评分</TableHead>
                    <TableHead className="text-right">现价</TableHead>
                    <TableHead className="text-right">涨跌幅</TableHead>
                    <TableHead>关键信号</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.candidates.map((c, i) => (
                    <CandidateRow key={c.code} idx={i + 1} c={c} />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {!task && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <Sparkles className="text-muted-foreground mx-auto mb-3 size-8" />
            点「生成推荐」开始。HS300 池约 3-5 分钟,自选股池数十秒。
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HistoryIcon className="size-4" />
            历史推荐
          </CardTitle>
          <CardDescription>最近 10 次荐股结果,点击进入详情查看当时的候选股</CardDescription>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : historyItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无历史记录,生成一次即可看到。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>概述</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyItems.map((h) => {
                  const id = h.query_id || h.record_id;
                  return (
                    <TableRow key={String(id)}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {h.created_at || '—'}
                      </TableCell>
                      <TableCell className="text-sm">{h.signal || h.decision || h.trend || '—'}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/history/${id}`}>查看 →</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CandidateRow({ idx, c }: { idx: number; c: RecommendCandidate }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{idx}</TableCell>
      <TableCell>
        <a
          href={`/stock/${encodeURIComponent(c.code)}`}
          className="font-mono text-sm text-foreground hover:underline"
        >
          {c.code}
        </a>
      </TableCell>
      <TableCell className="font-medium">{c.name || '—'}</TableCell>
      <TableCell className="text-muted-foreground">{c.industry || '—'}</TableCell>
      <TableCell className="text-right font-bold tabular-nums">
        <Badge variant={c.score >= 60 ? 'success' : c.score >= 30 ? 'info' : 'outline'}>
          {c.score}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatPrice(c.last_price)}</TableCell>
      <TableCell className={cn('text-right tabular-nums', changeColor(c.change_pct))}>
        {formatPercent(c.change_pct)}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {c.signals.map((s, j) => (
            <Badge key={j} variant="secondary" className="text-[10px]">
              <Hash className="size-2.5 opacity-50" />
              {s}
            </Badge>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}
