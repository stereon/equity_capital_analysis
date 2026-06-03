import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { api, type FeishuStreamStatus as FeishuStreamStatusData } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type BadgeVariant = 'success' | 'warning' | 'info' | 'outline';

const STATUS_BADGE: Record<FeishuStreamStatusData['status'], { label: string; variant: BadgeVariant }> = {
  running: { label: '运行中', variant: 'success' },
  enabled_not_running: { label: '已启用 · 待重启', variant: 'warning' },
  missing_credentials: { label: '缺少凭证', variant: 'warning' },
  sdk_missing: { label: 'SDK 未安装', variant: 'warning' },
  disabled: { label: '未启用', variant: 'outline' },
};

/**
 * 飞书 Stream 机器人连接状态 + 凭证测试（设置页 FEISHU_STREAM_ENABLED 字段下方）。
 *
 * 注意：running 仅在与机器人同进程时准确（如 python main.py --serve）；
 * 若 Web 与机器人分进程运行，该值可能始终为 false。
 */
export function FeishuStreamStatus() {
  const statusQuery = useQuery({
    queryKey: ['feishu-stream-status'],
    queryFn: () => api.feishuStreamStatus(),
    staleTime: 10_000,
  });

  const testMut = useMutation({
    mutationFn: () => api.feishuTestStream(),
    onSuccess: (r) =>
      r.ok ? toast.success(r.message) : toast.error(r.message),
    onError: (e: Error) => toast.error(`测试失败: ${e.message}`),
  });

  const data = statusQuery.data;
  const badge = data ? STATUS_BADGE[data.status] : null;

  return (
    <div className="bg-muted/30 mt-1 space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground text-xs font-medium">机器人连接状态</span>
        {statusQuery.isLoading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : badge ? (
          <Badge variant={badge.variant} className="text-[10px]">
            {badge.label}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            状态未知
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => statusQuery.refetch()}
          disabled={statusQuery.isFetching}
          className="h-7 gap-1 px-2"
        >
          <RefreshCw className={statusQuery.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
          刷新
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => testMut.mutate()}
          disabled={testMut.isPending}
          className="h-7 gap-1 px-2"
        >
          {testMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          测试凭证
        </Button>
      </div>
      {data && <p className="text-muted-foreground text-[11px]">{data.message}</p>}
      {statusQuery.isError && (
        <p className="text-[color:var(--warning)] text-[11px]">无法获取状态（服务未运行或接口异常）。</p>
      )}
    </div>
  );
}
