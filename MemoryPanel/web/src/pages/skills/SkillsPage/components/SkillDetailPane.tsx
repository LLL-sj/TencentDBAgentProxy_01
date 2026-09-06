/**
 * SkillDetailPane — right column of SkillsPanel. Shows one skill's
 * frontmatter, body markdown, and a clickable file tree. Clicking a
 * leaf opens an inline modal with the file's content.
 *
 * Re-fetches when `skillName` changes. Empty state when skillName=null.
 *
 * 样式对齐腾讯云控制台规范：外壳用 Tea Card，文字/颜色走 tea token
 * （见 skill-detail.css），不使用 tailwind 语义色与原生标签内联 style。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Input, Modal, Text } from 'tea-component';
import { MarkdownView } from '@/components/MarkdownView';
import { getSkill, readSkillFile, removeSkillFiles, writeSkillFiles, type SkillDetail, type ReadFileResult } from '@/lib/skill-api';
import { getCurrentUser } from '@/lib/api/base';
import { skillApi } from '@/lib/teamApi';
import './skill-detail.css';

interface FileTreeNode {
  name: string;
  fullPath: string | null; // null for directories
  children: FileTreeNode[];
}

/**
 * Build a tree from an array of "scripts/foo.sh" / "templates/x/y.txt" paths.
 * Sorts directories before files at each level for stable layout.
 */
function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', fullPath: null, children: [] };
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const segName = parts[i];
      let child = cursor.children.find((c) => c.name === segName);
      if (!child) {
        child = {
          name: segName,
          fullPath: isLeaf ? p : null,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  // Sort: dirs first, then files; alphabetical within each group.
  const sortRec = (node: FileTreeNode): void => {
    node.children.sort((a, b) => {
      const aDir = a.fullPath === null;
      const bDir = b.fullPath === null;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function FileTreeView(props: {
  nodes: FileTreeNode[];
  onPick: (path: string) => void;
}) {
  // 缩进靠嵌套 ul 的固定 padding（见 css），不在 li 上写动态内联 style。
  return (
    <ul className="_memory-skill-filetree">
      {props.nodes.map((n) => (
        <li key={n.name}>
          {n.fullPath ? (
            <button
              type="button"
              onClick={() => props.onPick(n.fullPath!)}
              className="_memory-skill-file-btn"
            >
              {n.name}
            </button>
          ) : (
            <>
              <div className="_memory-skill-dir">{n.name}/</div>
              <FileTreeView nodes={n.children} onPick={props.onPick} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function SkillDetailPane(props: { skillName: string | null; skillId?: string; onChanged?: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<ReadFileResult | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [fileEditContent, setFileEditContent] = useState('');

  const skillId = props.skillId ?? '';

  useEffect(() => {
    if (!skillId) {
      setView(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setView(null);
    getSkill({ skill_id: skillId, include_content: true, include_manifest: true })
      .then((v) => setView(v))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [skillId]);

  // view 的清空发生在 useEffect（paint 之后）里，切换 skill 的那一次渲染中，view
  // 仍可能停留在上一个 skill。渲染期先按 skill_id 校验归属：不属于当前 skillId 就
  // 视为「尚未加载」，避免切换时闪一帧上一个 skill 的正文 / 描述。
  const stale = !!view && view.skill_id !== skillId;
  const currentView = stale ? null : view;
  // stale 期间（旧 view 尚未被 effect 清空）也当作加载中，切换瞬间直接显示「加载中」，
  // 既不闪旧内容也不出现空白帧。
  const showLoading = !!skillId && (loading || stale);

  const fileTree = useMemo(() => buildFileTree(currentView?.manifest?.map((e) => e.path) ?? []), [currentView]);

  async function pickFile(path: string): Promise<void> {
    if (!skillId) return;
    setFilePreviewLoading(true);
    try {
      const f = await readSkillFile({ skill_id: skillId, path, encoding: 'utf-8' });
      setFilePreview(f);
      setFileEditContent(f.content);
    } catch (err) {
      setFilePreview({
        path,
        content: t('skills.detail.readFailed', { msg: err instanceof Error ? err.message : String(err) }),
        encoding: 'utf-8',
        size_bytes: 0,
        mime_type: 'text/plain',
        version: 0,
      });
      setFileEditContent('');
    } finally {
      setFilePreviewLoading(false);
    }
  }

  async function saveMain(): Promise<void> {
    if (!currentView || !skillId) return;
    setSaving(true);
    try {
      const updated = await skillApi.update(
        currentView.team_id,
        currentView.owner_agent_id,
        skillId,
        currentView.version,
        editContent,
      );
      setView({ ...currentView, ...updated, content: editContent });
      setShowEdit(false);
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!currentView || !skillId) return;
    const ok = window.confirm(t('skills.detail.confirmDelete') ?? `Delete skill ${currentView.name}?`);
    if (!ok) return;
    setSaving(true);
    try {
      await skillApi.delete(currentView.team_id, currentView.owner_agent_id, skillId, currentView.version);
      setView(null);
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveFile(): Promise<void> {
    if (!currentView || !filePreview || !skillId) return;
    setSaving(true);
    try {
      const me = await getCurrentUser();
      const updated = await writeSkillFiles({
        user_id: me.user_id,
        team_id: currentView.team_id,
        agent_id: currentView.owner_agent_id,
        skill_id: skillId,
        expected_version: currentView.version,
        files: [{ path: filePreview.path, content: fileEditContent, encoding: 'utf-8' }],
      });
      setFilePreview({ ...filePreview, content: fileEditContent, size_bytes: fileEditContent.length });
      setView({ ...currentView, ...updated });
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrentFile(): Promise<void> {
    if (!currentView || !filePreview || !skillId) return;
    const ok = window.confirm(t('skills.detail.confirmFileRemove') ?? `Remove file ${filePreview.path}?`);
    if (!ok) return;
    setSaving(true);
    try {
      const me = await getCurrentUser();
      const updated = await removeSkillFiles({
        user_id: me.user_id,
        team_id: currentView.team_id,
        agent_id: currentView.owner_agent_id,
        skill_id: skillId,
        expected_version: currentView.version,
        paths: [filePreview.path],
      });
      setFilePreview(null);
      setView({ ...currentView, ...updated });
      props.onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!props.skillName) {
    return (
      <Card className="_memory-skill-detail-card">
        <Card.Body className="_memory-skill-detail-empty">
          <Text theme="weak">{t('skills.detail.empty')}</Text>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="_memory-skill-detail-card">
      <Card.Body className="_memory-skill-detail-body">
        <div className="_memory-skill-detail-head">
          <div>
            <div className="_memory-skill-detail-name">{props.skillName}</div>
            {currentView?.description && (
              <Text theme="weak" parent="div" className="_memory-skill-detail-desc">{currentView.description}</Text>
            )}
          </div>
          {currentView && (
            <div className="_memory-skill-detail-actions">
              <Button
                onClick={() => {
                  setEditContent(currentView.content);
                  setShowEdit(true);
                }}
              >
                {t('common.edit')}
              </Button>
              <Button
                type="error"
                loading={saving}
                onClick={() => void handleDelete()}
              >
                {t('common.delete')}
              </Button>
            </div>
          )}
        </div>

        {!stale && error && (
          <Text theme="danger" parent="div" className="_memory-skill-detail-error">{error}</Text>
        )}
        {showLoading && <Text theme="weak" parent="div">{t('skills.detail.loading')}</Text>}
        {currentView && (
          <>
            {/* Metadata */}
            <div className="_memory-skill-detail-section">
              <Text theme="label" parent="div" className="_memory-skill-detail-section-title">Frontmatter</Text>
              <pre className="_memory-skill-detail-json">
                {JSON.stringify(
                  {
                    name: currentView.name,
                    description: currentView.description,
                    version: currentView.version,
                    owner_user_id: currentView.owner_user_id,
                    owner_agent_id: currentView.owner_agent_id,
                    created_at_ms: currentView.created_at_ms,
                    updated_at_ms: currentView.updated_at_ms,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>

            {/* Body（从 content 中提取 Markdown 正文） */}
            <div className="_memory-skill-detail-section">
              <Text theme="label" parent="div" className="_memory-skill-detail-section-title">Body</Text>
              <MarkdownView>{extractBody(currentView.content)}</MarkdownView>
            </div>

            {/* Files */}
            <div className="_memory-skill-detail-section">
              <Text theme="label" parent="div" className="_memory-skill-detail-section-title">
                {t('skills.detail.files', { count: currentView.manifest?.length ?? 0 })}
              </Text>
              {!currentView.manifest || currentView.manifest.length === 0 ? (
                <Text theme="weak" parent="div">{t('skills.detail.noFiles')}</Text>
              ) : (
                <div className="_memory-skill-files-box">
                  <FileTreeView nodes={fileTree} onPick={pickFile} />
                </div>
              )}
            </div>
          </>
        )}
      </Card.Body>

      {/* Edit SKILL.md modal */}
      {showEdit && currentView && (
        <Modal
          visible
          caption={`${t('common.edit')}: SKILL.md`}
          size="xl"
          onClose={() => setShowEdit(false)}
        >
          <Modal.Body>
            <Input.TextArea
              size="full"
              className="_memory-skill-edit-textarea"
              value={editContent}
              onChange={setEditContent}
              rows={18}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" loading={saving} onClick={() => void saveMain()}>{t('common.save')}</Button>
            <Button onClick={() => setShowEdit(false)}>{t('common.cancel')}</Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Inline file-preview modal */}
      {filePreview && (
        <Modal visible caption={filePreview.path} size="xl" onClose={() => setFilePreview(null)}>
          <Modal.Body>
            {filePreviewLoading ? (
              <Text theme="weak" parent="div">{t('skills.detail.loading')}</Text>
            ) : filePreview.encoding === 'base64' ? (
              <Text theme="weak" parent="div">
                {t('skills.detail.binaryFile', { size: filePreview.size_bytes })}
              </Text>
            ) : (
              <>
                <Input.TextArea
                  size="full"
                  className="_memory-skill-file-edit"
                  value={fileEditContent}
                  onChange={setFileEditContent}
                  rows={18}
                />
                <div className="_memory-skill-file-actions">
                  <Button type="primary" loading={saving} onClick={() => void saveFile()}>
                    {t('common.save')}
                  </Button>
                  <Button type="error" loading={saving} onClick={() => void removeCurrentFile()}>
                    {t('common.delete')}
                  </Button>
                </div>
              </>
            )}
          </Modal.Body>
        </Modal>
      )}
    </Card>
  );
}

/** 从 SKILL.md 中提取正文（去掉 YAML frontmatter） */
function extractBody(content: string): string {
  const m = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}
