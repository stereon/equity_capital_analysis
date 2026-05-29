import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Settings as SettingsIcon,
  Save,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Send,
  Cpu,
  Info,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type SystemConfigItem,
  type SystemConfigFieldSchema,
} from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const CATEGORY_LABEL: Record<string, string> = {
  base: '基础',
  ai_model: 'AI 模型',
  data_source: '数据源',
  search: '新闻搜索',
  notification: '通知渠道',
  schedule: '调度',
  api: 'API 服务',
  vision: 'Vision',
  agent: 'Agent',
  market: '市场',
  cache: '缓存',
  debug: '调试',
  system: '系统',
  backtest: '回测',
  uncategorized: '其他',
};

export default function Settings() {
  const qc = useQueryClient();

  const configQ = useQuery({
    queryKey: ['system-config'],
    queryFn: api.systemConfig,
  });

  const statusQ = useQuery({
    queryKey: ['system-config-setup-status'],
    queryFn: api.systemConfigSetupStatus,
  });

  // 本地草稿:用户修改的 key → 新值
  const [draft, setDraft] = useState<Record<string, string>>({});

  // 拉到新 config 时清空草稿
  useEffect(() => {
    if (configQ.data) setDraft({});
  }, [configQ.data?.config_version]);

  const config = configQ.data;
  const categories = useMemo(() => groupByCategory(config?.items || []), [config]);

  const dirty = Object.keys(draft).length;

  const saveMut = useMutation({
    mutationFn: () => {
      if (!config) throw new Error('config not loaded');
      const items = Object.entries(draft).map(([key, value]) => ({ key, value }));
      return api.systemConfigUpdate({
        config_version: config.config_version,
        items,
        mask_token: config.mask_token,
        reload_now: true,
      });
    },
    onSuccess: (r) => {
      const issuesCount = r.issues?.length || 0;
      if (issuesCount > 0) {
        toast.warning(`保存完成,${r.updated_keys.length} 项已更新,${issuesCount} 项有问题`);
      } else {
        toast.success(`保存成功,${r.updated_keys.length} 项已更新${r.reloaded ? '并已重载' : ''}`);
      }
      qc.invalidateQueries({ queryKey: ['system-config'] });
      qc.invalidateQueries({ queryKey: ['system-config-setup-status'] });
    },
    onError: (e: Error) => toast.error(`保存失败: ${e.message}`),
  });

  if (configQ.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (configQ.isError || !config) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        加载配置失败: {(configQ.error as Error)?.message || '未知错误'}
      </div>
    );
  }

  const tabCategories = Object.keys(categories);
  const defaultTab = tabCategories[0] || 'base';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <SettingsIcon className="size-5" />
            配置中心
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            LLM 渠道、数据源、新闻搜索、通知渠道、调度等全局配置。改完点「保存」会立即重载。
          </p>
        </div>
        <Button onClick={() => saveMut.mutate()} disabled={dirty === 0 || saveMut.isPending}>
          {saveMut.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          {dirty > 0 ? `保存(${dirty} 项)` : '保存'}
        </Button>
      </header>

      {/* 状态卡 */}
      {statusQ.data && <SetupStatusCard status={statusQ.data} />}

      <Tabs defaultValue={defaultTab}>
        <TabsList className="flex flex-wrap gap-1 h-auto">
          {tabCategories.map((cat) => {
            const items = categories[cat];
            const hasDirty = items.some((it) => draft[it.key] !== undefined);
            return (
              <TabsTrigger key={cat} value={cat} className="relative">
                {CATEGORY_LABEL[cat] || cat}
                {hasDirty && (
                  <span className="bg-primary absolute -top-1 -right-1 size-2 rounded-full" />
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {tabCategories.map((cat) => (
          <TabsContent key={cat} value={cat}>
            <Card>
              <CardContent className="space-y-4 pt-6">
                {categories[cat]
                  .sort((a, b) => (a.schema.display_order ?? 999) - (b.schema.display_order ?? 999))
                  .map((item) => (
                    <FieldRow
                      key={item.key}
                      item={item}
                      maskToken={config.mask_token}
                      draftValue={draft[item.key]}
                      onChange={(v) =>
                        setDraft((d) => {
                          const next = { ...d };
                          if (v === undefined) delete next[item.key];
                          else next[item.key] = v;
                          return next;
                        })
                      }
                    />
                  ))}
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function FieldRow({
  item,
  maskToken,
  draftValue,
  onChange,
}: {
  item: SystemConfigItem;
  maskToken: string;
  draftValue?: string;
  onChange: (v: string | undefined) => void;
}) {
  const { schema, value, is_masked } = item;
  const [showSensitive, setShowSensitive] = useState(false);
  const isDirty = draftValue !== undefined;
  const displayValue = isDirty ? draftValue : value;

  if (!schema.is_editable) {
    return (
      <div className="space-y-1 opacity-60">
        <Label>{schema.title}</Label>
        <div className="text-sm">{value || '—'}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'space-y-2 rounded-md border p-3',
        isDirty ? 'border-primary/50 bg-primary/5' : '',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label className="flex items-center gap-2 text-foreground">
          <span className="font-medium">{schema.title}</span>
          <code className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px] font-mono">
            {schema.key}
          </code>
          {schema.is_required && (
            <Badge variant="outline" className="text-[9px]">
              必填
            </Badge>
          )}
          {schema.is_sensitive && (
            <Badge variant="warning" className="text-[9px]">
              敏感
            </Badge>
          )}
          {isDirty && (
            <Badge variant="info" className="text-[9px]">
              未保存
            </Badge>
          )}
        </Label>
        <div className="flex items-center gap-2">
          {schema.is_sensitive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSensitive((s) => !s)}
              className="h-7 px-2"
            >
              {showSensitive ? <EyeOff /> : <Eye />}
            </Button>
          )}
          {/* 测试按钮(仅对 LLM channel / notification channel 的某些字段) */}
          {isTestable(schema) && <TestButton fieldKey={schema.key} />}
        </div>
      </div>
      {schema.description && (
        <p className="text-muted-foreground text-xs">{schema.description}</p>
      )}
      <FieldInput
        schema={schema}
        value={displayValue}
        masked={is_masked && !isDirty}
        maskToken={maskToken}
        showSensitive={showSensitive}
        onChange={(v) => onChange(v === value ? undefined : v)}
      />
      {schema.examples && schema.examples.length > 0 && (
        <details className="text-muted-foreground text-xs">
          <summary className="hover:text-foreground cursor-pointer">示例</summary>
          <pre className="bg-muted/40 mt-1 rounded p-2 text-[10px] leading-relaxed">
            {schema.examples.join('\n')}
          </pre>
        </details>
      )}
      {schema.docs && schema.docs.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {schema.docs.map((d, i) => (
            <a
              key={i}
              href={d.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary inline-flex items-center gap-1"
            >
              <ExternalLink className="size-3" />
              {d.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  schema,
  value,
  masked,
  maskToken,
  showSensitive,
  onChange,
}: {
  schema: SystemConfigFieldSchema;
  value: string;
  masked: boolean;
  maskToken: string;
  showSensitive: boolean;
  onChange: (v: string) => void;
}) {
  // 敏感字段当前是 masked 状态 → 显示 placeholder,不显示 maskToken,用户开始打字才覆盖
  const isMaskedSensitive = masked && !showSensitive;

  if (schema.ui_control === 'textarea' || schema.data_type === 'array') {
    return (
      <Textarea
        value={isMaskedSensitive ? '' : value}
        placeholder={isMaskedSensitive ? `${maskToken} (留空保持原值)` : schema.default_value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="font-mono text-xs"
      />
    );
  }

  if (schema.ui_control === 'select' && schema.options && schema.options.length > 0) {
    const opts = schema.options.map((o) =>
      typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value },
    );
    return (
      <div className="flex flex-wrap gap-1">
        {opts.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={value === o.value ? 'default' : 'outline'}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    );
  }

  if (schema.data_type === 'boolean') {
    return (
      <div className="flex gap-1">
        {(['true', 'false'] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={value === v ? 'default' : 'outline'}
            onClick={() => onChange(v)}
          >
            {v === 'true' ? '开启' : '关闭'}
          </Button>
        ))}
      </div>
    );
  }

  const isNumber = schema.data_type === 'number' || schema.data_type === 'integer';

  return (
    <Input
      type={schema.is_sensitive && !showSensitive ? 'password' : isNumber ? 'number' : 'text'}
      value={isMaskedSensitive ? '' : value}
      placeholder={isMaskedSensitive ? `${maskToken} (留空保持原值)` : schema.default_value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={cn(schema.is_sensitive ? 'font-mono' : '')}
    />
  );
}

function SetupStatusCard({ status }: { status: import('@/lib/api').SystemConfigSetupStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {status.is_complete ? (
            <CheckCircle2 className="text-[color:var(--success)] size-4" />
          ) : (
            <Info className="text-[color:var(--warning)] size-4" />
          )}
          初始化状态
          <Badge variant={status.is_complete ? 'success' : 'warning'}>
            {status.is_complete ? '已就绪' : '待配置'}
          </Badge>
        </CardTitle>
        <CardDescription>
          下一步: {status.next_step_key || '无'} · 缺失: {status.required_missing_keys.length} 项
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {status.checks.map((c) => (
            <div
              key={c.key}
              className="flex items-start gap-2 rounded-md border p-2 text-xs"
            >
              {c.status === 'configured' ? (
                <CheckCircle2 className="text-[color:var(--success)] mt-0.5 size-3.5 shrink-0" />
              ) : (
                <XCircle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              )}
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{c.title}</span>
                  {c.required && (
                    <Badge variant="outline" className="text-[9px]">
                      必填
                    </Badge>
                  )}
                </div>
                {c.message && (
                  <div className="text-muted-foreground mt-0.5 line-clamp-2">{c.message}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TestButton({ fieldKey }: { fieldKey: string }) {
  const isLLM = fieldKey.includes('LLM') || fieldKey.includes('LITELLM');
  const isNotify =
    fieldKey.includes('DINGTALK') ||
    fieldKey.includes('SLACK') ||
    fieldKey.includes('FEISHU') ||
    fieldKey.includes('TELEGRAM') ||
    fieldKey.includes('DISCORD') ||
    fieldKey.includes('BARK') ||
    fieldKey.includes('SMTP');

  const channel = inferChannelName(fieldKey);

  const mut = useMutation({
    mutationFn: async () => {
      if (isLLM) return api.systemConfigTestLLM(channel);
      if (isNotify) return api.systemConfigTestNotification(channel);
      throw new Error('unsupported test target');
    },
    onSuccess: (r) =>
      r.ok
        ? toast.success(`测试通过${r.message ? ': ' + r.message : ''}`)
        : toast.error(`测试失败${r.message ? ': ' + r.message : ''}`),
    onError: (e: Error) => toast.error(`测试失败: ${e.message}`),
  });

  if (!isLLM && !isNotify) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
      className="h-7 gap-1 px-2"
    >
      {mut.isPending ? (
        <Loader2 className="animate-spin" />
      ) : isLLM ? (
        <Cpu />
      ) : (
        <Send />
      )}
      测试
    </Button>
  );
}

// === helpers ===

function groupByCategory(items: SystemConfigItem[]): Record<string, SystemConfigItem[]> {
  const out: Record<string, SystemConfigItem[]> = {};
  for (const it of items) {
    const cat = it.schema.category || 'misc';
    if (!out[cat]) out[cat] = [];
    out[cat].push(it);
  }
  return out;
}

function isTestable(schema: SystemConfigFieldSchema): boolean {
  const k = schema.key;
  if (k === 'LITELLM_MODEL' || k === 'AGENT_LITELLM_MODEL') return true;
  if (/^LLM_[A-Z_]+_API_KEY$/i.test(k)) return true;
  if (/(DINGTALK|SLACK|FEISHU|TELEGRAM|DISCORD|BARK|SMTP).*WEBHOOK/i.test(k)) return true;
  return false;
}

function inferChannelName(fieldKey: string): string {
  if (fieldKey.includes('DINGTALK')) return 'dingtalk';
  if (fieldKey.includes('SLACK')) return 'slack';
  if (fieldKey.includes('FEISHU')) return 'feishu';
  if (fieldKey.includes('TELEGRAM')) return 'telegram';
  if (fieldKey.includes('DISCORD')) return 'discord';
  if (fieldKey.includes('BARK')) return 'bark';
  if (fieldKey.includes('SMTP')) return 'email';
  // LLM channel:从 LLM_<NAME>_* 提取 NAME
  const m = fieldKey.match(/^LLM_([A-Z]+)_/);
  if (m) return m[1].toLowerCase();
  return fieldKey.toLowerCase();
}
