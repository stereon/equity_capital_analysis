/**
 * API client — 封装对后端 FastAPI 的调用,统一错误处理。
 * 开发期通过 Vite proxy 转发到 http://127.0.0.1:8000;生产期同源。
 */
const API_BASE = '/api/v1';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    let detail: unknown = await res.text().catch(() => res.statusText);
    try {
      detail = JSON.parse(detail as string);
    } catch {
      /* 文本错误,保持原样 */
    }
    throw new ApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

// === Types ===

export interface HealthResponse {
  status: string;
  version?: string;
}

export interface AnalyzeRequest {
  stock_code: string;
  skills?: string[];
  async_mode?: boolean;
}

export interface TaskRef {
  task_id?: string;
  status?: string;
  message?: string;
}

export interface MarketReviewResponse {
  task_id?: string;
  status?: string;
}

export interface HistoryRecord {
  record_id?: number;
  query_id?: string;
  code?: string;
  stock_code?: string;
  name?: string;
  stock_name?: string;
  signal?: string;
  decision?: string;
  score?: number;
  trend?: string;
  report_type?: string;
  created_at?: string;
  report_date?: string;
}

export interface HistoryListResponse {
  items: HistoryRecord[];
  total?: number;
  page?: number;
  page_size?: number;
}

export interface HistoryDetailRaw {
  meta?: {
    id?: number;
    query_id?: string;
    stock_code?: string;
    stock_name?: string;
    report_type?: string;
    report_language?: string;
    created_at?: string;
    current_price?: number | null;
    change_pct?: number | null;
    model_used?: string | null;
  };
  summary?: {
    analysis_summary?: string;
    operation_advice?: string;
    trend_prediction?: string;
    sentiment_score?: number;
    sentiment_label?: string;
  };
  strategy?: {
    ideal_buy?: number | null;
    secondary_buy?: number | null;
    stop_loss?: number | null;
    take_profit?: number | null;
  };
  details?: {
    news_content?: string;
    raw_result?: Record<string, unknown>;
    context_snapshot?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface RecommendCandidate {
  code: string;
  name: string;
  industry: string | null;
  last_price: number;
  change_pct: number;
  score: number;
  signals: string[];
  sector_match: string | null;
}

export interface RecommendResponse {
  hot_sectors: string[];
  candidates: RecommendCandidate[];
  pool_size?: number;
  report_path?: string | null;
  query_id?: string | null;
  price_as_of?: string | null;
}

// === Endpoints ===

export const api = {
  health: () => request<HealthResponse>('/../../api/health'),

  analyze: (body: AnalyzeRequest) =>
    request<TaskRef>('/analysis/analyze', {
      method: 'POST',
      body: JSON.stringify({ async_mode: true, ...body }),
    }),

  marketReview: () =>
    request<MarketReviewResponse>('/analysis/market-review', {
      method: 'POST',
      body: JSON.stringify({ send_notification: false }),
    }),

  taskStatus: (taskId: string) =>
    request<{ status: string; progress?: number; message?: string; result?: unknown; error?: string }>(
      `/analysis/status/${taskId}`,
    ),

  history: (params: { page?: number; limit?: number; report_type?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.report_type) qs.set('report_type', params.report_type);
    return request<HistoryListResponse>(`/history${qs.toString() ? `?${qs}` : ''}`);
  },

  historyDetail: async (recordId: number | string) => {
    // 并行拉详情和 markdown:详情接口给元数据,markdown 接口给完整正文(对个股/复盘/早盘/收盘都适用)
    const [raw, mdResp] = await Promise.all([
      request<HistoryDetailRaw>(`/history/${recordId}`),
      request<{ content?: string; markdown?: string }>(`/history/${recordId}/markdown`).catch(
        () => ({ content: '', markdown: '' }) as { content?: string; markdown?: string },
      ),
    ]);
    const meta = raw.meta || {};
    const summary = raw.summary || {};
    const strategy = raw.strategy || {};
    const details = raw.details || {};
    const rawResult = (details.raw_result as Record<string, unknown> | undefined) || {};
    const markdown =
      (mdResp?.content as string | undefined) ||
      (mdResp?.markdown as string | undefined) ||
      (rawResult.raw_response as string | undefined) ||
      (details.news_content as string | undefined) ||
      '';
    return {
      record_id: meta.id,
      query_id: meta.query_id,
      code: meta.stock_code,
      stock_code: meta.stock_code,
      name: meta.stock_name,
      stock_name: meta.stock_name,
      report_type: meta.report_type,
      report_language: meta.report_language,
      created_at: meta.created_at,
      current_price: meta.current_price,
      change_pct: meta.change_pct,
      model_used: meta.model_used,
      decision: summary.operation_advice,
      score: summary.sentiment_score,
      trend: summary.trend_prediction,
      analysis_summary: summary.analysis_summary,
      sentiment_label: summary.sentiment_label,
      strategy,
      report_markdown: markdown,
      details,
      raw,
    };
  },

  // 自定义端点:由我们新写的 /api/v1/web/* 路由暴露
  recommend: (params: { top?: number; pool?: 'hs300' | 'watchlist' | 'both' } = {}) => {
    const qs = new URLSearchParams();
    if (params.top) qs.set('top', String(params.top));
    if (params.pool) qs.set('pool', params.pool);
    return request<RecommendResponse>(`/web/recommend${qs.toString() ? `?${qs}` : ''}`);
  },

  recommendStart: (params: { top?: number; pool?: 'hs300' | 'watchlist' | 'both' } = {}) => {
    const qs = new URLSearchParams();
    if (params.top) qs.set('top', String(params.top));
    if (params.pool) qs.set('pool', params.pool);
    return request<{ task_id: string }>(`/web/recommend/start${qs.toString() ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  },

  recommendStatus: (taskId: string) =>
    request<RecommendTaskStatus>(`/web/recommend/status/${taskId}`),

  briefingStart: (kind: 'morning' | 'closing') =>
    request<{ task_id: string }>(`/web/briefing/${kind}/start`, { method: 'POST' }),

  briefingStatus: (taskId: string) =>
    request<BriefingTaskStatus>(`/web/briefing/status/${taskId}`),

  dashboard: (region: 'cn' | 'hk' | 'us' = 'cn', refresh = false) => {
    const qs = new URLSearchParams({ region });
    if (refresh) qs.set('refresh', 'true');
    return request<DashboardSnapshot>(`/web/dashboard?${qs}`);
  },

  // 持仓 ============
  portfolioAccounts: () =>
    request<{ accounts: PortfolioAccount[] }>(`/portfolio/accounts`),

  portfolioSnapshot: (params: { account_id?: number; cost_method?: 'fifo' | 'avg' } = {}) => {
    const qs = new URLSearchParams();
    if (params.account_id != null) qs.set('account_id', String(params.account_id));
    if (params.cost_method) qs.set('cost_method', params.cost_method);
    return request<PortfolioSnapshot>(`/portfolio/snapshot${qs.toString() ? `?${qs}` : ''}`);
  },

  portfolioRisk: (params: { account_id?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.account_id != null) qs.set('account_id', String(params.account_id));
    return request<PortfolioRisk>(`/portfolio/risk${qs.toString() ? `?${qs}` : ''}`);
  },

  portfolioTrades: (params: { account_id?: number; page?: number; page_size?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.account_id != null) qs.set('account_id', String(params.account_id));
    if (params.page) qs.set('page', String(params.page));
    if (params.page_size) qs.set('page_size', String(params.page_size));
    return request<{ items: PortfolioTrade[]; total: number }>(
      `/portfolio/trades${qs.toString() ? `?${qs}` : ''}`,
    );
  },

  portfolioAccountCreate: (body: PortfolioAccountCreateBody) =>
    request<PortfolioAccount>(`/portfolio/accounts`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  portfolioAccountDelete: (id: number) =>
    request<{ deleted: number }>(`/portfolio/accounts/${id}`, { method: 'DELETE' }),

  portfolioTradeCreate: (body: PortfolioTradeCreateBody) =>
    request<{ id: number }>(`/portfolio/trades`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  portfolioTradeDelete: (id: number) =>
    request<{ deleted: number }>(`/portfolio/trades/${id}`, { method: 'DELETE' }),

  portfolioCsvBrokers: () =>
    request<{ brokers: PortfolioCsvBroker[] }>(`/portfolio/imports/csv/brokers`),

  portfolioCsvCommit: (params: {
    account_id: number;
    broker: string;
    dry_run?: boolean;
    file: File;
  }) => {
    const form = new FormData();
    form.append('account_id', String(params.account_id));
    form.append('broker', params.broker);
    form.append('dry_run', String(params.dry_run ?? false));
    form.append('file', params.file);
    return fetch(`/api/v1/portfolio/imports/csv/commit`, {
      method: 'POST',
      body: form,
    }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, await r.text());
      return (await r.json()) as PortfolioCsvCommitResponse;
    });
  },

  // 告警 ============
  alertRules: (params: { page?: number; page_size?: number; enabled_only?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.page_size) qs.set('page_size', String(params.page_size));
    if (params.enabled_only) qs.set('enabled_only', 'true');
    return request<AlertRuleListResponse>(`/alerts/rules${qs.toString() ? `?${qs}` : ''}`);
  },

  alertRuleCreate: (body: AlertRuleCreateBody) =>
    request<AlertRule>(`/alerts/rules`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  alertRuleUpdate: (ruleId: number, body: Partial<AlertRuleCreateBody>) =>
    request<AlertRule>(`/alerts/rules/${ruleId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  alertRuleDelete: (ruleId: number) =>
    request<{ deleted: number }>(`/alerts/rules/${ruleId}`, { method: 'DELETE' }),

  alertRuleEnable: (ruleId: number) =>
    request<AlertRule>(`/alerts/rules/${ruleId}/enable`, { method: 'POST' }),

  alertRuleDisable: (ruleId: number) =>
    request<AlertRule>(`/alerts/rules/${ruleId}/disable`, { method: 'POST' }),

  alertRuleTest: (ruleId: number) =>
    request<AlertTestResult>(`/alerts/rules/${ruleId}/test`, { method: 'POST' }),

  alertTriggers: (params: { page?: number; page_size?: number; rule_id?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.page_size) qs.set('page_size', String(params.page_size));
    if (params.rule_id != null) qs.set('rule_id', String(params.rule_id));
    return request<AlertTriggerListResponse>(`/alerts/triggers${qs.toString() ? `?${qs}` : ''}`);
  },

  alertNotifications: (params: { page?: number; page_size?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.page_size) qs.set('page_size', String(params.page_size));
    return request<AlertNotificationListResponse>(
      `/alerts/notifications${qs.toString() ? `?${qs}` : ''}`,
    );
  },

  // Agent 策略列表(用于 Analyze 页 skill 多选)
  agentSkills: () => request<{ skills: AgentSkill[] }>(`/agent/skills`),

  // Agent 对话 ============
  chatSessions: (limit = 50) =>
    request<{ sessions: ChatSessionSummary[] }>(`/agent/chat/sessions?limit=${limit}`),
  chatSessionMessages: (sessionId: string, limit = 200) =>
    request<{ session_id: string; messages: ChatMessage[] }>(
      `/agent/chat/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`,
    ),
  chatDeleteSession: (sessionId: string) =>
    request<{ deleted: number }>(`/agent/chat/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  /**
   * 流式对话 — 使用 fetch + ReadableStream 读 SSE,每行 `data: {json}` 反序列化后回调 onEvent。
   * onEvent 收到 `done` / `error` 后流自动结束。
   */
  chatStream: async (
    body: { message: string; session_id?: string; skills?: string[] },
    onEvent: (e: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/agent/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await res.text().catch(() => res.statusText));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 帧以 \n\n 分隔
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (frame.startsWith('data:')) {
          const json = frame.slice(5).trim();
          try {
            onEvent(JSON.parse(json) as ChatStreamEvent);
          } catch {
            /* 忽略无法解析的帧 */
          }
        }
        idx = buf.indexOf('\n\n');
      }
    }
  },

  // 系统配置 ============
  systemConfig: () => request<SystemConfig>(`/system/config`),
  systemConfigSetupStatus: () => request<SystemConfigSetupStatus>(`/system/config/setup/status`),
  systemConfigUpdate: (body: SystemConfigUpdateBody) =>
    request<SystemConfigUpdateResponse>(`/system/config`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  systemConfigTestLLM: (channel: string) =>
    request<{ ok: boolean; message?: string; details?: unknown }>(
      `/system/config/llm/test-channel`,
      { method: 'POST', body: JSON.stringify({ channel }) },
    ),
  systemConfigTestNotification: (channel: string) =>
    request<{ ok: boolean; message?: string; details?: unknown }>(
      `/system/config/notification/test-channel`,
      { method: 'POST', body: JSON.stringify({ channel }) },
    ),

  // 行情 ============
  stockQuote: (code: string) => request<StockQuote>(`/stocks/${encodeURIComponent(code)}/quote`),

  stockHistory: (code: string, params: { period?: 'daily' | 'weekly' | 'monthly'; days?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.period) qs.set('period', params.period);
    if (params.days) qs.set('days', String(params.days));
    return request<StockHistoryResponse>(
      `/stocks/${encodeURIComponent(code)}/history${qs.toString() ? `?${qs}` : ''}`,
    );
  },

  // 回测 ============
  backtestRun: (body: BacktestRunBody) =>
    request<BacktestRunResult>(`/backtest/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  backtestResults: (params: {
    code?: string;
    eval_window_days?: number;
    page?: number;
    limit?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.code) qs.set('code', params.code);
    if (params.eval_window_days != null) qs.set('eval_window_days', String(params.eval_window_days));
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    return request<BacktestResultsResponse>(`/backtest/results${qs.toString() ? `?${qs}` : ''}`);
  },

  backtestPerformance: (params: { eval_window_days?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.eval_window_days != null) qs.set('eval_window_days', String(params.eval_window_days));
    return request<BacktestPerformance>(`/backtest/performance${qs.toString() ? `?${qs}` : ''}`);
  },

  backtestPerformanceByCode: (code: string, params: { eval_window_days?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.eval_window_days != null) qs.set('eval_window_days', String(params.eval_window_days));
    return request<BacktestPerformance>(
      `/backtest/performance/${encodeURIComponent(code)}${qs.toString() ? `?${qs}` : ''}`,
    );
  },
};

export interface BriefingTaskStatus {
  task_id: string;
  kind: 'morning' | 'closing';
  status: 'pending' | 'running' | 'completed' | 'failed';
  message?: string | null;
  elapsed_seconds?: number | null;
  error?: string | null;
  query_id?: string | null;
  date?: string | null;
}

export interface RecommendTaskStatus {
  task_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  stage?: string | null;
  progress: number; // 0-1
  message?: string | null;
  elapsed_seconds?: number | null;
  error?: string | null;
  result?: RecommendResponse | null;
}

// === Portfolio types ===

export interface PortfolioAccount {
  id: number;
  owner_id?: string | null;
  name: string;
  broker?: string | null;
  market: string;
  base_currency: string;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface PortfolioPosition {
  symbol: string;
  market: string;
  currency: string;
  quantity: number;
  avg_cost: number;
  total_cost: number;
  last_price: number;
  market_value_base: number;
  unrealized_pnl_base: number;
  unrealized_pnl_pct?: number | null;
  valuation_currency: string;
  price_source: string;
  price_provider?: string | null;
  price_date?: string | null;
  price_stale: boolean;
  price_available: boolean;
}

export interface PortfolioAccountSnapshot {
  account_id: number;
  account_name: string;
  owner_id?: string | null;
  broker?: string | null;
  market: string;
  base_currency: string;
  as_of: string;
  cost_method: string;
  total_cash: number;
  total_market_value: number;
  total_equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  fee_total: number;
  tax_total: number;
  fx_stale: boolean;
  positions: PortfolioPosition[];
}

export interface PortfolioSnapshot {
  as_of: string;
  cost_method: string;
  currency: string;
  account_count: number;
  total_cash: number;
  total_market_value: number;
  total_equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  fee_total: number;
  tax_total: number;
  fx_stale: boolean;
  accounts: PortfolioAccountSnapshot[];
}

export interface PortfolioRisk {
  as_of: string;
  account_id?: number | null;
  cost_method: string;
  currency: string;
  thresholds: Record<string, unknown>;
  concentration: Record<string, unknown>;
  sector_concentration: Record<string, unknown>;
  drawdown: Record<string, unknown>;
  stop_loss: Record<string, unknown>;
}

export interface PortfolioTrade {
  id: number;
  account_id: number;
  trade_uid?: string | null;
  symbol: string;
  market: string;
  currency: string;
  trade_date: string;
  side: string;
  quantity: number;
  price: number;
  fee: number;
  tax: number;
  note?: string | null;
  created_at?: string | null;
}

export interface PortfolioAccountCreateBody {
  name: string;
  broker?: string;
  market?: 'cn' | 'hk' | 'us';
  base_currency?: string;
  owner_id?: string;
}

export interface PortfolioTradeCreateBody {
  account_id: number;
  symbol: string;
  trade_date: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee?: number;
  tax?: number;
  market?: 'cn' | 'hk' | 'us';
  currency?: string;
  trade_uid?: string;
  note?: string;
}

export interface PortfolioCsvBroker {
  broker: string;
  aliases: string[];
}

export interface PortfolioCsvCommitResponse {
  account_id: number;
  record_count: number;
  inserted_count: number;
  duplicate_count: number;
  failed_count: number;
  dry_run: boolean;
  errors: string[];
}

// === Alert types ===

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertTargetScope =
  | 'single_symbol'
  | 'watchlist'
  | 'portfolio_holdings'
  | 'portfolio_account'
  | 'market';

export interface AlertRule {
  id: number;
  name: string;
  target_scope: string;
  target: string;
  alert_type: string;
  parameters: Record<string, unknown>;
  severity: string;
  enabled: boolean;
  source: string;
  cooldown_policy?: Record<string, unknown> | null;
  notification_policy?: Record<string, unknown> | null;
  last_triggered_at?: string | null;
  cooldown_until?: string | null;
  cooldown_active?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AlertRuleListResponse {
  items: AlertRule[];
  total: number;
  page: number;
  page_size: number;
}

export interface AlertRuleCreateBody {
  name?: string;
  target_scope: AlertTargetScope;
  target: string;
  alert_type: string;
  parameters?: Record<string, unknown>;
  severity?: AlertSeverity;
  enabled?: boolean;
}

export interface AlertTestTargetResult {
  target: string;
  display_target?: string | null;
  status: string;
  record_status?: string | null;
  triggered: boolean;
  observed_value?: unknown;
  threshold?: unknown;
  message: string;
}

export interface AlertTestResult {
  rule_id: number;
  target_scope?: string | null;
  status: string;
  triggered: boolean;
  observed_value?: unknown;
  message: string;
  evaluated_count: number;
  triggered_count: number;
  degraded_count: number;
  skipped_count: number;
  target_results: AlertTestTargetResult[];
}

export interface AlertTrigger {
  id: number;
  rule_id?: number | null;
  target: string;
  observed_value?: number | null;
  threshold?: number | null;
  reason?: string | null;
  data_source?: string | null;
  data_timestamp?: string | null;
  triggered_at?: string | null;
  status: string;
  diagnostics?: string | null;
}

export interface AlertTriggerListResponse {
  items: AlertTrigger[];
  total: number;
  page: number;
  page_size: number;
}

export interface AlertNotification {
  id: number;
  trigger_id?: number | null;
  channel: string;
  attempt: number;
  success: boolean;
  error_code?: string | null;
  retryable: boolean;
  latency_ms?: number | null;
  diagnostics?: string | null;
  created_at?: string | null;
}

export interface AlertNotificationListResponse {
  items: AlertNotification[];
  total: number;
  page: number;
  page_size: number;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface ChatSessionSummary {
  session_id: string;
  message_count: number;
  created_at?: string | null;
  last_active?: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

export type ChatStreamEvent =
  | { type: 'thinking'; message?: string }
  | { type: 'tool_start'; tool: string; display_name?: string; args?: Record<string, unknown> }
  | { type: 'tool_done'; tool: string; display_name?: string; success?: boolean; duration_ms?: number }
  | { type: 'generating'; partial?: string }
  | { type: 'done'; success: boolean; content: string; session_id: string; total_steps?: number; error?: string | null }
  | { type: 'error'; message: string };

// === System config types ===

export interface SystemConfigFieldSchema {
  key: string;
  title: string;
  description?: string | null;
  category: string;
  data_type: string;
  ui_control: string;
  is_sensitive: boolean;
  is_required: boolean;
  is_editable: boolean;
  default_value?: string | null;
  options?: Array<{ value: string; label?: string } | string>;
  validation?: Record<string, unknown>;
  display_order?: number;
  examples?: string[];
  docs?: Array<{ label: string; href: string }>;
  warning_codes?: string[];
}

export interface SystemConfigItem {
  key: string;
  value: string;
  raw_value_exists: boolean;
  is_masked: boolean;
  schema: SystemConfigFieldSchema;
}

export interface SystemConfig {
  config_version: string;
  mask_token: string;
  items: SystemConfigItem[];
}

export interface SystemConfigUpdateBody {
  config_version: string;
  items: Array<{ key: string; value: string }>;
  mask_token?: string;
  reload_now?: boolean;
}

export interface SystemConfigUpdateResponse {
  config_version: string;
  updated_keys: string[];
  reloaded: boolean;
  issues?: Array<{ key?: string; message: string }>;
}

export interface SystemConfigSetupCheck {
  key: string;
  title: string;
  category: string;
  required: boolean;
  status: string;
  message?: string | null;
  next_step?: string | null;
}

export interface SystemConfigSetupStatus {
  is_complete: boolean;
  ready_for_smoke: boolean;
  required_missing_keys: string[];
  next_step_key?: string | null;
  checks: SystemConfigSetupCheck[];
}

// === Stock quote / history ===

export interface StockQuote {
  stock_code: string;
  stock_name?: string | null;
  current_price: number;
  change?: number | null;
  change_percent?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prev_close?: number | null;
  volume?: number | null;
  amount?: number | null;
  update_time?: string | null;
}

export interface KLineData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  amount?: number | null;
  change_percent?: number | null;
}

export interface StockHistoryResponse {
  stock_code: string;
  stock_name?: string | null;
  period: string;
  data: KLineData[];
}

// === Backtest types ===

export interface BacktestRunBody {
  code?: string;
  force?: boolean;
  eval_window_days?: number;
  min_age_days?: number;
  limit?: number;
}

export interface BacktestRunResult {
  processed: number;
  saved: number;
  completed: number;
  insufficient: number;
  errors: number;
}

export interface BacktestResult {
  analysis_history_id: number;
  code: string;
  stock_name?: string | null;
  analysis_date?: string | null;
  eval_window_days: number;
  engine_version: string;
  eval_status: string;
  evaluated_at?: string | null;
  operation_advice?: string | null;
  trend_prediction?: string | null;
  position_recommendation?: string | null;
  start_price?: number | null;
  end_close?: number | null;
  max_high?: number | null;
  min_low?: number | null;
  stock_return_pct?: number | null;
  actual_return_pct?: number | null;
  actual_movement?: string | null;
  direction_expected?: string | null;
  direction_correct?: boolean | null;
  outcome?: string | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  hit_stop_loss?: boolean | null;
  hit_take_profit?: boolean | null;
  first_hit?: string | null;
  first_hit_date?: string | null;
  first_hit_trading_days?: number | null;
  simulated_entry_price?: number | null;
  simulated_exit_price?: number | null;
  simulated_exit_reason?: string | null;
  simulated_return_pct?: number | null;
}

export interface BacktestResultsResponse {
  total: number;
  page: number;
  limit: number;
  items: BacktestResult[];
}

export interface BacktestPerformance {
  scope: string;
  code?: string | null;
  eval_window_days: number;
  engine_version: string;
  computed_at?: string | null;
  total_evaluations: number;
  completed_count: number;
  insufficient_count: number;
  long_count: number;
  cash_count: number;
  win_count: number;
  loss_count: number;
  neutral_count: number;
  direction_accuracy_pct?: number | null;
  win_rate_pct?: number | null;
  neutral_rate_pct?: number | null;
  avg_stock_return_pct?: number | null;
  avg_simulated_return_pct?: number | null;
  stop_loss_trigger_rate?: number | null;
  take_profit_trigger_rate?: number | null;
  ambiguous_rate?: number | null;
  avg_days_to_first_hit?: number | null;
  advice_breakdown: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

export interface IndexQuote {
  code: string;
  name: string;
  current?: number;
  change_pct?: number;
  change?: number;
}

export interface MarketStats {
  up?: number;
  down?: number;
  limit_up?: number;
  limit_down?: number;
  unchanged?: number;
  total_amount?: number; // 总成交额(亿元)
}

export interface SectorEntry {
  name: string;
  change_pct?: number;
}

export interface DashboardSnapshot {
  region: 'cn' | 'hk' | 'us';
  generated_at: string;
  indices: IndexQuote[];
  market_stats: MarketStats | null;
  top_sectors: SectorEntry[];
  bottom_sectors: SectorEntry[];
}
