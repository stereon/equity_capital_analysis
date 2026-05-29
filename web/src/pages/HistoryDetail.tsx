import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export default function HistoryDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['history-detail', id],
    queryFn: () => api.historyDetail(id!),
    enabled: !!id,
    staleTime: Infinity, // 历史报告写完不会再变
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
            <Link to="/history">
              <ArrowLeft />
              返回列表
            </Link>
          </Button>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <FileText className="size-5" />
            {q.data
              ? q.data.report_type === 'market_review'
                ? '大盘复盘'
                : q.data.report_type === 'morning_briefing'
                  ? '早盘播报'
                  : q.data.report_type === 'closing_summary'
                    ? '收盘总结'
                    : q.data.report_type === 'recommendation'
                      ? '候选股推荐'
                      : `${q.data.name || q.data.stock_name || '—'} (${q.data.code || q.data.stock_code || '—'})`
              : '加载中…'}
          </h1>
          {q.data && (
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span>{q.data.created_at || '—'}</span>
              {q.data.decision && (
                <>
                  <span>·</span>
                  <Badge variant="secondary">{q.data.decision}</Badge>
                </>
              )}
              {q.data.score != null && (
                <>
                  <span>·</span>
                  <span>评分 <span className="text-foreground font-semibold">{q.data.score}</span></span>
                </>
              )}
              {q.data.trend && (
                <>
                  <span>·</span>
                  <span>趋势 {q.data.trend}</span>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <Card>
        <CardContent className="py-6">
          {q.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : q.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              加载报告失败: {(q.error as Error)?.message}
            </div>
          ) : !q.data?.report_markdown ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="text-muted-foreground mx-auto mb-2 size-6" />
              该报告无 Markdown 内容(可能是早期记录或仅元数据)
            </div>
          ) : (
            <article className="prose prose-invert prose-zinc max-w-none prose-headings:scroll-mt-24 prose-pre:bg-secondary/40 prose-pre:border prose-pre:border-border prose-code:before:hidden prose-code:after:hidden prose-table:my-0 prose-th:text-left prose-th:bg-muted/40 prose-td:align-top prose-img:rounded-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw, rehypeHighlight]}
              >
                {q.data.report_markdown}
              </ReactMarkdown>
            </article>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
