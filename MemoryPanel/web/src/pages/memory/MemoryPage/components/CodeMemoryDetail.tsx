import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { Tag } from 'tea-component';
import { chatMemoryApi, type ChatMemoryLayerItem } from '@/lib/teamApi';
import { projectApi, formatProjectError, type ProjectListResult, type ProjectTopicFile } from '@/lib/project-api';
import { tipsApi, formatTipsError, TIP_STATUS_LABELS, type SummaryTipItem, type TipStatus } from '@/lib/tips-api';
import type { MemoryBlock } from '@/pages/memory/ChatMemoryPage/components/types';
import {
  extractRole,
  formatDisplayTime,
  stripAtMention,
} from '@/pages/memory/ChatMemoryPage/components/utils';
import { MarkdownView } from '@/components/MarkdownView';
import { type CodeMemoryLayer, type CodeLayerMeta } from './types';
import './code-memory-detail.css';

const CHAT_LAYER_PAGE_SIZE = 20;

interface ChatLayerData {
  items: ChatMemoryLayerItem[];
  total: number;
}

function tipStatusClass(status: TipStatus): string {
  switch (status) {
    case 'pending':
      return '_code-memory-tip-status--pending';
    case 'consuming':
      return '_code-memory-tip-status--consuming';
    case 'consumed':
      return '_code-memory-tip-status--consumed';
    case 'duplicate':
      return '_code-memory-tip-status--duplicate';
    case 'expired':
      return '_code-memory-tip-status--expired';
  }
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}

function refsText(tip: SummaryTipItem): string {
  if (tip.l0_refs.length > 0) return tip.l0_refs.join(', ');
  if (tip.l0_start_ref || tip.l0_end_ref) return `${tip.l0_start_ref || '?'} .. ${tip.l0_end_ref || '?'}`;
  return '—';
}

export function CodeMemoryDetail({
  block,
  teamId,
  agentId,
  layer,
  onLayerChange,
}: {
  block: MemoryBlock;
  teamId: string;
  agentId?: string;
  layer: CodeMemoryLayer;
  onLayerChange: (layer: CodeMemoryLayer) => void;
}) {
  const { t } = useTranslation();

  const layers = useMemo<CodeLayerMeta[]>(() => [
    { id: 'L0', label: t('memory.layer.L0.label'), short: t('memory.layer.L0.short'), desc: t('memory.layer.L0.desc'), tone: 'default' },
    { id: 'L0.5', label: t('memory.code.layer.L0_5.label'), short: t('memory.code.layer.L0_5.short'), desc: t('memory.code.layer.L0_5.desc'), tone: 'success' },
    { id: 'L1', label: t('memory.layer.L1.label'), short: t('memory.layer.L1.short'), desc: t('memory.code.layer.L1.desc'), tone: 'brand' },
    { id: 'L2', label: t('memory.code.layer.L2.label'), short: t('memory.code.layer.L2.short'), desc: t('memory.code.layer.L2.desc'), tone: 'success' },
    { id: 'L3', label: t('memory.code.layer.L3.label'), short: t('memory.code.layer.L3.short'), desc: t('memory.code.layer.L3.desc'), tone: 'warning' },
  ], [t]);

  // ── 五层条数（与 chat BlockDetail 的层徽章一致，选中块即拉取）────────
  const [layerCounts, setLayerCounts] = useState<Partial<Record<CodeMemoryLayer, number>>>({});

  useEffect(() => {
    let cancelled = false;
    setLayerCounts({});
    const next: Partial<Record<CodeMemoryLayer, number>> = {};

    const l0 = chatMemoryApi.layer(block.id, 'L0', 1, 0)
      .then((res) => { next.L0 = res.total; })
      .catch(() => { /* 单层计数失败不影响其他层 */ });
    const l1 = chatMemoryApi.layer(block.id, 'L1', 1, 0, undefined, undefined, 'code')
      .then((res) => { next.L1 = res.total; })
      .catch(() => { /* ignore */ });

    const scoped = agentId
      ? Promise.all([
          tipsApi.list(teamId, { agent_id: agentId, limit: 1, offset: 0 })
            .then((res) => { next['L0.5'] = res.total; })
            .catch(() => { /* ignore */ }),
          projectApi.list({ teamId, blockId: block.id })
            .then((res) => {
              next.L2 = res.items.length;
              next.L3 = res.index.trim() ? 1 : 0;
            })
            .catch(() => { /* ignore */ }),
        ])
      : Promise.resolve();

    void Promise.all([l0, l1, scoped]).finally(() => {
      if (!cancelled) setLayerCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [block.id, teamId, agentId]);

  // ── L0 / L1（复用 chat-memory/layer）─────────────────────────
  const [chatPage, setChatPage] = useState(0);
  const [chatData, setChatData] = useState<ChatLayerData>({ items: [], total: 0 });
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');

  useEffect(() => {
    if (layer !== 'L0' && layer !== 'L1') return;
    setChatPage(0);
    setChatData({ items: [], total: 0 });
    setChatError('');
  }, [block.id, layer]);

  useEffect(() => {
    if (layer !== 'L0' && layer !== 'L1') return;
    let cancelled = false;
    setChatLoading(true);
    setChatError('');
    chatMemoryApi
      .layer(block.id, layer, CHAT_LAYER_PAGE_SIZE, chatPage * CHAT_LAYER_PAGE_SIZE, undefined, undefined, layer === 'L1' ? 'code' : undefined)
      .then((res) => {
        if (cancelled) return;
        setChatData({ items: res.items, total: res.total });
      })
      .catch((err) => {
        if (!cancelled) setChatError(err instanceof Error ? err.message : t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [block.id, layer, chatPage, t]);

  // ── L0.5（复用 tips/list + tips/get）─────────────────────────
  const [tips, setTips] = useState<SummaryTipItem[]>([]);
  const [selectedTip, setSelectedTip] = useState<SummaryTipItem | null>(null);
  const [tipsLoading, setTipsLoading] = useState(false);
  const [tipsError, setTipsError] = useState('');

  useEffect(() => {
    if (layer !== 'L0.5') return;
    let cancelled = false;
    setTips([]);
    setSelectedTip(null);
    setTipsError('');
    if (!agentId) return;
    setTipsLoading(true);
    tipsApi
      .list(teamId, { agent_id: agentId, limit: 200, offset: 0 })
      .then((res) => {
        if (cancelled) return;
        setTips(res.items);
      })
      .catch((err) => {
        if (!cancelled) setTipsError(formatTipsError(err));
      })
      .finally(() => {
        if (!cancelled) setTipsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [block.id, teamId, agentId, layer]);

  const openTip = useCallback(async (tipId: string) => {
    try {
      const detail = await tipsApi.get(teamId, tipId);
      setSelectedTip(detail);
    } catch (err) {
      setTipsError(formatTipsError(err));
    }
  }, [teamId]);

  // ── L2 / L3（project/list + project/read）────────────────────
  const [project, setProject] = useState<ProjectListResult | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<ProjectTopicFile | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [topicLoadingId, setTopicLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (layer !== 'L2' && layer !== 'L3') return;
    let cancelled = false;
    setProject(null);
    setSelectedTopic(null);
    setProjectError('');
    if (!agentId) return;
    setProjectLoading(true);
    projectApi
      .list({ teamId, blockId: block.id })
      .then((res) => {
        if (cancelled) return;
        setProject(res);
      })
      .catch((err) => {
        if (!cancelled) setProjectError(formatProjectError(err));
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [block.id, teamId, agentId, layer]);

  const openTopic = useCallback(async (topicPath: string) => {
    setTopicLoadingId(topicPath);
    try {
      const detail = await projectApi.read({ teamId, blockId: block.id }, topicPath);
      setSelectedTopic(detail);
    } catch (err) {
      setProjectError(formatProjectError(err));
    } finally {
      setTopicLoadingId(null);
    }
  }, [block.id, teamId]);

  const chatPageCount = Math.max(1, Math.ceil(chatData.total / CHAT_LAYER_PAGE_SIZE));
  const safeChatPage = Math.min(chatPage, chatPageCount - 1);

  return (
    <div className="_code-memory-detail">
      <div className="_memory-detail-header">
        <div className="_memory-detail-title">{block.title}</div>
        <div className="_memory-detail-meta">
          <span className="_memory-detail-mono">{block.id}</span>
          {agentId ? (
            <span className="_memory-detail-meta-item">Agent <span className="_memory-detail-mono">{agentId}</span></span>
          ) : (
            <span className="_memory-detail-meta-item">{t('memory.code.scopeUnavailable')}</span>
          )}
        </div>
      </div>

      <div className="_code-memory-detail-layers">
        {layers.map((l) => {
          const active = l.id === layer;
          const known = layerCounts[l.id] !== undefined;
          const count = known ? layerCounts[l.id] : undefined;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onLayerChange(l.id)}
              className={`_memory-detail-layer-btn${active ? ' _memory-detail-layer-btn--active' : ''}`}
            >
              <div className="_memory-detail-layer-btn-top">
                <span className="_memory-detail-layer-label">{l.label}</span>
                <span className="_memory-detail-layer-count" title={known ? undefined : t('memory.detail.clickToLoad')}>
                  {known ? count : '·'}
                </span>
              </div>
              <div className="_memory-detail-layer-desc">{l.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="_memory-detail-body">
        {layer === 'L0' || layer === 'L1' ? (
          <ChatLayerView
            layer={layer}
            data={chatData}
            loading={chatLoading}
            error={chatError}
            page={safeChatPage}
            pageCount={chatPageCount}
            onPageChange={setChatPage}
          />
        ) : null}

        {layer === 'L0.5' ? (
          <TipsLayerView
            agentId={agentId}
            items={tips}
            selected={selectedTip}
            loading={tipsLoading}
            error={tipsError}
            onOpenTip={openTip}
          />
        ) : null}

        {layer === 'L2' ? (
          <ProjectTopicsView
            agentId={agentId}
            project={project}
            selectedTopic={selectedTopic}
            loading={projectLoading}
            error={projectError}
            topicLoadingId={topicLoadingId}
            onOpenTopic={openTopic}
          />
        ) : null}

        {layer === 'L3' ? (
          <ProjectIndexView
            agentId={agentId}
            project={project}
            loading={projectLoading}
            error={projectError}
          />
        ) : null}
      </div>
    </div>
  );
}

function ScopeRequired({ agentId }: { agentId?: string }) {
  const { t } = useTranslation();
  if (agentId) return null;
  return <div className="_memory-detail-empty">{t('memory.code.scopeRequired')}</div>;
}

function LayerLoading() {
  const { t } = useTranslation();
  return <div className="_memory-detail-empty">{t('memory.detail.loading')}</div>;
}

function LayerError({ message }: { message: string }) {
  return <div className="_memory-detail-empty _code-memory-error">{message}</div>;
}

function ChatLayerView({
  layer,
  data,
  loading,
  error,
  page,
  pageCount,
  onPageChange,
}: {
  layer: 'L0' | 'L1';
  data: ChatLayerData;
  loading: boolean;
  error: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <LayerLoading />;
  if (error) return <LayerError message={error} />;
  if (data.items.length === 0) {
    return <div className="_memory-detail-empty">{t('memory.detail.emptyLayer', { layer })}</div>;
  }

  if (layer === 'L0') {
    return (
      <div className="_code-memory-l0-list">
        {[...data.items].reverse().map((msg, idx) => {
          const role = extractRole(msg.role || msg.title || '');
          const cleanBody = stripAtMention(msg.body);
          const roleTone = role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant';
          const time = formatDisplayTime(msg.created_at);
          return (
            <div key={msg.id || idx} className={`_memory-detail-l0-row _memory-detail-l0-row--${roleTone}`}>
              <div className="_memory-detail-l0-bubble">
                <div className="_memory-detail-l0-bubble-head">
                  <span className={`_memory-detail-l0-role _memory-detail-l0-role--${roleTone}`}>{role.toUpperCase()}</span>
                  {time && <span className="_memory-detail-l0-time" title={msg.created_at}>{time}</span>}
                </div>
                <pre className="_memory-detail-l0-body">{cleanBody}</pre>
              </div>
            </div>
          );
        })}
        <LayerPager page={page} pageCount={pageCount} onPageChange={onPageChange} />
      </div>
    );
  }

  return (
    <>
      <ul className="_memory-detail-atomic-list">
        {data.items.map((item) => (
          <li key={item.id} className="_memory-detail-atomic-item">
            <div className="_memory-detail-atomic-head">
              <span className="_memory-detail-atomic-layer _memory-detail-atomic-layer--brand">L1</span>
              <span className="_memory-detail-atomic-title" title={item.title}>{item.title}</span>
              <span className="_memory-detail-atomic-head-right">
                {formatDisplayTime(item.created_at) && (
                  <span className="_memory-detail-atomic-time" title={item.created_at}>{formatDisplayTime(item.created_at)}</span>
                )}
              </span>
            </div>
            <pre className="_memory-detail-atomic-body">{item.body}</pre>
            {item.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {item.tags.map((tag) => <span key={tag} className="_memory-detail-atomic-tag">#{tag}</span>)}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <LayerPager page={page} pageCount={pageCount} onPageChange={onPageChange} />
    </>
  );
}

function LayerPager({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (pageCount <= 1) return null;
  return (
    <div className="_memory-detail-pager">
      <span>{t('memory.detail.pageInfo', { page: page + 1, total: pageCount, current: 0, total2: pageCount })}</span>
      <div className="_memory-detail-pager-btns">
        <button type="button" className="_memory-detail-pager-btn" disabled={page <= 0} onClick={() => onPageChange(page - 1)}>
          {t('memory.detail.prevPage')}
        </button>
        <button type="button" className="_memory-detail-pager-btn" disabled={page >= pageCount - 1} onClick={() => onPageChange(page + 1)}>
          {t('memory.detail.nextPage')}
        </button>
      </div>
    </div>
  );
}

function TipsLayerView({
  agentId,
  items,
  selected,
  loading,
  error,
  onOpenTip,
}: {
  agentId?: string;
  items: SummaryTipItem[];
  selected: SummaryTipItem | null;
  loading: boolean;
  error: string;
  onOpenTip: (tipId: string) => void;
}) {
  const { t } = useTranslation();
  if (!agentId) return <ScopeRequired agentId={agentId} />;
  if (loading) return <LayerLoading />;
  if (error) return <LayerError message={error} />;
  if (items.length === 0) return <div className="_memory-detail-empty">{t('memory.code.tipsEmpty')}</div>;

  return (
    <div className="_code-memory-tips-layout">
      <div className="_code-memory-tips-list">
        {items.map((tip) => (
          <button
            key={tip.tip_id}
            type="button"
            className={`_code-memory-tip-item${selected?.tip_id === tip.tip_id ? ' _code-memory-tip-item--selected' : ''}`}
            onClick={() => void onOpenTip(tip.tip_id)}
          >
            <div className="_code-memory-tip-item-head">
              <span className="_code-memory-tip-id">{tip.tip_id}</span>
              <span className={`_code-memory-tip-status ${tipStatusClass(tip.status)}`}>
                {TIP_STATUS_LABELS[tip.status] ?? tip.status}
              </span>
            </div>
            <p className="_code-memory-tip-summary">{tip.summary}</p>
            <div className="_code-memory-tip-meta">
              {tip.session_id} · {formatTime(tip.created_at)}
            </div>
          </button>
        ))}
      </div>

      <div className="_code-memory-tip-detail">
        {selected ? (
          <>
            <div className="_code-memory-detail-subhead">
              <div className="_code-memory-detail-subtitle">{selected.tip_id}</div>
              <span className={`_code-memory-tip-status ${tipStatusClass(selected.status)}`}>
                {TIP_STATUS_LABELS[selected.status] ?? selected.status}
              </span>
            </div>
            <div className="_code-memory-tip-fields">
              <div><span>Agent</span><b>{selected.agent_id}</b></div>
              <div><span>Session</span><b>{selected.session_id}</b></div>
              <div><span>L0 锚点</span><b>{refsText(selected)}</b></div>
              <div><span>更新时间</span><b>{formatTime(selected.updated_at)}</b></div>
            </div>
            <div className="_code-memory-tip-tags">
              {selected.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
            </div>
            <div className="_code-memory-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.summary}</ReactMarkdown>
            </div>
            {selected.steps.length > 0 ? (
              <div className="_code-memory-section">
                <div className="_code-memory-section-title">Steps</div>
                <ol className="_code-memory-steps">
                  {selected.steps.map((step, idx) => <li key={`${step}-${idx}`}>{step}</li>)}
                </ol>
              </div>
            ) : null}
            {selected.artifacts.length > 0 ? (
              <div className="_code-memory-section">
                <div className="_code-memory-section-title">Artifacts</div>
                <ul className="_code-memory-artifacts">
                  {selected.artifacts.map((artifact, idx) => <li key={`${artifact}-${idx}`}>{artifact}</li>)}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <div className="_memory-detail-empty">{t('memory.code.tipSelect')}</div>
        )}
      </div>
    </div>
  );
}

function formatTopicUpdated(updated?: string): string {
  if (!updated) return '';
  const date = new Date(updated);
  if (Number.isNaN(date.getTime())) return updated;
  return date.toLocaleString();
}

function ProjectTopicsView({
  agentId,
  project,
  selectedTopic,
  loading,
  error,
  topicLoadingId,
  onOpenTopic,
}: {
  agentId?: string;
  project: ProjectListResult | null;
  selectedTopic: ProjectTopicFile | null;
  loading: boolean;
  error: string;
  topicLoadingId: string | null;
  onOpenTopic: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (!agentId) return <ScopeRequired agentId={agentId} />;
  if (loading) return <LayerLoading />;
  if (error) return <LayerError message={error} />;
  const topics = project?.items ?? [];
  if (topics.length === 0) return <div className="_memory-detail-empty">{t('memory.code.topicsEmpty')}</div>;

  return (
    <div className="_code-memory-project-layout">
      <div className="_code-memory-project-list">
        {topics.map((topic) => (
          <button
            key={topic.path}
            type="button"
            className={`_code-memory-project-item${selectedTopic?.path === topic.path ? ' _code-memory-project-item--selected' : ''}`}
            disabled={topicLoadingId === topic.path}
            onClick={() => void onOpenTopic(topic.path)}
          >
            <div className="_code-memory-project-item-title">{topic.title}</div>
            <div className="_code-memory-project-item-path">{topic.path}</div>
            <div className="_code-memory-project-item-meta">
              <span className="_code-memory-project-type">{topic.type}</span>
              {topic.tags.slice(0, 4).map((tag) => <span key={tag} className="_code-memory-project-tag">#{tag}</span>)}
              {topic.updated ? <span className="_code-memory-project-updated">{formatTopicUpdated(topic.updated)}</span> : null}
            </div>
          </button>
        ))}
      </div>

      <div className="_code-memory-project-detail">
        {selectedTopic ? (
          <>
            <div className="_code-memory-detail-subhead">
              <div className="_code-memory-detail-subtitle">{selectedTopic.title}</div>
              <span className="_code-memory-project-path">{selectedTopic.path}</span>
              {selectedTopic.updated ? <span className="_code-memory-project-updated">Updated: {formatTopicUpdated(selectedTopic.updated)}</span> : null}
            </div>
            <div className="_code-memory-project-tags">
              <span className="_code-memory-project-type">{selectedTopic.type}</span>
              {selectedTopic.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
            </div>
            {selectedTopic.sources.length > 0 ? (
              <div className="_code-memory-section">
                <div className="_code-memory-section-title">Sources</div>
                <div className="_code-memory-sources">
                  {selectedTopic.sources.map((source) => <span key={source} className="_memory-detail-atomic-ref">{source}</span>)}
                </div>
              </div>
            ) : null}
            <div className="_code-memory-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedTopic.content}</ReactMarkdown>
            </div>
          </>
        ) : (
          <div className="_memory-detail-empty">{t('memory.code.topicSelect')}</div>
        )}
      </div>
    </div>
  );
}

function ProjectIndexView({
  agentId,
  project,
  loading,
  error,
}: {
  agentId?: string;
  project: ProjectListResult | null;
  loading: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  if (!agentId) return <ScopeRequired agentId={agentId} />;
  if (loading) return <LayerLoading />;
  if (error) return <LayerError message={error} />;
  if (!project?.index.trim()) return <div className="_memory-detail-empty">{t('memory.code.indexEmpty')}</div>;
  return (
    <div className="_code-memory-index">
      <div className="_code-memory-index-path">project/MEMORY.md</div>
      <MarkdownView bare className="_code-memory-md">{project.index}</MarkdownView>
    </div>
  );
}
