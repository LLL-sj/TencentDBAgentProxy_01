/**
 * CodeMemoryPanel — code 记忆视图。
 *
 * 与 ChatMemoryPanel 使用同一套记忆块选择逻辑（团队资产 / Agent 资产 /
 * 我的资产分配），不新增 Agent 选择器。选中块后右侧按 code 记忆分层展示：
 *
 *   L0   原始对话          → /api/v1/chat-memory/layer
 *   L0.5 summary_tips      → /api/v1/tips/list|get
 *   L1   结构化原子记忆    → /api/v1/chat-memory/layer
 *   L2   project/topics/*  → /api/v1/project/list|read
 *   L3   project/MEMORY.md → /api/v1/project/list
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select } from 'tea-component';
import { AppIcon, UsergroupIcon, UserIcon } from 'tea-icons-react';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock } from '@/lib/teamApi';
import type { MemoryBlock, ScopeTab } from '@/pages/memory/ChatMemoryPage/components/types';
import { useScopeTabLabels } from '@/pages/memory/ChatMemoryPage/components/constants';
import { PersonalAssetsTable } from '@/pages/memory/ChatMemoryPage/components/PersonalAssetsTable';
import { AllocateMemoryDialog } from '@/pages/memory/ChatMemoryPage/components/AllocateMemoryDialog';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import { AssetSplitLayout } from '@/pages/ResourcePage/components/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemBadges,
  AssetBadge,
  AssetBadgeYou,
  AssetItemMeta,
  AssetItemTime,
} from '@/pages/ResourcePage/components/AssetListPanel';
import { CodeMemoryDetail } from './CodeMemoryDetail';
import '../../ChatMemoryPage/components/chat-memory-panel.css';
import { type CodeMemoryLayer, resolveBlockAgentId } from './types';

export function CodeMemoryPanel() {
  const { t } = useTranslation();
  const scopeTabLabels = useScopeTabLabels();
  const auth = readAuth();
  const { activeTeamId, activeTeam } = useTeams();
  const currentUserId = auth?.user_id ?? '';
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => teamAgents.filter((a) => a.owner_user_id === currentUserId),
    [teamAgents, currentUserId],
  );

  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<CodeMemoryLayer>('L0');
  const [scopeTab, setScopeTab] = useState<ScopeTab>('team');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [showAllocate, setShowAllocate] = useState(false);

  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !ownedTeamAgents.some((a) => a.agent_id === agentFilter)) {
      setAgentFilter(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentFilter]);

  const fetchSeqRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    if (!activeTeamId) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    if (scopeTab === 'fixed' && !agentFilter) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setBlocksLoading(true);
    setBlocks([]);
    try {
      let res: { items: ChatMemoryBlock[]; total?: number };
      if (scopeTab === 'fixed') {
        res = await chatMemoryApi.agentFixed(agentFilter);
      } else if (scopeTab === 'personal') {
        res = await chatMemoryApi.myAgents(activeTeamId);
      } else {
        res = await chatMemoryApi.teamAssets(activeTeamId);
      }
      if (seq !== fetchSeqRef.current) return;
      setBlocks(
        res.items.map((b) => ({
          id: b.id,
          title: b.title,
          summary: b.summary ?? '',
          tags: [],
          updated_at_ms: b.updated_at_ms,
          agent_id: b.agent_id ?? undefined,
          uploaded_by_user_id: b.uploaded_by_user_id,
          scope: (b as { scope?: 'team' | 'private' }).scope,
          layer_counts: b.layer_counts,
          bound_agent_count: b.bound_agent_count,
          layers: { L0: [], L1: [], L2: [], L3: [] },
          layerCounts: {},
        })),
      );
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(err instanceof Error ? err.message : t('memory.notify.loadFailed'));
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
  }, [activeTeamId, scopeTab, agentFilter, t]);

  const fetchKeyRef = useRef('');
  useEffect(() => {
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // 与 ChatMemoryPanel 保持一致：personal tab 不自动选中，team/fixed 自动选第一块。
  useEffect(() => {
    if (scopeTab === 'personal') {
      if (selectedId && !blocks.some((b) => b.id === selectedId)) setSelectedId(null);
      return;
    }
    if (blocks.length > 0) {
      if (!blocks.some((b) => b.id === selectedId)) setSelectedId(blocks[0].id);
    } else if (selectedId) {
      setSelectedId(null);
    }
  }, [blocks, selectedId, scopeTab]);

  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );

  const selectedAgentId = useMemo(() => {
    if (!selected || !activeTeamId) return undefined;
    return selected.agent_id ?? resolveBlockAgentId(selected.id, activeTeamId);
  }, [activeTeamId, selected]);

  const filtered = useMemo(() => {
    if (scopeTab === 'fixed')
      return agentFilter ? blocks.filter((b) => b.agent_id === agentFilter) : [];
    return blocks;
  }, [blocks, scopeTab, agentFilter]);

  function agentLabel(id?: string): string {
    if (!id) return '';
    const a = teamAgents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  }

  function selfChatMemoryAgentId(b: MemoryBlock): string | undefined {
    if (!activeTeamId) return undefined;
    const prefix = `chat_memory-${activeTeamId}-`;
    if (b.id.startsWith(prefix)) return b.id.slice(prefix.length) || undefined;
    return b.agent_id;
  }

  function isSelfChatMemory(b: MemoryBlock): boolean {
    if (!activeTeamId) return false;
    if (scopeTab === 'fixed' && agentFilter) {
      return b.id === `chat_memory-${activeTeamId}-${agentFilter}`;
    }
    const ownerAgentId = selfChatMemoryAgentId(b);
    return !!ownerAgentId && b.id === `chat_memory-${activeTeamId}-${ownerAgentId}`;
  }

  function allocatableAgents(b: MemoryBlock) {
    const ownerAgentId = selfChatMemoryAgentId(b);
    return ownedTeamAgents
      .filter((a) => a.agent_id !== ownerAgentId)
      .map((a) => ({ agent_id: a.agent_id, name: a.name }));
  }

  async function handleDeleteBlock(id: string) {
    const ok = await tea.confirm({
      message: t('memory.confirm.unbind'),
      description: t('memory.confirm.unbind.desc'),
      okText: t('memory.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      const block = blocks.find((b) => b.id === id);
      if (!activeTeamId || !block?.agent_id) return;
      await chatMemoryApi.unbind(activeTeamId, id, block.agent_id);
      setBlocks((prev) => prev.filter((b) => b.id !== id));
      if (selectedId === id) setSelectedId(null);
      tea.notify.success(t('memory.notify.unbound'));
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : t('memory.notify.unbindFailed'));
    }
  }

  async function handleTogglePersonalScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: t('memory.confirm.private'),
        description: t('memory.confirm.private.desc'),
        okText: t('memory.confirm.private.ok'),
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'));
      void fetchBlocks();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : t('memory.notify.scopeFailed'));
    }
  }

  return (
    <div className="_asset-memory-page">
      <AssetPageHeader
        title={t('memory.code.title')}
        subtitle={
          activeTeam
            ? t('memory.subtitle.team', { name: activeTeam.name, count: blocks.length })
            : t('memory.subtitle.global', { count: blocks.length })
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(v) => setScopeTab(v as ScopeTab)}
            options={(['team', 'fixed', 'personal'] as ScopeTab[]).map((tab) => ({
              value: tab,
              text: scopeTabLabels[tab],
            }))}
          />
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={ownedTeamAgents.length === 0}
              placeholder={t('memory.noAgent')}
              options={ownedTeamAgents.map((agent) => ({
                value: agent.agent_id,
                text: `${agent.name}（${agent.agent_id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          (() => {
            const isPrivateAndNotOwner =
              !!selected &&
              selected.scope === 'private' &&
              selected.uploaded_by_user_id !== currentUserId;
            const disabled = !selected || isPrivateAndNotOwner;
            const tooltip = !selected
              ? t('memory.allocate.disabled')
              : isPrivateAndNotOwner
                ? t('memory.allocate.privateDisabled')
                : undefined;
            return (
              <Button onClick={() => setShowAllocate(true)} disabled={disabled} tooltip={tooltip}>
                {t('memory.allocateToAgent')}
              </Button>
            );
          })()
        }
      />

      {scopeTab === 'personal' ? (
        <PersonalAssetsTable
          blocks={blocks}
          loading={blocksLoading}
          onToggleScope={handleTogglePersonalScope}
          selectedId={selectedId}
          onSelect={setSelectedId}
          currentUserId={currentUserId}
        />
      ) : (
      <AssetSplitLayout
        sidebar={
          <AssetListPanel
            title={t('memory.blockList')}
            count={t('memory.blockCount', { filtered: filtered.length, total: blocks.length })}
            loading={blocksLoading}
            items={filtered}
            selectedId={selectedId}
            getItemId={(b) => b.id}
            onSelect={(b) => setSelectedId(b.id)}
            isItemDisabled={(b) =>
              scopeTab === 'fixed' &&
              b.scope === 'private' &&
              b.uploaded_by_user_id !== currentUserId
            }
            emptyText={t('memory.empty.filtered')}
            renderItem={(b) => {
              const isRevoked =
                scopeTab === 'fixed' &&
                b.scope === 'private' &&
                b.uploaded_by_user_id !== currentUserId;
              return (
                <>
                  <AssetItemHeader>
                    <AssetItemName title={b.title}>
                      {b.title}
                      {isRevoked && (
                        <span className="_memory-badge _memory-badge--warning">{t('memory.list.revoked')}</span>
                      )}
                    </AssetItemName>
                  </AssetItemHeader>

                  <AssetItemBadges>
                    {b.agent_id ? (
                      <AssetBadge icon={<AppIcon size={10} />} title={t('memory.list.fixedTo', { id: b.agent_id })}>
                        {agentLabel(b.agent_id)}
                      </AssetBadge>
                    ) : (
                      <AssetBadge icon={<UsergroupIcon size={10} />} title={t('memory.list.teamPool')}>
                        {t('memory.list.teamPoolShort')}
                      </AssetBadge>
                    )}
                    {b.uploaded_by_user_id && (
                      <AssetBadge icon={<UserIcon size={10} />}>
                        @{b.uploaded_by_user_id}
                        {b.uploaded_by_user_id === currentUserId && (
                          <AssetBadgeYou>{t('common.you')}</AssetBadgeYou>
                        )}
                      </AssetBadge>
                    )}
                  </AssetItemBadges>

                  <AssetItemMeta>
                    <AssetItemTime>{new Date(b.updated_at_ms).toLocaleString()}</AssetItemTime>
                  </AssetItemMeta>

                  {scopeTab === 'fixed' && !isSelfChatMemory(b) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteBlock(b.id);
                      }}
                      title={t('memory.unbind.tooltip')}
                      className="_memory-block-item-unbind"
                    >
                      {t('memory.unbind')}
                    </button>
                  )}
                </>
              );
            }}
          />
        }
        detail={
          !selected || !activeTeamId ? (
            <div className="_alp-detail-empty">{t('memory.detail.empty')}</div>
          ) : (
            <CodeMemoryDetail
              key={selected.id}
              block={selected}
              teamId={activeTeamId}
              agentId={selectedAgentId}
              layer={layer}
              onLayerChange={setLayer}
            />
          )
        }
      />
      )}

      {showAllocate && selected && (
        <AllocateMemoryDialog
          memoryTitle={selected.title}
          agents={allocatableAgents(selected)}
          memorySource={scopeTab === 'personal' ? 'personal' : 'team'}
          onClose={() => setShowAllocate(false)}
          onAllocated={async (agentId) => {
            try {
              await chatMemoryApi.allocate(activeTeamId!, selected.id, agentId);
              tea.notify.success(t('memory.notify.allocated'));
              setShowAllocate(false);
              void fetchBlocks();
            } catch (err) {
              tea.notify.error(err instanceof Error ? err.message : t('memory.notify.allocateFailed'));
            }
          }}
        />
      )}
    </div>
  );
}
