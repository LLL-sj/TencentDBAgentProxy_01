import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card, Justify, SearchBox, Select, Tag } from 'tea-component';
import { useAgents, useTeams } from '@/services';
import {
  formatTipsError,
  TIP_STATUS_LABELS,
  tipsApi,
  type SummaryTipItem,
  type TipStatus,
} from '@/lib/tips-api';
import { ResourcePage } from '@/pages/ResourcePage';

type StatusFilter = '' | TipStatus;

const STATUS_OPTIONS: Array<{ value: StatusFilter; text: string }> = [
  { value: '', text: '全部状态' },
  { value: 'pending', text: '待消费' },
  { value: 'consuming', text: '消费中' },
  { value: 'consumed', text: '已消费' },
  { value: 'duplicate', text: '重复' },
  { value: 'expired', text: '已过期' },
];

function statusClass(status: TipStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-primary/10 text-primary';
    case 'consuming':
      return 'bg-amber-500/10 text-amber-600';
    case 'consumed':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'duplicate':
      return 'bg-slate-500/10 text-slate-500';
    case 'expired':
      return 'bg-red-500/10 text-red-500';
  }
}

function formatTime(value: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}

function refsText(tip: SummaryTipItem): string {
  if (tip.l0_refs.length > 0) return tip.l0_refs.join(', ');
  if (tip.l0_start_ref || tip.l0_end_ref) return `${tip.l0_start_ref || '?'} .. ${tip.l0_end_ref || '?'}`;
  return '—';
}

export function TipsPage() {
  const { activeTeamId } = useTeams();
  const { agents } = useAgents(activeTeamId);
  const [tips, setTips] = useState<SummaryTipItem[]>([]);
  const [selected, setSelected] = useState<SummaryTipItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [agentFilter, setAgentFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeTeamId) {
      setTips([]);
      setSelected(null);
      return;
    }
    setLoading(true);
    try {
      const result = await tipsApi.list(activeTeamId, {
        status: statusFilter || undefined,
        agent_id: agentFilter || undefined,
        limit: 200,
        offset: 0,
      });
      setTips(result.items);
      setSelected((prev) => {
        if (prev && result.items.some((item) => item.tip_id === prev.tip_id)) return prev;
        return null;
      });
    } catch (err) {
      console.error('tips refresh failed', err);
      setTips([]);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, [activeTeamId, statusFilter, agentFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredTips = useMemo(() => {
    if (!keyword.trim()) return tips;
    const q = keyword.trim().toLowerCase();
    return tips.filter((tip) =>
      tip.summary.toLowerCase().includes(q) ||
      tip.tip_id.toLowerCase().includes(q) ||
      tip.tags.some((tag) => tag.toLowerCase().includes(q)) ||
      tip.agent_id.toLowerCase().includes(q) ||
      tip.session_id.toLowerCase().includes(q),
    );
  }, [tips, keyword]);

  const openTip = async (tipId: string) => {
    if (!activeTeamId) return;
    try {
      const detail = await tipsApi.get(activeTeamId, tipId);
      setSelected(detail);
    } catch (err) {
      console.error(err);
      alert(formatTipsError(err));
    }
  };

  const agentOptions = useMemo(
    () => agents.map((agent) => ({ value: agent.agent_id, text: `${agent.name}（${agent.agent_id}）` })),
    [agents],
  );

  return (
    <ResourcePage>
      <div className="flex h-full gap-4">
        <Card className="w-[420px] shrink-0">
          <Card.Body>
            <Justify
              left={<h3 className="text-base font-semibold">Task Summary Tips</h3>}
              right={<span className="text-xs text-muted-foreground">共 {filteredTips.length} 条</span>}
            />
            <div className="mt-3 space-y-3">
              <SearchBox value={keyword} onChange={(v) => setKeyword(v)} placeholder="搜索总结/标签/Agent/会话" />
              <div className="flex gap-2">
                <Select
                  appearance="button"
                  matchButtonWidth
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as StatusFilter)}
                  options={STATUS_OPTIONS}
                />
                <Select
                  appearance="button"
                  matchButtonWidth
                  value={agentFilter}
                  onChange={(v) => setAgentFilter(v)}
                  placeholder="全部 Agent"
                  options={[
                    { value: '', text: '全部 Agent' },
                    ...agentOptions,
                  ]}
                />
              </div>
              <div className="space-y-2 overflow-auto" style={{ maxHeight: 600 }}>
                {loading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
                {filteredTips.map((tip) => (
                  <div
                    key={tip.tip_id}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors ${selected?.tip_id === tip.tip_id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                    onClick={() => void openTip(tip.tip_id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{tip.tip_id}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${statusClass(tip.status)}`}>
                        {TIP_STATUS_LABELS[tip.status] ?? tip.status}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{tip.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {tip.tags.length > 0
                        ? tip.tags.map((tag) => (
                            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag}</span>
                          ))
                        : <span className="text-[11px] text-muted-foreground">无标签</span>}
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {tip.agent_id} · {formatTime(tip.created_at)}
                    </div>
                  </div>
                ))}
                {!loading && filteredTips.length === 0 ? <div className="text-sm text-muted-foreground">暂无 tips</div> : null}
              </div>
            </div>
          </Card.Body>
        </Card>

        <Card className="min-w-0 flex-1">
          <Card.Body>
            {selected ? (
              <>
                <Justify
                  left={
                    <div>
                      <div className="text-base font-semibold">{selected.tip_id}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusClass(selected.status)}`}>
                          {TIP_STATUS_LABELS[selected.status] ?? selected.status}
                        </span>
                        <span className="text-xs text-muted-foreground">v{selected.version}</span>
                        {selected.user_feedback_received ? <Tag>已收到用户反馈</Tag> : null}
                      </div>
                    </div>
                  }
                  right={<span className="text-xs text-muted-foreground">{formatTime(selected.created_at)}</span>}
                />

                <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Agent ID</div>
                    <div className="break-all font-mono text-xs">{selected.agent_id}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">User ID</div>
                    <div className="break-all font-mono text-xs">{selected.user_id}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Session ID</div>
                    <div className="break-all font-mono text-xs">{selected.session_id}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Task ID</div>
                    <div className="break-all font-mono text-xs">{selected.task_id || '—'}</div>
                  </div>
                </div>

                {selected.tags.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-1">
                    {selected.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                  </div>
                ) : null}

                <div className="mt-5">
                  <h4 className="text-sm font-semibold">L0 锚点范围</h4>
                  <div className="mt-2 rounded-lg bg-muted p-3 text-xs">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-muted-foreground">l0_start_ref：</span>
                        <span className="break-all font-mono">{selected.l0_start_ref || '—'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">l0_end_ref：</span>
                        <span className="break-all font-mono">{selected.l0_end_ref || '—'}</span>
                      </div>
                    </div>
                    <div className="mt-2">
                      <span className="text-muted-foreground">l0_refs：</span>
                      <span className="break-all font-mono">{refsText(selected)}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-5">
                  <h4 className="text-sm font-semibold">总结正文</h4>
                  <div className="prose prose-sm mt-2 max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {selected.summary}
                    </ReactMarkdown>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-sm font-semibold">Steps</h4>
                    {selected.steps.length > 0 ? (
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                        {selected.steps.map((step, idx) => <li key={`${step}-${idx}`}>{step}</li>)}
                      </ol>
                    ) : <p className="mt-2 text-sm text-muted-foreground">—</p>}
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold">Artifacts</h4>
                    {selected.artifacts.length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {selected.artifacts.map((artifact, idx) => <li key={`${artifact}-${idx}`}>{artifact}</li>)}
                      </ul>
                    ) : <p className="mt-2 text-sm text-muted-foreground">—</p>}
                  </div>
                </div>

                <div className="mt-5 text-xs text-muted-foreground">
                  创建时间：{formatTime(selected.created_at)}　更新时间：{formatTime(selected.updated_at)}
                </div>
              </>
            ) : (
              <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-muted-foreground">
                从左侧选择一条 Task Summary Tip 查看详情。
              </div>
            )}
          </Card.Body>
        </Card>
      </div>
    </ResourcePage>
  );
}
