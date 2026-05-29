import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  Wallet,
  LineChart as ChartIcon,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Clock,
  Plus,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type PortfolioAccount,
  type PortfolioAccountCreateBody,
  type PortfolioPosition,
  type PortfolioTrade,
  type PortfolioTradeCreateBody,
} from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn, formatPercent, formatPrice, changeColor } from '@/lib/utils';

const ALL = -1; // 表示「全部账户」
type FormKind = 'account' | 'trade' | 'csv' | null;

export default function Portfolio() {
  const [accountId, setAccountId] = useState<number>(ALL);
  const [openForm, setOpenForm] = useState<FormKind>(null);
  const qc = useQueryClient();

  const accountsQ = useQuery({
    queryKey: ['portfolio-accounts'],
    queryFn: api.portfolioAccounts,
  });

  const tradeDelete = useMutation({
    mutationFn: (id: number) => api.portfolioTradeDelete(id),
    onSuccess: () => {
      toast.success('交易已删除');
      qc.invalidateQueries({ queryKey: ['portfolio-snapshot'] });
      qc.invalidateQueries({ queryKey: ['portfolio-trades'] });
      qc.invalidateQueries({ queryKey: ['portfolio-risk'] });
    },
    onError: (e: Error) => toast.error(`删除失败: ${e.message}`),
  });

  const snapshotQ = useQuery({
    queryKey: ['portfolio-snapshot', accountId],
    queryFn: () =>
      api.portfolioSnapshot(accountId === ALL ? {} : { account_id: accountId }),
    refetchInterval: 60_000, // 浮盈浮亏每分钟刷一次
  });

  const riskQ = useQuery({
    queryKey: ['portfolio-risk', accountId],
    queryFn: () => api.portfolioRisk(accountId === ALL ? {} : { account_id: accountId }),
    enabled: snapshotQ.isSuccess,
    refetchInterval: 60_000,
  });

  const tradesQ = useQuery({
    queryKey: ['portfolio-trades', accountId],
    queryFn: () =>
      api.portfolioTrades({
        ...(accountId === ALL ? {} : { account_id: accountId }),
        page_size: 10,
      }),
  });

  const accounts = accountsQ.data?.accounts || [];
  const snapshot = snapshotQ.data;
  const risk = riskQ.data;
  const positions = useMemo<PortfolioPosition[]>(() => {
    if (!snapshot) return [];
    return snapshot.accounts.flatMap((a) => a.positions);
  }, [snapshot]);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Briefcase className="size-5" />
            持仓分析
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            账户、持仓、风险与近期交易。数据来自 `/api/v1/portfolio/*`。
          </p>
        </div>
        <AccountSelector
          accounts={accounts}
          loading={accountsQ.isLoading}
          value={accountId}
          onChange={setAccountId}
        />
      </header>

      {/* 操作工具栏 */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={openForm === 'account' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOpenForm(openForm === 'account' ? null : 'account')}
        >
          <Plus />
          新增账户
        </Button>
        <Button
          variant={openForm === 'trade' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOpenForm(openForm === 'trade' ? null : 'trade')}
          disabled={accounts.length === 0}
        >
          <Plus />
          录入交易
        </Button>
        <Button
          variant={openForm === 'csv' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOpenForm(openForm === 'csv' ? null : 'csv')}
          disabled={accounts.length === 0}
        >
          <Upload />
          CSV 导入
        </Button>
      </div>

      {openForm === 'account' && <AccountForm onClose={() => setOpenForm(null)} />}
      {openForm === 'trade' && (
        <TradeForm
          accounts={accounts}
          defaultAccountId={accountId !== ALL ? accountId : undefined}
          onClose={() => setOpenForm(null)}
        />
      )}
      {openForm === 'csv' && (
        <CsvImportForm
          accounts={accounts}
          defaultAccountId={accountId !== ALL ? accountId : undefined}
          onClose={() => setOpenForm(null)}
        />
      )}

      {/* 总览 */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {snapshotQ.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-20" />
                <Skeleton className="mt-2 h-8 w-32" />
              </CardHeader>
            </Card>
          ))
        ) : !snapshot ? null : (
          <>
            <OverviewCard
              label="总权益"
              value={snapshot.total_equity}
              currency={snapshot.currency}
              icon={Wallet}
              accent="primary"
            />
            <OverviewCard
              label="持仓市值"
              value={snapshot.total_market_value}
              currency={snapshot.currency}
              icon={ChartIcon}
            />
            <OverviewCard
              label="现金"
              value={snapshot.total_cash}
              currency={snapshot.currency}
            />
            <OverviewCard
              label="未实现盈亏"
              value={snapshot.unrealized_pnl}
              currency={snapshot.currency}
              accent={snapshot.unrealized_pnl >= 0 ? 'destructive' : 'success'}
              icon={snapshot.unrealized_pnl >= 0 ? TrendingUp : TrendingDown}
            />
          </>
        )}
      </section>

      {/* 二级汇总 */}
      {snapshot && (
        <Card>
          <CardContent className="grid grid-cols-2 gap-4 py-2 text-sm sm:grid-cols-5">
            <Mini label="账户数" value={snapshot.account_count} />
            <Mini label="持仓数" value={positions.length} />
            <Mini
              label="已实现盈亏"
              value={`${snapshot.realized_pnl >= 0 ? '+' : ''}${snapshot.realized_pnl.toFixed(2)}`}
              accent={snapshot.realized_pnl >= 0 ? 'destructive' : 'success'}
            />
            <Mini label="累计手续费" value={`${snapshot.fee_total.toFixed(2)}`} />
            <Mini label="累计税费" value={`${snapshot.tax_total.toFixed(2)}`} />
          </CardContent>
        </Card>
      )}

      {/* 持仓表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">持仓明细</CardTitle>
          <CardDescription>
            {snapshot ? `${positions.length} 个持仓 · 估值时点 ${snapshot.as_of}` : '加载中…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {snapshotQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : snapshotQ.isError ? (
            <ErrorBox msg={(snapshotQ.error as Error)?.message} />
          ) : positions.length === 0 ? (
            <EmptyBox icon={Briefcase} text="该账户无持仓" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>代码</TableHead>
                  <TableHead>市场</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">成本</TableHead>
                  <TableHead className="text-right">现价</TableHead>
                  <TableHead className="text-right">市值</TableHead>
                  <TableHead className="text-right">浮动盈亏</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead>币种</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p, i) => (
                  <PositionRow key={`${p.symbol}-${i}`} p={p} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 风险摘要 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4" />
            风险摘要
          </CardTitle>
          <CardDescription>个股/行业集中度、回撤与止损监测</CardDescription>
        </CardHeader>
        <CardContent>
          {riskQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6" />
              ))}
            </div>
          ) : riskQ.isError ? (
            <ErrorBox msg={(riskQ.error as Error)?.message} />
          ) : !risk ? (
            <EmptyBox icon={AlertTriangle} text="暂无风险数据" />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <RiskSection title="个股集中度" data={risk.concentration} />
              <RiskSection title="行业集中度" data={risk.sector_concentration} />
              <RiskSection title="回撤" data={risk.drawdown} />
              <RiskSection title="止损监测" data={risk.stop_loss} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* 近期交易 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            近期交易
          </CardTitle>
          <CardDescription>最近 10 笔买卖记录</CardDescription>
        </CardHeader>
        <CardContent>
          {tradesQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : (tradesQ.data?.items || []).length === 0 ? (
            <EmptyBox icon={Clock} text="无交易记录" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>代码</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">费用</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tradesQ.data?.items || []).map((t) => (
                  <TradeRow
                    key={t.id}
                    t={t}
                    onDelete={() => {
                      if (confirm(`删除 ${t.trade_date} ${t.side === 'buy' ? '买入' : '卖出'} ${t.symbol}?`)) {
                        tradeDelete.mutate(t.id);
                      }
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// === 表单组件 ===

function AccountForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [broker, setBroker] = useState('');
  const [market, setMarket] = useState<'cn' | 'hk' | 'us'>('cn');
  const [baseCurrency, setBaseCurrency] = useState('CNY');

  const mut = useMutation({
    mutationFn: (body: PortfolioAccountCreateBody) => api.portfolioAccountCreate(body),
    onSuccess: (a) => {
      toast.success(`账户「${a.name}」创建成功`);
      qc.invalidateQueries({ queryKey: ['portfolio-accounts'] });
      qc.invalidateQueries({ queryKey: ['portfolio-snapshot'] });
      onClose();
    },
    onError: (e: Error) => toast.error(`创建失败: ${e.message}`),
  });

  const submit = () => {
    if (!name.trim()) {
      toast.error('请填账户名称');
      return;
    }
    mut.mutate({
      name: name.trim(),
      broker: broker.trim() || undefined,
      market,
      base_currency: baseCurrency.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新增账户</CardTitle>
        <CardDescription>用于把交易、持仓、风险按账户聚合</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>账户名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例:我的 A 股" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>券商(可选)</Label>
            <Input value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="例:华泰" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>市场</Label>
            <div className="flex gap-1">
              {(['cn', 'hk', 'us'] as const).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={market === m ? 'default' : 'outline'}
                  onClick={() => {
                    setMarket(m);
                    setBaseCurrency(m === 'cn' ? 'CNY' : m === 'hk' ? 'HKD' : 'USD');
                  }}
                >
                  {m === 'cn' ? 'A 股' : m === 'hk' ? '港股' : '美股'}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>基础货币</Label>
            <Input
              value={baseCurrency}
              onChange={(e) => setBaseCurrency(e.target.value.toUpperCase())}
              className="font-mono"
              maxLength={8}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="animate-spin" />}
            创建账户
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TradeForm({
  accounts,
  defaultAccountId,
  onClose,
}: {
  accounts: PortfolioAccount[];
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number>(defaultAccountId ?? accounts[0]?.id ?? 0);
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [tradeDate, setTradeDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState('100');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('0');
  const [tax, setTax] = useState('0');
  const [note, setNote] = useState('');

  const mut = useMutation({
    mutationFn: (body: PortfolioTradeCreateBody) => api.portfolioTradeCreate(body),
    onSuccess: () => {
      toast.success('交易已录入');
      qc.invalidateQueries({ queryKey: ['portfolio-snapshot'] });
      qc.invalidateQueries({ queryKey: ['portfolio-trades'] });
      qc.invalidateQueries({ queryKey: ['portfolio-risk'] });
      onClose();
    },
    onError: (e: Error) => toast.error(`录入失败: ${e.message}`),
  });

  const submit = () => {
    const q = Number(quantity);
    const p = Number(price);
    if (!accountId) return toast.error('请选账户');
    if (!symbol.trim()) return toast.error('请填股票代码');
    if (!Number.isFinite(q) || q <= 0) return toast.error('数量必须 > 0');
    if (!Number.isFinite(p) || p <= 0) return toast.error('价格必须 > 0');
    mut.mutate({
      account_id: accountId,
      symbol: symbol.trim().toUpperCase(),
      trade_date: tradeDate,
      side,
      quantity: q,
      price: p,
      fee: Number(fee) || 0,
      tax: Number(tax) || 0,
      note: note.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">录入交易</CardTitle>
        <CardDescription>买入或卖出一笔交易,会自动更新持仓与盈亏</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label>账户</Label>
          <div className="flex flex-wrap gap-1">
            {accounts.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={accountId === a.id ? 'default' : 'outline'}
                onClick={() => setAccountId(a.id)}
              >
                {a.name}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label>代码</Label>
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="600519"
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>方向</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={side === 'buy' ? 'default' : 'outline'}
                onClick={() => setSide('buy')}
              >
                买入
              </Button>
              <Button
                size="sm"
                variant={side === 'sell' ? 'default' : 'outline'}
                onClick={() => setSide('sell')}
              >
                卖出
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>日期</Label>
            <Input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>数量</Label>
            <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} className="tabular-nums" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>价格</Label>
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="1280.50"
              className="tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>手续费</Label>
            <Input value={fee} onChange={(e) => setFee(e.target.value)} className="tabular-nums" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>印花税</Label>
            <Input value={tax} onChange={(e) => setTax(e.target.value)} className="tabular-nums" />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-1">
            <Label>备注(可选)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="animate-spin" />}
            录入
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CsvImportForm({
  accounts,
  defaultAccountId,
  onClose,
}: {
  accounts: PortfolioAccount[];
  defaultAccountId?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number>(defaultAccountId ?? accounts[0]?.id ?? 0);
  const [broker, setBroker] = useState<string>('');
  const [dryRun, setDryRun] = useState(true);
  const [file, setFile] = useState<File | null>(null);

  const brokersQ = useQuery({
    queryKey: ['portfolio-csv-brokers'],
    queryFn: api.portfolioCsvBrokers,
  });
  const brokers = brokersQ.data?.brokers || [];

  // 默认选第一个 broker
  useMemo(() => {
    if (!broker && brokers.length > 0) setBroker(brokers[0].broker);
  }, [broker, brokers]);

  const mut = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('请选择文件');
      return api.portfolioCsvCommit({ account_id: accountId, broker, dry_run: dryRun, file });
    },
    onSuccess: (r) => {
      if (r.dry_run) {
        toast.success(
          `试跑成功:解析 ${r.record_count} / 可入库 ${r.inserted_count} / 重复 ${r.duplicate_count} / 失败 ${r.failed_count}`,
          { duration: 8000 },
        );
      } else {
        toast.success(`导入完成:新增 ${r.inserted_count} / 跳过重复 ${r.duplicate_count} / 失败 ${r.failed_count}`);
        qc.invalidateQueries({ queryKey: ['portfolio-snapshot'] });
        qc.invalidateQueries({ queryKey: ['portfolio-trades'] });
        qc.invalidateQueries({ queryKey: ['portfolio-risk'] });
        onClose();
      }
    },
    onError: (e: Error) => toast.error(`导入失败: ${e.message}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">CSV 导入交易</CardTitle>
        <CardDescription>
          上传券商交易明细 CSV,系统按 dedup hash 去重。建议先「试跑」再正式导入。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label>账户</Label>
          <div className="flex flex-wrap gap-1">
            {accounts.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={accountId === a.id ? 'default' : 'outline'}
                onClick={() => setAccountId(a.id)}
              >
                {a.name}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>券商(决定 CSV 解析格式)</Label>
          {brokersQ.isLoading ? (
            <Skeleton className="h-8 w-48" />
          ) : (
            <div className="flex flex-wrap gap-1">
              {brokers.map((b) => (
                <Button
                  key={b.broker}
                  size="sm"
                  variant={broker === b.broker ? 'default' : 'outline'}
                  onClick={() => setBroker(b.broker)}
                  title={b.aliases.join(' / ')}
                >
                  {b.broker}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>CSV 文件</Label>
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="file:bg-muted file:mr-2 file:rounded file:border-0 file:px-2 file:py-1 file:text-xs"
          />
          {file && (
            <span className="text-muted-foreground text-xs">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="size-4"
            />
            <span className="text-muted-foreground">试跑(不实际入库)</span>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !file || !broker}>
            {mut.isPending && <Loader2 className="animate-spin" />}
            {dryRun ? '试跑' : '正式导入'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountSelector({
  accounts,
  loading,
  value,
  onChange,
}: {
  accounts: PortfolioAccount[];
  loading: boolean;
  value: number;
  onChange: (id: number) => void;
}) {
  if (loading) return <Skeleton className="h-9 w-48" />;
  if (accounts.length === 0) {
    return <span className="text-muted-foreground text-sm">尚未配置账户</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={value === ALL ? 'default' : 'outline'}
        size="sm"
        onClick={() => onChange(ALL)}
      >
        全部账户
      </Button>
      {accounts.map((a) => (
        <Button
          key={a.id}
          variant={value === a.id ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(a.id)}
        >
          {a.name}
          {a.broker && (
            <span className="text-muted-foreground ml-1 text-xs">· {a.broker}</span>
          )}
        </Button>
      ))}
    </div>
  );
}

function OverviewCard({
  label,
  value,
  currency,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number;
  currency: string;
  icon?: typeof Wallet;
  accent?: 'primary' | 'success' | 'destructive';
}) {
  const cls =
    accent === 'success'
      ? 'text-[color:var(--success)]'
      : accent === 'destructive'
        ? 'text-[color:var(--destructive)]'
        : accent === 'primary'
          ? ''
          : '';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-muted-foreground flex items-center justify-between text-xs font-medium">
          {label}
          {Icon && <Icon className={cn('size-4', cls)} />}
        </CardTitle>
        <div className="flex items-baseline gap-1.5">
          <span className={cn('text-2xl font-bold tracking-tight tabular-nums', cls)}>
            {formatAmount(value)}
          </span>
          <span className="text-muted-foreground text-xs">{currency}</span>
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

function PositionRow({ p }: { p: PortfolioPosition }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-sm">
        <a className="hover:underline" href={`/stock/${encodeURIComponent(p.symbol)}`}>
          {p.symbol}
        </a>
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="text-[10px]">
          {p.market}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">{p.quantity.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">{formatPrice(p.avg_cost, 4)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {formatPrice(p.last_price, 4)}
        {p.price_stale && (
          <Badge variant="warning" className="ml-1 text-[9px]">
            旧价
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatAmount(p.market_value_base)}
      </TableCell>
      <TableCell className={cn('text-right font-medium tabular-nums', changeColor(p.unrealized_pnl_base))}>
        {(p.unrealized_pnl_base >= 0 ? '+' : '') + formatAmount(p.unrealized_pnl_base)}
      </TableCell>
      <TableCell className={cn('text-right tabular-nums', changeColor(p.unrealized_pnl_pct))}>
        {formatPercent(p.unrealized_pnl_pct == null ? null : p.unrealized_pnl_pct * 100)}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">{p.currency}</TableCell>
    </TableRow>
  );
}

function TradeRow({ t, onDelete }: { t: PortfolioTrade; onDelete: () => void }) {
  const isBuy = t.side.toLowerCase() === 'buy';
  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-xs">{t.trade_date}</TableCell>
      <TableCell className="font-mono text-sm">{t.symbol}</TableCell>
      <TableCell>
        <Badge variant={isBuy ? 'success' : 'destructive'}>
          {isBuy ? '买入' : '卖出'}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">{t.quantity.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">{formatPrice(t.price, 4)}</TableCell>
      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
        {(t.fee + t.tax).toFixed(2)}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
        {t.note || '—'}
      </TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function RiskSection({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data || {}).filter(([k]) => !k.startsWith('_'));
  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground mb-2 text-xs font-medium">{title}</div>
      {entries.length === 0 ? (
        <div className="text-muted-foreground text-xs">无数据</div>
      ) : (
        <dl className="space-y-1 text-sm">
          {entries.slice(0, 6).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted-foreground truncate">{k}</dt>
              <dd className="font-medium tabular-nums">{formatRiskValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function EmptyBox({ icon: Icon, text }: { icon: typeof Briefcase; text: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-sm">
      <Icon className="size-6 opacity-60" />
      {text}
    </div>
  );
}

function ErrorBox({ msg }: { msg?: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      加载失败: {msg || '未知错误'}
    </div>
  );
}

function formatAmount(v: number): string {
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toFixed(2);
}

function formatRiskValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (Math.abs(v) < 1 && Math.abs(v) > 0) return (v * 100).toFixed(2) + '%';
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `${v.length} 项`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    return keys.length > 0 ? `{${keys.length}}` : '—';
  }
  return String(v);
}
