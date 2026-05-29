import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Play, Loader2, CheckCircle2, AlertCircle, Clock, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type AgentSkill } from '@/lib/api';

const LAST_ANALYZE_TASK_KEY = ['analyze-last-task'] as const;
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface TaskState {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  message?: string;
  error?: string;
}

export default function Analyze() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  // 切走再回来要保留最近一次任务,运行中要继续轮询(setTask 已经统一写入 cache,
  // 由 PersistQueryClient 自动持久化到 localStorage)
  const persistedTask = queryClient.getQueryData<TaskState | null>(LAST_ANALYZE_TASK_KEY) || null;
  const [code, setCode] = useState(params.get('code') || '');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [task, setTaskState] = useState<TaskState | null>(persistedTask);
  const pollingRef = useRef<number | null>(null);

  const setTask = (t: TaskState | null | ((prev: TaskState | null) => TaskState | null)) => {
    setTaskState((prev) => {
      const next = typeof t === 'function' ? t(prev) : t;
      queryClient.setQueryData(LAST_ANALYZE_TASK_KEY, next);
      return next;
    });
  };

  const skillsQ = useQuery({
    queryKey: ['agent-skills'],
    queryFn: api.agentSkills,
    staleTime: 5 * 60_000,
  });
  const allSkills: AgentSkill[] = useMemo(() => skillsQ.data?.skills || [], [skillsQ.data]);

  const toggleSkill = (id: string) => {
    setSelectedSkills((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const mut = useMutation({
    mutationFn: (stock: string) =>
      api.analyze({
        stock_code: stock,
        async_mode: true,
        ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      }),
    onSuccess: (data) => {
      if (data.task_id) {
        setTask({
          taskId: data.task_id,
          status: (data.status as TaskState['status']) || 'pending',
          message: data.message,
        });
      } else {
        toast.success('分析完成');
      }
    },
    onError: (e: Error) => toast.error(`触发分析失败: ${e.message}`),
  });

  // 轮询任务状态
  useEffect(() => {
    if (!task || task.status === 'completed' || task.status === 'failed') {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    pollingRef.current = window.setInterval(async () => {
      try {
        const s = await api.taskStatus(task.taskId);
        setTask((prev) =>
          prev
            ? {
                ...prev,
                status: (s.status as TaskState['status']) || prev.status,
                progress: s.progress,
                message: s.message,
                error: s.error,
              }
            : prev,
        );
        if (s.status === 'completed') toast.success('分析完成,可去「历史」查看');
        if (s.status === 'failed') toast.error(`分析失败: ${s.error || '未知错误'}`);
      } catch (err) {
        // 静默,下一次再试
      }
    }, 3000);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [task?.taskId, task?.status]);

  const handleRun = () => {
    const trimmed = code.trim();
    if (!trimmed) {
      toast.error('请输入股票代码');
      return;
    }
    setTask(null);
    mut.mutate(trimmed);
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">个股 AI 分析</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          输入股票代码触发完整 AI 决策报告(技术面 + 新闻面 + 基本面 + 多策略融合)。
          本地 Claude 模型,单只大约 1-2 分钟。
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">触发分析</CardTitle>
          <CardDescription>
            支持 A 股 6 位代码(如 <code>600519</code>)、港股(<code>hk00700</code>)、美股(<code>AAPL</code>)
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">股票代码</label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="例如:600519 / AAPL / hk00700"
              className="font-mono"
              onKeyDown={(e) => e.key === 'Enter' && handleRun()}
            />
          </div>
          <Button onClick={handleRun} disabled={mut.isPending || (task?.status === 'pending' || task?.status === 'processing')}>
            {mut.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            {mut.isPending ? '提交中' : '开始分析'}
          </Button>
        </CardContent>
      </Card>

      {/* 策略 skill 选择(可选) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            策略 skill(可选)
            {selectedSkills.length > 0 && (
              <Badge variant="info" className="ml-1">
                已选 {selectedSkills.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            不选则按服务端默认策略;选中则按指定策略评估。多选可叠加多视角。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {skillsQ.isLoading ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-24" />
              ))}
            </div>
          ) : allSkills.length === 0 ? (
            <p className="text-muted-foreground text-sm">未获取到 skill 列表</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {allSkills.map((s) => {
                  const active = selectedSkills.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleSkill(s.id)}
                      title={s.description}
                      className={cn(
                        'group relative inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background text-muted-foreground hover:text-foreground hover:bg-accent/50',
                      )}
                    >
                      {s.name}
                      {active && <X className="size-3 opacity-70" />}
                    </button>
                  );
                })}
              </div>
              {selectedSkills.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedSkills([])}
                    className="text-muted-foreground"
                  >
                    清空选择
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {task && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TaskIcon status={task.status} />
              任务状态
              <TaskBadge status={task.status} />
            </CardTitle>
            <CardDescription className="font-mono text-xs">{task.taskId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {task.progress !== undefined && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>进度</span>
                  <span>{Math.round((task.progress || 0) * 100)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="bg-primary h-full transition-all"
                    style={{ width: `${(task.progress || 0) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {task.message && (
              <p className="text-sm text-muted-foreground">{task.message}</p>
            )}
            {task.error && (
              <div className="text-sm text-destructive">{task.error}</div>
            )}
            {task.status === 'completed' && (
              <>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">分析已完成,详情见历史报告页</span>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/history">查看历史 →</a>
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TaskIcon({ status }: { status: TaskState['status'] }) {
  if (status === 'completed') return <CheckCircle2 className="text-[color:var(--success)] size-4" />;
  if (status === 'failed') return <AlertCircle className="text-destructive size-4" />;
  if (status === 'processing') return <Loader2 className="animate-spin size-4" />;
  return <Clock className="text-muted-foreground size-4" />;
}

function TaskBadge({ status }: { status: TaskState['status'] }) {
  const variant: 'success' | 'destructive' | 'info' | 'secondary' =
    status === 'completed' ? 'success' : status === 'failed' ? 'destructive' : status === 'processing' ? 'info' : 'secondary';
  const label = status === 'completed' ? '完成' : status === 'failed' ? '失败' : status === 'processing' ? '进行中' : '排队中';
  return <Badge variant={variant}>{label}</Badge>;
}
