import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Plus,
  Play,
  Loader2,
  Trash2,
  History as HistoryIcon,
  Send,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type AlertRule,
  type AlertRuleCreateBody,
  type AlertTargetScope,
  type AlertSeverity,
  type AlertTrigger,
  type AlertNotification,
} from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const TARGET_SCOPE_OPTIONS: { value: AlertTargetScope; label: string; targetHint: string }[] = [
  { value: 'single_symbol', label: '单股', targetHint: '股票代码,如 600519' },
  { value: 'watchlist', label: '自选股', targetHint: '填 all(覆盖整个 STOCK_LIST)' },
  { value: 'portfolio_holdings', label: '持仓个股', targetHint: '填 all 或具体账户 id(整数)' },
  { value: 'portfolio_account', label: '账户聚合', targetHint: '填 all 或具体账户 id(整数)' },
  { value: 'market', label: '大盘', targetHint: 'cn / hk / us' },
];

// 后端支持的真实 alert_type 列表(见 src/services/alert_service.py SUPPORTED_ALERT_TYPES)
const ALERT_TYPE_PRESETS: { value: string; label: string; parameters: Record<string, unknown> }[] = [
  // legacy symbol alerts
  { value: 'price_cross', label: '价格穿越', parameters: { direction: 'above', threshold: 100 } },
  { value: 'price_change_percent', label: '涨跌幅阈值', parameters: { direction: 'above', threshold: 5 } },
  { value: 'volume_spike', label: '放量异动', parameters: { ratio: 2.0 } },
  // technical indicator alerts
  { value: 'ma_price_cross', label: '价格穿 MA', parameters: { direction: 'above', window: 20 } },
  { value: 'rsi_threshold', label: 'RSI 阈值', parameters: { direction: 'above', period: 14, threshold: 70 } },
  { value: 'macd_cross', label: 'MACD 金/死叉', parameters: { direction: 'bullish_cross' } },
  { value: 'kdj_cross', label: 'KDJ 金/死叉', parameters: { direction: 'bullish_cross' } },
  { value: 'cci_threshold', label: 'CCI 阈值', parameters: { direction: 'above', period: 14, threshold: 100 } },
  // portfolio alerts
  { value: 'portfolio_concentration', label: '持仓集中度', parameters: { threshold_pct: 35 } },
  { value: 'portfolio_drawdown', label: '组合回撤', parameters: { threshold_pct: 15 } },
  { value: 'portfolio_stop_loss', label: '止损线', parameters: { threshold_pct: 10 } },
  { value: 'portfolio_price_stale', label: '价格陈旧', parameters: {} },
  // market alerts
  { value: 'market_light_status', label: '大盘红绿灯', parameters: { status: 'red' } },
  { value: 'market_light_score_drop', label: '大盘评分下滑', parameters: { drop: 20 } },
];

export default function Alerts() {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Bell className="size-5" />
            实时告警
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            技术指标 / 持仓 / 大盘红绿灯告警规则管理 + 触发历史 + 通知尝试。
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          {showForm ? <ChevronUp /> : <Plus />}
          {showForm ? '收起新增' : '新增规则'}
        </Button>
      </header>

      {showForm && <CreateRuleForm onClose={() => setShowForm(false)} />}

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">
            <Bell className="size-3.5" />
            规则
          </TabsTrigger>
          <TabsTrigger value="triggers">
            <HistoryIcon className="size-3.5" />
            触发历史
          </TabsTrigger>
          <TabsTrigger value="notifications">
            <Send className="size-3.5" />
            通知尝试
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rules">
          <RulesPanel />
        </TabsContent>
        <TabsContent value="triggers">
          <TriggersPanel />
        </TabsContent>
        <TabsContent value="notifications">
          <NotificationsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CreateRuleForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [targetScope, setTargetScope] = useState<AlertTargetScope>('single_symbol');
  const [target, setTarget] = useState('600519');
  const [alertType, setAlertType] = useState('price_cross');
  const [severity, setSeverity] = useState<AlertSeverity>('warning');
  const [parametersJSON, setParametersJSON] = useState(
    JSON.stringify({ direction: 'above', threshold: 100 }, null, 2),
  );

  const scopeHint =
    TARGET_SCOPE_OPTIONS.find((o) => o.value === targetScope)?.targetHint || '';

  const handleTypePreset = (v: string) => {
    setAlertType(v);
    const preset = ALERT_TYPE_PRESETS.find((p) => p.value === v);
    if (preset) setParametersJSON(JSON.stringify(preset.parameters, null, 2));
  };

  const mut = useMutation({
    mutationFn: (body: AlertRuleCreateBody) => api.alertRuleCreate(body),
    onSuccess: () => {
      toast.success('规则创建成功');
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
      onClose();
    },
    onError: (e: Error) => toast.error(`创建失败: ${e.message}`),
  });

  const handleSubmit = () => {
    let parameters: Record<string, unknown> = {};
    try {
      parameters = parametersJSON.trim() ? JSON.parse(parametersJSON) : {};
    } catch (e) {
      toast.error(`参数 JSON 解析失败: ${(e as Error).message}`);
      return;
    }
    if (!target.trim()) {
      toast.error('请填写 target');
      return;
    }
    mut.mutate({
      name: name.trim() || undefined,
      target_scope: targetScope,
      target: target.trim(),
      alert_type: alertType,
      parameters,
      severity,
      enabled: true,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新增告警规则</CardTitle>
        <CardDescription>填写后会立即生效进入定时评估循环</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>规则名称(可选)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例:茅台跌破 1300" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>严重度</Label>
            <div className="flex gap-1">
              {(['info', 'warning', 'critical'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={severity === s ? 'default' : 'outline'}
                  onClick={() => setSeverity(s)}
                >
                  {s === 'info' ? '提示' : s === 'warning' ? '警告' : '严重'}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>作用范围</Label>
            <div className="flex flex-wrap gap-1">
              {TARGET_SCOPE_OPTIONS.map((o) => (
                <Button
                  key={o.value}
                  size="sm"
                  variant={targetScope === o.value ? 'default' : 'outline'}
                  onClick={() => setTargetScope(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>目标</Label>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={scopeHint}
              className="font-mono"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>告警类型</Label>
          <div className="flex flex-wrap gap-1">
            {ALERT_TYPE_PRESETS.map((p) => (
              <Button
                key={p.value}
                size="sm"
                variant={alertType === p.value ? 'default' : 'outline'}
                onClick={() => handleTypePreset(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>参数(JSON)</Label>
          <Textarea
            value={parametersJSON}
            onChange={(e) => setParametersJSON(e.target.value)}
            rows={5}
            className="font-mono text-xs"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="animate-spin" />}
            创建规则
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RulesPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.alertRules({ page_size: 50 }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      enabled ? api.alertRuleDisable(id) : api.alertRuleEnable(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
    onError: (e: Error) => toast.error(`操作失败: ${e.message}`),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.alertRuleDelete(id),
    onSuccess: () => {
      toast.success('规则已删除');
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
    },
    onError: (e: Error) => toast.error(`删除失败: ${e.message}`),
  });

  const test = useMutation({
    mutationFn: (id: number) => api.alertRuleTest(id),
    onSuccess: (data) =>
      toast.success(
        `Dry-run: ${data.message} (评估 ${data.evaluated_count}/触发 ${data.triggered_count}/降级 ${data.degraded_count})`,
        { duration: 6000 },
      ),
    onError: (e: Error) => toast.error(`测试失败: ${e.message}`),
  });

  const items = q.data?.items || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">规则列表</CardTitle>
        <CardDescription>
          {q.data ? `共 ${q.data.total} 条` : '加载中…'} · 启用的规则会在后端 worker 周期评估
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : q.isError ? (
          <ErrorBox msg={(q.error as Error)?.message} />
        ) : items.length === 0 ? (
          <EmptyBox icon={Bell} text="暂无规则,点上方「新增规则」开始" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>范围</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>严重度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近触发</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <RuleRow
                  key={r.id}
                  r={r}
                  onToggle={() => toggle.mutate({ id: r.id, enabled: r.enabled })}
                  onDelete={() => {
                    if (confirm(`确认删除规则「${r.name || '未命名'}」?`)) del.mutate(r.id);
                  }}
                  onTest={() => test.mutate(r.id)}
                  testing={test.isPending && test.variables === r.id}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RuleRow({
  r,
  onToggle,
  onDelete,
  onTest,
  testing,
}: {
  r: AlertRule;
  onToggle: () => void;
  onDelete: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{r.name || `规则 ${r.id}`}</TableCell>
      <TableCell>
        <Badge variant="secondary" className="text-[10px]">
          {r.target_scope}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs">{r.target}</TableCell>
      <TableCell className="text-muted-foreground text-xs">{r.alert_type}</TableCell>
      <TableCell>
        <SeverityBadge severity={r.severity} />
      </TableCell>
      <TableCell>
        <button
          onClick={onToggle}
          className={cn(
            'inline-flex h-5 w-9 items-center rounded-full transition-colors',
            r.enabled ? 'bg-[color:var(--success)]/70' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'block size-4 rounded-full bg-background shadow transition-transform',
              r.enabled ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {r.last_triggered_at || '—'}
        {r.cooldown_active && (
          <Badge variant="warning" className="ml-1 text-[9px]">
            冷却
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-1">
          <Button variant="ghost" size="sm" onClick={onTest} disabled={testing}>
            {testing ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function TriggersPanel() {
  const q = useQuery({
    queryKey: ['alert-triggers'],
    queryFn: () => api.alertTriggers({ page_size: 30 }),
  });
  const items = q.data?.items || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">触发历史</CardTitle>
        <CardDescription>
          {q.data ? `共 ${q.data.total} 条` : '加载中…'} · 显示最近 30 条
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyBox icon={HistoryIcon} text="尚无触发记录" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>规则</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">观测值</TableHead>
                <TableHead className="text-right">阈值</TableHead>
                <TableHead>原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((t) => (
                <TriggerRow key={t.id} t={t} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TriggerRow({ t }: { t: AlertTrigger }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-xs">{t.triggered_at || '—'}</TableCell>
      <TableCell className="text-xs">#{t.rule_id ?? '—'}</TableCell>
      <TableCell className="font-mono text-xs">{t.target}</TableCell>
      <TableCell>
        <TriggerStatusBadge status={t.status} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{t.observed_value ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{t.threshold ?? '—'}</TableCell>
      <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
        {t.reason || '—'}
      </TableCell>
    </TableRow>
  );
}

function NotificationsPanel() {
  const q = useQuery({
    queryKey: ['alert-notifications'],
    queryFn: () => api.alertNotifications({ page_size: 30 }),
  });
  const items = q.data?.items || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">通知尝试</CardTitle>
        <CardDescription>
          {q.data ? `共 ${q.data.total} 条` : '加载中…'} · 显示最近 30 条
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyBox icon={Send} text="尚无通知发送记录" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>渠道</TableHead>
                <TableHead>触发 ID</TableHead>
                <TableHead className="text-right">尝试</TableHead>
                <TableHead>结果</TableHead>
                <TableHead className="text-right">耗时</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function NotificationRow({ n }: { n: AlertNotification }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-xs">{n.created_at || '—'}</TableCell>
      <TableCell>
        <Badge variant="secondary" className="text-[10px]">
          {n.channel}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">#{n.trigger_id ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{n.attempt}</TableCell>
      <TableCell>
        <Badge variant={n.success ? 'success' : 'destructive'}>
          {n.success ? '成功' : '失败'}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
        {n.latency_ms != null ? `${n.latency_ms}ms` : '—'}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
        {n.error_code || '—'}
      </TableCell>
    </TableRow>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const v: 'info' | 'warning' | 'destructive' | 'secondary' =
    severity === 'critical'
      ? 'destructive'
      : severity === 'warning'
        ? 'warning'
        : severity === 'info'
          ? 'info'
          : 'secondary';
  const label = severity === 'critical' ? '严重' : severity === 'warning' ? '警告' : '提示';
  return <Badge variant={v}>{label}</Badge>;
}

function TriggerStatusBadge({ status }: { status: string }) {
  const v: 'success' | 'destructive' | 'warning' | 'secondary' =
    status === 'triggered'
      ? 'destructive'
      : status === 'skipped'
        ? 'secondary'
        : status === 'degraded'
          ? 'warning'
          : status === 'failed'
            ? 'destructive'
            : 'secondary';
  return <Badge variant={v}>{status}</Badge>;
}

function EmptyBox({ icon: Icon, text }: { icon: typeof Bell; text: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-sm">
      <Icon className="size-6 opacity-60" />
      {text}
    </div>
  );
}

function ErrorBox({ msg }: { msg?: string }) {
  return (
    <div className="border-destructive/50 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <AlertTriangle className="size-4" />
      加载失败: {msg || '未知错误'}
    </div>
  );
}
