import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Justify, Segment } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import ChatMemoryPanel from '@/pages/memory/ChatMemoryPage/components/ChatMemoryPanel';
import { CodeMemoryPanel } from './components/CodeMemoryPanel';
import { type MemoryMode } from './components/types';
import './memory-page.css';

const MODE_STORAGE_KEY = 'tdai.memory-panel.mode';

function initialMode(): MemoryMode {
  try {
    const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
    return saved === 'code' ? 'code' : 'chat';
  } catch {
    return 'chat';
  }
}

/**
 * 统一 Memory 页。
 *
 * 顶部 chat | code 模式切换：
 *   - chat 继续使用既有 ChatMemoryPanel（L0/L1/L2/L3）。
 *   - code 使用 CodeMemoryPanel（L0/L0.5/L1/L2/L3）。
 */
export function MemoryPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<MemoryMode>(initialMode);

  const changeMode = useCallback((value: string) => {
    const next = value === 'code' ? 'code' : 'chat';
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, []);

  return (
    <ResourcePage>
      <div className="_memory-page">
        <Card className="_memory-mode-switch">
          <Card.Body>
            <Justify
              left={
                <div>
                  <div className="_memory-mode-title">{t('memory.title')}</div>
                  <div className="_memory-mode-desc">{t('memory.mode.desc')}</div>
                </div>
              }
              right={
                <Segment
                  value={mode}
                  onChange={changeMode}
                  options={[
                    { value: 'chat', text: t('memory.mode.chat') },
                    { value: 'code', text: t('memory.mode.code') },
                  ]}
                />
              }
            />
          </Card.Body>
        </Card>

        {mode === 'chat' ? <ChatMemoryPanel /> : <CodeMemoryPanel />}
      </div>
    </ResourcePage>
  );
}
