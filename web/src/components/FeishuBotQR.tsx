import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ExternalLink, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 飞书开发者后台创建自建应用入口（桌面端流程）。 */
export const FEISHU_CREATE_APP_URL = 'https://open.feishu.cn/app';

/** 飞书机器人接入指南（仓库内文档）。 */
const FEISHU_GUIDE_URL =
  'https://github.com/stereon/equity_capital_analysis/blob/main/docs/full-guide.md';

/**
 * 拼接「打开机器人会话」的飞书 AppLink。
 * 飞书客户端 3.40.0+ 扫码即可打开与该机器人的单聊会话。
 * 文档：https://open.feishu.cn/document/common-capabilities/applink-protocol/supported-protocol/open-a-bot
 */
export function buildFeishuBotAppLink(appId: string): string {
  return `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId.trim())}`;
}

/** App ID 是否形如 cli_xxx（仅用于提示，不阻断渲染）。 */
function looksLikeAppId(appId: string): boolean {
  return /^cli_\S+/.test(appId.trim());
}

/**
 * 飞书机器人扫码入口（设置页 FEISHU_APP_ID 字段下方）。
 *
 * 双状态：
 * - 已配置 App ID：展示机器人会话二维码，飞书 App 扫码直接开聊。
 * - 未配置 App ID：展示「前往飞书开放平台创建自建应用」引导（链接为主、二维码为辅）。
 */
export function FeishuBotQR({ appId }: { appId?: string }) {
  const trimmed = (appId ?? '').trim();
  const hasAppId = trimmed.length > 0;

  return (
    <div className="bg-muted/30 mt-1 space-y-3 rounded-md border p-3">
      {hasAppId ? (
        <BotChatQR appId={trimmed} valid={looksLikeAppId(trimmed)} />
      ) : (
        <CreateAppGuide />
      )}
    </div>
  );
}

function BotChatQR({ appId, valid }: { appId: string; valid: boolean }) {
  const link = buildFeishuBotAppLink(appId);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默忽略，用户仍可手动复制链接文本
    }
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="bg-background shrink-0 rounded-md border p-2">
        <QRCodeSVG value={link} size={120} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-foreground text-xs font-medium">
          用飞书 App 扫码打开机器人会话（飞书 3.40+）
        </p>
        {!valid && (
          <p className="text-[color:var(--warning)] text-[11px]">
            当前 App ID 不像 <code className="font-mono">cli_xxx</code> 格式，请确认后再扫码。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-muted text-muted-foreground min-w-0 truncate rounded px-1.5 py-0.5 text-[10px] font-mono">
            {link}
          </code>
          <Button variant="ghost" size="sm" onClick={copy} className="h-7 gap-1 px-2">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : '复制链接'}
          </Button>
        </div>
        <p className="text-muted-foreground text-[11px]">
          需开启 <code className="font-mono">FEISHU_STREAM_ENABLED</code> 且应用已发布、用户在可见范围内，扫码会话才会有回复。
        </p>
      </div>
    </div>
  );
}

function CreateAppGuide() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="bg-background shrink-0 rounded-md border p-2 opacity-90">
        <QRCodeSVG value={FEISHU_CREATE_APP_URL} size={100} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-foreground text-xs font-medium">
          还没有飞书应用？先创建一个自建应用拿到 App ID
        </p>
        <ol className="text-muted-foreground list-decimal space-y-0.5 pl-4 text-[11px]">
          <li>前往飞书开放平台，创建「企业自建应用」</li>
          <li>添加「机器人」能力并发布应用</li>
          <li>把应用的 App ID / App Secret 填到本页对应字段，并开启 Stream 模式</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <a href={FEISHU_CREATE_APP_URL} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm" className="h-7 gap-1 px-2">
              <ExternalLink className="size-3.5" />
              前往飞书开放平台
            </Button>
          </a>
          <a
            href={FEISHU_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'text-muted-foreground hover:text-primary inline-flex items-center gap-1 text-xs',
            )}
          >
            <ExternalLink className="size-3" />
            接入指南
          </a>
        </div>
      </div>
    </div>
  );
}
