import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { Send, Loader2, Plus, Trash2, Wrench, MessageSquare, Bot, User as UserIcon, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatSessionSummary, type ChatStreamEvent } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Role = 'user' | 'assistant';

// 会话别名持久化在 localStorage,后端 schema 暂未支持 title
const ALIAS_STORAGE_KEY = 'chat-session-aliases';

function loadAliases(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ALIAS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAliases(map: Record<string, string>) {
  try {
    localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota 满或不可写,忽略 */
  }
}

interface ToolEvent {
  tool: string;
  display_name: string;
  status: 'running' | 'done';
}

interface UiMessage {
  id: string;
  role: Role;
  content: string;
  // assistant 消息可能附带工具调用日志
  tools?: ToolEvent[];
  // streaming 中
  streaming?: boolean;
}

export default function Chat() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [aliases, setAliases] = useState<Record<string, string>>(() => loadAliases());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const handleRename = (sid: string) => {
    const current = aliases[sid] || '';
    const next = window.prompt('给会话起个名字', current);
    if (next === null) return; // 取消
    const trimmed = next.trim();
    setAliases((prev) => {
      const updated = { ...prev };
      if (trimmed) updated[sid] = trimmed;
      else delete updated[sid];
      saveAliases(updated);
      return updated;
    });
  };

  // 会话列表
  const sessionsQ = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => api.chatSessions(50),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const sessions = sessionsQ.data?.sessions || [];

  // 切换会话:拉历史消息
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.chatSessionMessages(sessionId, 200);
        if (cancelled) return;
        // 后端返回的 messages 形态较松,这里只挑 user/assistant 用于显示
        const mapped: UiMessage[] = (r.messages || [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => ({
            id: `${sessionId}-${i}`,
            role: m.role as Role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          }));
        setMessages(mapped);
      } catch (e) {
        toast.error(`加载会话失败: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleNew = () => {
    if (sending) return;
    setSessionId(null);
    setMessages([]);
    setInput('');
  };

  const handleSelect = (sid: string) => {
    if (sending) {
      toast.warning('当前对话进行中，等待完成或停止后再切换');
      return;
    }
    setSessionId(sid);
  };

  const handleDelete = async (sid: string) => {
    if (!confirm('确定删除该会话？此操作不可撤销')) return;
    try {
      await api.chatDeleteSession(sid);
      toast.success('已删除');
      queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
      if (sid === sessionId) {
        setSessionId(null);
        setMessages([]);
      }
      // 同步清掉本地别名
      setAliases((prev) => {
        if (!(sid in prev)) return prev;
        const updated = { ...prev };
        delete updated[sid];
        saveAliases(updated);
        return updated;
      });
    } catch (e) {
      toast.error(`删除失败: ${(e as Error).message}`);
    }
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSending(false);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const userMsg: UiMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const aiMsgId = `a-${Date.now()}`;
    const aiMsg: UiMessage = { id: aiMsgId, role: 'assistant', content: '', streaming: true, tools: [] };
    setMessages((prev) => [...prev, userMsg, aiMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const updateAi = (patch: (m: UiMessage) => UiMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? patch(m) : m)));

    try {
      await api.chatStream(
        { message: text, session_id: sessionId || undefined },
        (e: ChatStreamEvent) => {
          if (e.type === 'thinking') {
            updateAi((m) => ({ ...m, content: m.content || '思考中…' }));
          } else if (e.type === 'tool_start') {
            updateAi((m) => ({
              ...m,
              tools: [
                ...(m.tools || []),
                { tool: e.tool, display_name: e.display_name || e.tool, status: 'running' },
              ],
            }));
          } else if (e.type === 'tool_done') {
            updateAi((m) => ({
              ...m,
              tools: (m.tools || []).map((t) =>
                t.tool === e.tool && t.status === 'running' ? { ...t, status: 'done' } : t,
              ),
            }));
          } else if (e.type === 'generating') {
            updateAi((m) => ({ ...m, content: m.content || '生成中…' }));
          } else if (e.type === 'done') {
            updateAi((m) => ({ ...m, content: e.content || m.content, streaming: false }));
            if (e.session_id && e.session_id !== sessionId) setSessionId(e.session_id);
            queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
          } else if (e.type === 'error') {
            updateAi((m) => ({ ...m, content: `错误: ${e.message}`, streaming: false }));
            toast.error(e.message);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        updateAi((m) => ({ ...m, content: m.content || '（已停止）', streaming: false }));
      } else {
        updateAi((m) => ({ ...m, content: `错误: ${(err as Error).message}`, streaming: false }));
        toast.error(`对话失败: ${(err as Error).message}`);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter 发送;单纯 Enter 换行
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const empty = useMemo(() => messages.length === 0, [messages]);

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-4">
      {/* 左侧:会话列表 */}
      <aside className="bg-card text-card-foreground flex w-60 shrink-0 flex-col rounded-md border">
        <div className="border-b p-3">
          <Button size="sm" className="w-full" onClick={handleNew} disabled={sending}>
            <Plus className="size-4" />
            新对话
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessionsQ.isLoading ? (
            <p className="text-muted-foreground p-2 text-xs">加载中…</p>
          ) : sessions.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">暂无历史会话</p>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.session_id}
                s={s}
                alias={aliases[s.session_id]}
                active={s.session_id === sessionId}
                onSelect={() => handleSelect(s.session_id)}
                onDelete={() => handleDelete(s.session_id)}
                onRename={() => handleRename(s.session_id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* 右侧:消息流 + 输入 */}
      <section className="flex flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-md border bg-background p-4">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <MessageSquare className="size-10 opacity-40" />
              <p className="text-sm">开始一次新的对话。可以问股票、要求分析、看新闻热点等。</p>
              <p className="text-xs">Cmd/Ctrl + Enter 发送；Enter 换行</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息…  (Cmd/Ctrl + Enter 发送)"
            rows={3}
            className="flex-1 resize-none rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            disabled={sending}
          />
          {sending ? (
            <Button variant="destructive" onClick={handleStop}>
              停止
            </Button>
          ) : (
            <Button onClick={handleSend} disabled={!input.trim()}>
              <Send className="size-4" />
              发送
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function SessionRow({
  s,
  alias,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  s: ChatSessionSummary;
  alias?: string;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const titleText = alias || `${s.session_id.slice(0, 12)}…`;
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <MessageSquare className="size-4 shrink-0" />
      <div className="flex flex-1 flex-col overflow-hidden">
        <span
          className={cn(
            'truncate text-xs',
            alias ? 'font-medium text-foreground' : 'font-mono',
          )}
          title={alias ? s.session_id : undefined}
        >
          {titleText}
        </span>
        <span className="text-xs opacity-70">
          {s.message_count} 条 · {(s.last_active || s.created_at || '').slice(0, 16)}
        </span>
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="hover:text-foreground"
          title="重命名"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="hover:text-destructive"
          title="删除"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: UiMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[80%] items-start gap-2">
          <div className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground whitespace-pre-wrap">
            {m.content}
          </div>
          <div className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
            <UserIcon className="size-4" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] items-start gap-2">
        <div className="bg-primary/15 text-primary flex size-8 shrink-0 items-center justify-center rounded-full">
          <Bot className="size-4" />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          {m.tools && m.tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {m.tools.map((t, i) => (
                <span
                  key={i}
                  className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
                >
                  {t.status === 'running' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Wrench className="size-3" />
                  )}
                  {t.display_name}
                </span>
              ))}
            </div>
          )}
          <div className="bg-muted/50 rounded-lg px-4 py-2 text-sm">
            {m.content ? (
              <article className="prose prose-sm prose-invert prose-zinc max-w-none prose-pre:bg-secondary/40 prose-pre:border prose-code:before:hidden prose-code:after:hidden">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeHighlight]}
                >
                  {m.content}
                </ReactMarkdown>
              </article>
            ) : (
              <Loader2 className="size-4 animate-spin" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

