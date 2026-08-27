import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, Card, Input, Justify, Modal, SearchBox, Segment, Tag } from 'tea-component';
import { useTeams } from '@/services';
import {
  notesApi,
  downloadNote,
  formatNotesError,
  type NoteDetail,
  type NotesGraphData,
  type NoteSummary,
  type NoteTagSummary,
  type NotesGraphNode,
} from '@/lib/notes-api';
import { NotesGraph } from './NotesGraph';
import { ResourcePage } from '@/pages/ResourcePage';

type RightTab = 'content' | 'graph' | 'mermaid';

interface EditorState {
  noteId?: string;
  title: string;
  content: string;
  tagsText: string;
  expectedVersion: number;
}

const EMPTY_EDITOR: EditorState = {
  title: '',
  content: '',
  tagsText: '',
  expectedVersion: 1,
};

function splitTags(text: string): string[] {
  return [...new Set(text.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
}

export function NotesPage() {
  const { activeTeamId } = useTeams();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<NoteTagSummary[]>([]);
  const [selectedNote, setSelectedNote] = useState<NoteDetail | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [rightTab, setRightTab] = useState<RightTab>('content');
  const [graphData, setGraphData] = useState<NotesGraphData | null>(null);
  const [mermaid, setMermaid] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  const fetchSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!activeTeamId) {
      setNotes([]);
      setTags([]);
      setGraphData(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const [list, tagList, graph] = await Promise.all([
        notesApi.list(activeTeamId),
        notesApi.tagsList(activeTeamId),
        notesApi.graph(activeTeamId),
      ]);
      if (seq !== fetchSeqRef.current) return;
      setNotes(list.items);
      setTags(tagList.items);
      setGraphData(graph);
      setMermaid('');
    } catch (err) {
      if (seq === fetchSeqRef.current) {
        console.error('notes refresh failed', err);
        setNotes([]);
        setTags([]);
        setGraphData(null);
      }
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId]);

  useEffect(() => {
    setSelectedNote(null);
    setActiveTag(null);
    setKeyword('');
    void refresh();
  }, [activeTeamId, refresh]);

  const filteredNotes = useMemo(() => {
    let items = notes;
    if (activeTag) items = items.filter((n) => n.tags.some((t) => t.tag_slug === activeTag));
    if (keyword.trim()) {
      const q = keyword.trim().toLowerCase();
      items = items.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.snippet.toLowerCase().includes(q) ||
          n.tags.some((t) => t.tag_label.toLowerCase().includes(q)),
      );
    }
    return items;
  }, [notes, activeTag, keyword]);

  const openNote = async (noteId: string) => {
    if (!activeTeamId) return;
    try {
      const detail = await notesApi.get(activeTeamId, noteId);
      setSelectedNote(detail);
      setRightTab('content');
    } catch (err) {
      console.error(err);
      alert(formatNotesError(err));
    }
  };

  const openEditor = (note?: NoteDetail) => {
    setEditor(
      note
        ? {
            noteId: note.note_id,
            title: note.title,
            content: note.content,
            tagsText: note.tags.map((t) => t.tag_label).join(', '),
            expectedVersion: note.version,
          }
        : EMPTY_EDITOR,
    );
    setEditorOpen(true);
  };

  const saveEditor = async () => {
    if (!activeTeamId) return;
    if (!editor.title.trim() || !editor.content.trim()) {
      alert('标题和内容不能为空');
      return;
    }
    setSaving(true);
    try {
      if (editor.noteId) {
        const updated = await notesApi.update(activeTeamId, editor.noteId, editor.expectedVersion, {
          title: editor.title.trim(),
          content: editor.content,
          tags: splitTags(editor.tagsText),
        });
        setSelectedNote(updated);
      } else {
        const created = await notesApi.create(activeTeamId, {
          title: editor.title.trim(),
          content: editor.content,
          tags: splitTags(editor.tagsText),
        });
        setSelectedNote(created);
      }
      setEditorOpen(false);
      setEditor(EMPTY_EDITOR);
      await refresh();
    } catch (err) {
      alert(formatNotesError(err));
    } finally {
      setSaving(false);
    }
  };

  const archiveSelected = async () => {
    if (!activeTeamId || !selectedNote) return;
    if (!confirm(`确定归档笔记「${selectedNote.title}」？`)) return;
    try {
      await notesApi.archive(activeTeamId, selectedNote.note_id, selectedNote.version);
      setSelectedNote(null);
      await refresh();
    } catch (err) {
      alert(formatNotesError(err));
    }
  };

  const loadMermaid = async () => {
    if (!activeTeamId) return;
    try {
      const data = await notesApi.mermaid(activeTeamId, 'LR');
      setMermaid(data.mermaid);
      setRightTab('mermaid');
    } catch (err) {
      alert(formatNotesError(err));
    }
  };

  const onGraphNode = (node: NotesGraphNode) => {
    if (node.type === 'tag') {
      setActiveTag(node.label.replace(/^tag:/, '').replace(/^.*?:(.*)$/, '$1'));
    } else {
      const noteId = node.id.startsWith('note:') ? node.id.slice('note:'.length) : node.id;
      void openNote(noteId);
    }
  };

  return (
    <ResourcePage>
      <div className="flex h-full gap-4">
        <Card className="w-[380px] shrink-0">
          <Card.Body>
            <Justify
              left={<h3 className="text-base font-semibold">Team Notes</h3>}
              right={<Button type="primary" onClick={() => openEditor()}>新建</Button>}
            />
            <div className="mt-3 space-y-3">
              <SearchBox value={keyword} onChange={(v) => setKeyword(v)} placeholder="搜索标题/正文/标签" />
              <div className="flex flex-wrap gap-1">
                <span
                  onClick={() => setActiveTag(null)}
                  className={`cursor-pointer rounded px-2 py-0.5 text-xs ${activeTag ? 'bg-muted text-muted-foreground' : 'bg-primary text-white'}`}
                >
                  全部
                </span>
                {tags.map((tag) => (
                  <span
                    key={tag.tag_slug}
                    onClick={() => setActiveTag(activeTag === tag.tag_slug ? null : tag.tag_slug)}
                    className={`cursor-pointer rounded px-2 py-0.5 text-xs ${activeTag === tag.tag_slug ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}
                  >
                    {tag.tag_label} ({tag.note_count})
                  </span>
                ))}
              </div>
              <div className="space-y-2 overflow-auto" style={{ maxHeight: 560 }}>
                {loading ? <div className="text-sm text-muted-foreground">加载中...</div> : null}
                {filteredNotes.map((note) => (
                  <div
                    key={note.note_id}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors ${selectedNote?.note_id === note.note_id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                    onClick={() => void openNote(note.note_id)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">#{note.seq_no} {note.title}</span>
                      <span className="text-xs text-muted-foreground">v{note.version}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{note.snippet}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {note.tags.map((tag) => (
                        <span key={tag.tag_slug} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag.tag_label}</span>
                      ))}
                    </div>
                  </div>
                ))}
                {!loading && filteredNotes.length === 0 ? <div className="text-sm text-muted-foreground">暂无笔记</div> : null}
              </div>
            </div>
          </Card.Body>
        </Card>

        <Card className="min-w-0 flex-1">
          <Card.Body>
            {selectedNote ? (
              <>
                <Justify
                  left={
                    <div>
                      <div className="text-base font-semibold">#{selectedNote.seq_no} {selectedNote.title}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {selectedNote.tags.map((tag) => <Tag key={tag.tag_slug}>{tag.tag_label}</Tag>)}
                      </div>
                    </div>
                  }
                  right={
                    <div className="space-x-2">
                      <Button onClick={() => openEditor(selectedNote)}>编辑</Button>
                      <Button onClick={() => downloadNote(selectedNote)}>导出</Button>
                      <Button type="weak" onClick={() => void archiveSelected()}>归档</Button>
                    </div>
                  }
                />
                <div className="mt-3">
                  <Segment
                    value={rightTab}
                    onChange={(v) => setRightTab(v as RightTab)}
                    options={[
                      { value: 'content', text: '正文' },
                      { value: 'graph', text: '图谱' },
                      { value: 'mermaid', text: 'Mermaid' },
                    ]}
                  />
                </div>
                <div className="mt-4 overflow-auto" style={{ maxHeight: 620 }}>
                  {rightTab === 'content' ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedNote.content}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                  {rightTab === 'graph' ? <NotesGraph data={graphData} onSelectNode={onGraphNode} highlightNode={`note:${selectedNote.note_id}`} /> : null}
                  {rightTab === 'mermaid' ? (
                    <div>
                      <Button onClick={() => void loadMermaid()}>生成 Mermaid</Button>
                      {mermaid ? <pre className="mt-3 overflow-auto rounded-lg bg-muted p-4 text-xs">{mermaid}</pre> : <p className="mt-3 text-sm text-muted-foreground">点击生成 Mermaid 流程图文本。</p>}
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">标签知识图谱</h3>
                  <Button onClick={() => void loadMermaid()}>Mermaid 视图</Button>
                </div>
                {rightTab === 'mermaid' ? (
                  <pre className="mt-4 overflow-auto rounded-lg bg-muted p-4 text-xs">{mermaid}</pre>
                ) : (
                  <NotesGraph data={graphData} onSelectNode={onGraphNode} />
                )}
              </div>
            )}
          </Card.Body>
        </Card>
      </div>

      <Modal visible={editorOpen} caption={editor.noteId ? '编辑笔记' : '新建笔记'} onClose={() => setEditorOpen(false)} size="l">
        <Modal.Body>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">标题</label>
              <Input value={editor.title} onChange={(v) => setEditor((s) => ({ ...s, title: v }))} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">标签（逗号分隔）</label>
              <Input value={editor.tagsText} onChange={(v) => setEditor((s) => ({ ...s, tagsText: v }))} placeholder="部署, 故障, SOP" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Markdown 内容</label>
              <textarea
                className="h-72 w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary"
                value={editor.content}
                onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
              />
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="weak" onClick={() => setEditorOpen(false)}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void saveEditor()}>保存</Button>
        </Modal.Footer>
      </Modal>
    </ResourcePage>
  );
}
