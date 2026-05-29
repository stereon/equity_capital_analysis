import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileText, Loader2 } from 'lucide-react';
import { api, type HistoryRecord } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

const PAGE_SIZE = 20;

export default function History() {
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['history', page],
    queryFn: () => api.history({ page, limit: PAGE_SIZE }),
  });

  const items = q.data?.items || [];
  const total = q.data?.total ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">历史报告</h1>
        <p className="text-muted-foreground mt-1 text-sm">所有已生成的个股分析与大盘复盘报告。</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4" />
            报告列表
          </CardTitle>
          <CardDescription>共 {total} 条记录,第 {page} / {totalPages} 页</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : q.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              加载历史失败: {(q.error as Error)?.message}
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">暂无历史记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>类型</TableHead>
                  <TableHead>代码</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>决策</TableHead>
                  <TableHead className="text-right">评分</TableHead>
                  <TableHead>趋势</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r, i) => (
                  <HistoryRow
                    key={r.record_id ?? r.query_id ?? i}
                    r={r}
                    onOpen={() => {
                      const idVal = r.record_id ?? r.query_id;
                      if (idVal != null) navigate(`/history/${idVal}`);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || q.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft />
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
            {q.isFetching && <Loader2 className="ml-2 inline animate-spin size-3" />}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ r, onOpen }: { r: HistoryRecord; onOpen: () => void }) {
  const code = r.code || r.stock_code || '—';
  const name = r.name || r.stock_name || '—';
  const decision = r.decision || r.signal || '—';
  const isMarketReview = r.report_type === 'market_review';
  const isMorning = r.report_type === 'morning_briefing';
  const isClosing = r.report_type === 'closing_summary';
  const isRecommendation = r.report_type === 'recommendation';
  const isBriefing = isMorning || isClosing;
  const isNonStock = isMarketReview || isBriefing || isRecommendation;
  const typeLabel = isMarketReview
    ? '大盘复盘'
    : isMorning
      ? '早盘播报'
      : isClosing
        ? '收盘总结'
        : isRecommendation
          ? '候选股推荐'
          : '个股';
  const typeVariant = isMarketReview
    ? 'info'
    : isRecommendation
      ? 'warning'
      : isBriefing
        ? 'outline'
        : 'secondary';
  return (
    <TableRow onClick={onOpen} className="cursor-pointer">
      <TableCell>
        <Badge variant={typeVariant as 'info' | 'outline' | 'secondary' | 'warning'}>{typeLabel}</Badge>
      </TableCell>
      <TableCell className="font-mono text-sm">{isNonStock ? '—' : code}</TableCell>
      <TableCell className="font-medium">{isNonStock ? typeLabel : name}</TableCell>
      <TableCell>
        <DecisionBadge decision={decision} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.score != null ? <span className="font-bold">{r.score}</span> : '—'}
      </TableCell>
      <TableCell className="text-muted-foreground">{r.trend || '—'}</TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {r.created_at || r.report_date || '—'}
      </TableCell>
    </TableRow>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const lower = (decision || '').toLowerCase();
  const variant: 'success' | 'destructive' | 'warning' | 'secondary' = lower.includes('买')
    ? 'success'
    : lower.includes('卖') || lower.includes('减')
      ? 'destructive'
      : lower.includes('持') || lower.includes('观望') || lower.includes('洗盘')
        ? 'warning'
        : 'secondary';
  return <Badge variant={variant}>{decision}</Badge>;
}
