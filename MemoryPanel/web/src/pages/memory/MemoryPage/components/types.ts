export type MemoryMode = 'chat' | 'code';

export type CodeMemoryLayer = 'L0' | 'L0.5' | 'L1' | 'L2' | 'L3';

export interface CodeLayerMeta {
  id: CodeMemoryLayer;
  label: string;
  short: string;
  desc: string;
  tone: 'default' | 'brand' | 'success' | 'warning';
}

export function resolveBlockAgentId(blockId: string, teamId: string): string | undefined {
  const prefix = `chat_memory-${teamId}-`;
  if (!blockId.startsWith(prefix)) return undefined;
  const suffix = blockId.slice(prefix.length);
  return suffix.startsWith('agt-') ? suffix : undefined;
}
