import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
function trapFocus(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
    ),
  );
  if (!items.length) return;
  const first = items[0],
    last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import { api, json, key, download } from './api';
import type {
  Paper,
  Note,
  KnowledgeCard,
  SourceRef,
  GraphData,
  Evidence,
} from '../../../packages/contracts';
export const Markdown = ({
  text,
  onSourceId,
}: {
  text: string;
  onSourceId?: (id: string) => void;
}) => (
  <ReactMarkdown
    urlTransform={(url) =>
      url.startsWith('source:') ||
      url.startsWith('http:') ||
      url.startsWith('https:') ||
      url.startsWith('#')
        ? url
        : ''
    }
    components={{
      a: ({ href, children }) =>
        href?.startsWith('source:') ? (
          onSourceId ? (
            <button className="source-inline" onClick={() => onSourceId(href.slice(7))}>
              {children}
            </button>
          ) : (
            <span>{children}</span>
          )
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
    }}
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
  >
    {text}
  </ReactMarkdown>
);
export function Sources({
  refs,
  onSource,
}: {
  refs?: SourceRef[];
  onSource: (s: SourceRef) => void;
}) {
  return (
    <div className="sources">
      {refs?.map((s, i) => (
        <button key={`${s.sourceId}-${i}`} onClick={() => onSource(s)}>
          ↗ {s.kind === 'note' ? '笔记' : s.kind === 'card' ? '卡片 · 个人理解' : '原文'}
          {s.page ? ` · p.${s.page}` : ''}
        </button>
      ))}
    </div>
  );
}
type Draft = {
  front: string;
  back: string;
  origin: KnowledgeCard['origin'];
  sourceRef?: SourceRef;
  keyword?: string;
};
export function CardDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [front, setFront] = useState(draft.front);
  const [back, setBack] = useState(draft.back);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        onKeyDown={trapFocus}
        aria-labelledby="card-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="card-heading">保存解释快照</h2>
        <p className="muted">内容由你确认。之后修改笔记不会覆盖这张卡片。</p>
        <label>
          正面 · 概念或问题
          <input autoFocus value={front} onChange={(e) => setFront(e.target.value)} />
        </label>
        <label>
          背面 · 当时的解释
          <textarea rows={8} value={back} onChange={(e) => setBack(e.target.value)} />
        </label>
        {draft.sourceRef && (
          <p className="small muted">已绑定来源版本 {draft.sourceRef.revisionId}</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={busy || !front.trim() || !back.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/cards', {
                  method: 'POST',
                  body: json({ ...draft, front, back, idempotencyKey: key() }),
                });
                onSaved();
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '保存中…' : '保存卡片'}
          </button>
        </div>
      </section>
    </div>
  );
}
function toMarkdown(editor: any): string {
  const doc = editor.getJSON();
  function block(n: any): string {
    const inner = n.content?.map(block).join('') || n.text || '';
    switch (n.type) {
      case 'heading':
        return `${'#'.repeat(n.attrs.level)} ${inner}\n\n`;
      case 'paragraph':
        return inner + '\n\n';
      case 'bulletList':
      case 'orderedList':
        return (
          n.content
            .map(
              (v: any, i: number) =>
                `${n.type === 'orderedList' ? i + 1 + '.' : '-'} ${block(v).trim()}\n`,
            )
            .join('') + '\n'
        );
      case 'codeBlock':
        return '```\n' + inner + '\n```\n\n';
      case 'blockquote':
        return '> ' + inner.trim() + '\n\n';
      case 'hardBreak':
        return '\n';
      case 'text':
        return (
          n.marks?.reduce(
            (s: string, m: any) =>
              m.type === 'bold'
                ? `**${s}**`
                : m.type === 'italic'
                  ? `*${s}*`
                  : m.type === 'code'
                    ? `\`${s}\``
                    : s,
            inner,
          ) || inner
        );
      default:
        return inner;
    }
  }
  return block(doc).trim();
}
type IndexJob = { jobId: string; revisionId: string; status: string; error?: string };
function NoteIndexStatus({ jobId }: { jobId?: string }) {
  const [job, setJob] = useState<IndexJob>();
  const [error, setError] = useState('');
  const [pollRevision, setPollRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setJob(undefined);
    setError('');
    if (!jobId) return;
    async function poll() {
      try {
        const next = await api<IndexJob>(`/jobs/${encodeURIComponent(jobId!)}`);
        if (!active) return;
        setJob(next);
        setError('');
        if (['pending', 'running'].includes(next.status))
          timer = setTimeout(() => void poll(), 1500);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, pollRevision]);
  if (!jobId) return null;
  const label: Record<string, string> = {
    pending: '向量索引等待处理',
    running: '向量索引正在更新',
    done: '向量索引已更新',
    failed: '向量索引失败，全文检索仍可用',
    interrupted: '向量索引中断，全文检索仍可用',
    superseded: '该索引任务已由新版本替代',
    cancelled: '向量索引已取消',
  };
  return (
    <div className="row small" role="status" aria-live="polite">
      <span className={error || job?.status === 'failed' ? 'error' : 'muted'}>
        {error
          ? `索引状态读取失败：${error}`
          : job
            ? label[job.status] || `索引状态：${job.status}`
            : '正在读取索引状态…'}
        {job?.error ? ` · ${job.error}` : ''}
      </span>
      {error && <button onClick={() => setPollRevision((v) => v + 1)}>刷新状态</button>}
      {job && ['failed', 'interrupted', 'cancelled'].includes(job.status) && (
        <button
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await api(`/jobs/${encodeURIComponent(jobId)}/retry`, {
                method: 'POST',
                body: json({}),
              });
              setPollRevision((v) => v + 1);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? '重试中…' : '重试索引'}
        </button>
      )}
    </div>
  );
}
export function Notes({
  paper,
  seed,
  requestedNoteId,
  requestedSource,
  onSource,
  onCard,
}: {
  paper?: Paper;
  requestedNoteId?: string;
  requestedSource?: SourceRef;
  seed?: { markdown: string; sourceRefs: SourceRef[]; nonce: string };
  onSource: (s: SourceRef) => void;
  onCard: (d: Draft) => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<Note>();
  const [title, setTitle] = useState('阅读笔记');
  const [keywords, setKeywords] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [markdownExport, setMarkdownExport] = useState<{ name: string; text: string }>();
  const [exportMessage, setExportMessage] = useState('');
  const [refs, setRefs] = useState<SourceRef[]>([]);
  const [noteSnapshot, setNoteSnapshot] = useState<{ text: string; sourceStatus: string }>();
  async function openInlineSource(id: string) {
    try {
      const saved = await api<{ sourceRef: SourceRef }>(`/sources/${encodeURIComponent(id)}`);
      onSource(saved.sourceRef);
    } catch (e) {
      setMessage(`来源无法打开：${(e as Error).message}`);
    }
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, protocols: ['https', 'http'] }),
    ],
    content: '',
    editorProps: { attributes: { 'aria-label': '笔记内容', class: 'note-editor' } },
  });
  const refresh = () =>
    api<{ items: Note[] }>(`/notes${paper ? `?paperId=${encodeURIComponent(paper.paperId)}` : ''}`)
      .then((d) => setNotes(d.items || []))
      .catch((e) => setMessage(e.message));
  useEffect(() => {
    void refresh();
  }, [paper?.paperId]);
  useEffect(() => {
    let active = true;
    setNoteSnapshot(undefined);
    if (requestedSource)
      api<{ text: string; sourceStatus: string }>(
        `/sources/${encodeURIComponent(requestedSource.sourceId)}?revisionId=${encodeURIComponent(requestedSource.revisionId)}`,
      )
        .then((snapshot) => {
          if (active) setNoteSnapshot(snapshot);
        })
        .catch((e) => {
          if (active) setMessage(e.message);
        });
    return () => {
      active = false;
    };
  }, [requestedSource]);
  useEffect(() => {
    if (!requestedNoteId || !editor) return;
    api<Note>(`/notes/${requestedNoteId}`)
      .then((n) => {
        setCurrent(n);
        setTitle(n.title);
        setKeywords(n.keywords.join(', '));
        setRefs(n.sourceRefs);
        editor.commands.setContent(
          (n.content as any) || {
            type: 'doc',
            content: n.markdown.split('\n').map((text) => ({
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : [],
            })),
          },
        );
      })
      .catch((e) => setMessage(e.message));
  }, [requestedNoteId, editor]);
  useEffect(() => {
    if (seed && editor) {
      setCurrent(undefined);
      setTitle('阅读笔记');
      setRefs(seed.sourceRefs);
      editor.commands.setContent({
        type: 'doc',
        content: seed.markdown
          .split('\n')
          .map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
      });
      setMessage('已带入回答，编辑后保存。');
    }
  }, [seed?.nonce, editor]);
  return (
    <div className="knowledge">
      {noteSnapshot && requestedSource && (
        <section className="knowledge-card" aria-label="笔记来源快照">
          <div className="row">
            <h3>笔记来源快照 · 个人理解</h3>
            <button onClick={() => setNoteSnapshot(undefined)}>关闭快照</button>
          </div>
          <p className="muted small">
            引用版本 {requestedSource.revisionId} ·{' '}
            {noteSnapshot.sourceStatus === 'superseded'
              ? '历史快照；下方编辑器是当前笔记'
              : '保存的来源'}
            。
          </p>
          <div className="prose">
            <Markdown text={noteSnapshot.text} onSourceId={(id) => void openInlineSource(id)} />
          </div>
        </section>
      )}
      <div className="row">
        <select
          aria-label="选择笔记"
          value={current?.noteId || ''}
          onChange={(e) => {
            const n = notes.find((v) => v.noteId === e.target.value);
            setCurrent(n);
            setTitle(n?.title || '阅读笔记');
            setKeywords(n?.keywords.join(', ') || '');
            setRefs(n?.sourceRefs || []);
            editor?.commands.setContent(
              (n?.content as any) || {
                type: 'doc',
                content: (n?.markdown || '').split('\n').map((text) => ({
                  type: 'paragraph',
                  content: text ? [{ type: 'text', text }] : [],
                })),
              },
            );
          }}
        >
          <option value="">＋ 新建笔记</option>
          {notes.map((n) => (
            <option key={n.noteId} value={n.noteId}>
              {n.title}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (editor) {
              setExportMessage('');
              setMarkdownExport({ name: `${title}.md`, text: toMarkdown(editor) });
            }
          }}
        >
          导出 Markdown
        </button>
      </div>
      <input
        className="note-title"
        aria-label="笔记标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="editor-toolbar">
        <button aria-label="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}>
          <b>B</b>
        </button>
        <button
          aria-label="二级标题"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</button>
        <button onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>代码</button>
        <button onClick={() => setPreview(!preview)}>{preview ? '返回编辑' : '阅读预览'}</button>
        <button
          onClick={() => {
            const selected = editor?.state.doc.textBetween(
              editor.state.selection.from,
              editor.state.selection.to,
              ' ',
            );
            if (!selected) {
              setMessage('先在笔记中选择一段文字。');
              return;
            }
            onCard({
              front: selected.slice(0, 120),
              back: selected,
              origin: 'selection',
              sourceRef: current?.ownSourceRef
                ? {
                    ...current.ownSourceRef,
                    quote: current.markdown.includes(selected) ? selected : undefined,
                  }
                : undefined,
            });
          }}
        >
          划词建卡
        </button>
      </div>
      {preview ? (
        <div className="prose">
          <Markdown
            text={editor ? toMarkdown(editor) : ''}
            onSourceId={(id) => void openInlineSource(id)}
          />
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}
      <label className="small">
        关键词（逗号分隔）
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="添加概念，保存后点击建卡"
        />
      </label>
      <div className="sources">
        {current?.keywords.map((word) => (
          <button
            key={word}
            onClick={() =>
              onCard({
                front: word,
                back: current.markdown,
                origin: 'keyword',
                keyword: word,
                sourceRef: current.ownSourceRef
                  ? {
                      ...current.ownSourceRef,
                      quote: current.markdown.includes(word) ? word : undefined,
                    }
                  : undefined,
              })
            }
          >
            {word} ＋卡片
          </button>
        ))}
      </div>
      <Sources refs={refs} onSource={onSource} />
      <NoteIndexStatus jobId={current?.indexJobId} />
      <div className="row">
        <span className="small muted" role="status">
          {message}
        </span>
        <div className="spacer" />
        {current && (
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('删除这篇笔记？已有卡片及复习记录会保留。')) return;
              try {
                await api(`/notes/${current.noteId}`, { method: 'DELETE' });
                setCurrent(undefined);
                editor?.commands.clearContent();
                setRefs([]);
                await refresh();
                setMessage('已删除笔记');
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            删除
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !editor || !title.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api<Note>(current ? `/notes/${current.noteId}` : '/notes', {
                method: current ? 'PUT' : 'POST',
                body: json({
                  paperId: paper?.paperId,
                  title,
                  markdown: toMarkdown(editor),
                  content: editor?.getJSON(),
                  sourceRefs: refs,
                  keywords: keywords
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                  expectedRevision: current?.revisionId,
                  idempotencyKey: key(),
                }),
              });
              setCurrent(data);
              await refresh();
              setMessage('笔记已保存，检索索引随版本更新。');
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '保存中…' : '保存笔记'}
        </button>
      </div>
      {markdownExport && (
        <div className="modal-backdrop" onClick={() => setMarkdownExport(undefined)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="导出 Markdown"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMarkdownExport(undefined);
              else trapFocus(e);
            }}
          >
            <h2>导出 Markdown</h2>
            <p>{markdownExport.name}</p>
            <textarea
              className="markdown-export-content"
              aria-label="Markdown导出内容"
              value={markdownExport.text}
              readOnly
              autoFocus
            />
            <p className="small muted">可保存文件，或复制内容到本地 Markdown 编辑器。</p>
            {exportMessage && <p role="status">{exportMessage}</p>}
            <div className="row">
              <button onClick={() => download(markdownExport.name, markdownExport.text)}>
                保存 .md 文件
              </button>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(markdownExport.text);
                    setExportMessage('Markdown已复制');
                  } catch {
                    setExportMessage('请选中上方内容，使用 Ctrl+C 复制。');
                  }
                }}
              >
                复制 Markdown
              </button>
              <button onClick={() => setMarkdownExport(undefined)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export function Cards({
  onSource,
  refreshKey,
  onNew,
  requestedSource,
}: {
  onSource: (s: SourceRef) => void;
  refreshKey: number;
  onNew: () => void;
  requestedSource?: SourceRef;
}) {
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [focusedCardId, setFocusedCardId] = useState('');
  async function openInlineSource(id: string) {
    try {
      const saved = await api<{ sourceRef: SourceRef }>(`/sources/${encodeURIComponent(id)}`);
      onSource(saved.sourceRef);
    } catch (e) {
      setError(`来源无法打开：${(e as Error).message}`);
    }
  }
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<KnowledgeCard>();
  const [sourceSnapshot, setSourceSnapshot] = useState<{
    text: string;
    sourceStatus: string;
    originSourceRef?: SourceRef;
  }>();
  const refresh = () =>
    api<{ items: KnowledgeCard[] }>('/cards')
      .then((d) => setCards(d.items || []))
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, [refreshKey]);
  useEffect(() => {
    let active = true;
    setSourceSnapshot(undefined);
    setFocusedCardId(requestedSource?.kind === 'card' ? requestedSource.objectId : '');
    if (requestedSource)
      api<{ text: string; sourceStatus: string; originSourceRef?: SourceRef }>(
        `/sources/${encodeURIComponent(requestedSource.sourceId)}?revisionId=${encodeURIComponent(requestedSource.revisionId)}`,
      )
        .then((snapshot) => {
          if (active) setSourceSnapshot(snapshot);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [requestedSource]);
  const visibleCards = focusedCardId ? cards.filter((c) => c.cardId === focusedCardId) : cards;
  const due = visibleCards.filter((c) => !c.due || new Date(c.due) <= new Date());
  const active = due[0];
  return (
    <div className="knowledge">
      <div className="row">
        <h2>
          知识卡片 <span className="count">{visibleCards.length}</span>
        </h2>
        <div className="spacer" />
        <button onClick={onNew}>＋ 手动创建</button>
        <button
          className="primary"
          disabled={!review && !due.length}
          onClick={() => {
            setReview(!review);
            setRevealed(false);
          }}
        >
          {review ? '结束复习' : `复习到期 · ${due.length}`}
        </button>
      </div>
      {focusedCardId && (
        <div className="row small muted">
          <span>当前引用的卡片</span>
          <button onClick={() => setFocusedCardId('')}>查看全部卡片 · {cards.length}</button>
        </div>
      )}
      <p className="muted small">
        保存当时的解释与来源；笔记修改不会自动覆盖。四档自评由 FSRS 计算下次到期。
      </p>
      {error && <p className="error">{error}</p>}
      {sourceSnapshot && requestedSource && (
        <section className="knowledge-card" aria-label="卡片来源快照">
          <div className="row">
            <h3>卡片解释来源 · 个人理解</h3>
            <button onClick={() => setSourceSnapshot(undefined)}>关闭快照</button>
          </div>
          <p className="muted small">
            版本 {requestedSource.revisionId} ·{' '}
            {sourceSnapshot.sourceStatus === 'superseded'
              ? '历史快照；当前卡片已有新版本'
              : '保存的卡片快照'}
            。这段解释不是论文原文。
          </p>
          <div className="prose">
            <Markdown text={sourceSnapshot.text} onSourceId={(id) => void openInlineSource(id)} />
          </div>
          {sourceSnapshot.originSourceRef && (
            <>
              <p className="small muted">创建时的依据（需另行核对）</p>
              <Sources refs={[sourceSnapshot.originSourceRef]} onSource={onSource} />
            </>
          )}
        </section>
      )}
      {review && active ? (
        <div className="review-card">
          <span className="eyebrow">今日复习 · 还有 {due.length} 张</span>
          <h2>{active.front}</h2>
          {revealed ? (
            <>
              <div className="prose">
                <Markdown text={active.back} onSourceId={(id) => void openInlineSource(id)} />
              </div>
              <div className="ratings">
                {['忘记', '吃力', '记得', '熟练'].map((label, i) => (
                  <button
                    disabled={busy}
                    key={label}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`/cards/${active.cardId}/reviews`, {
                          method: 'POST',
                          body: json({
                            rating: i + 1,
                            expectedRevision: active.revision,
                            idempotencyKey: key(),
                          }),
                        });
                        await refresh();
                        setRevealed(false);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {i + 1} · {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="primary" onClick={() => setRevealed(true)}>
              显示解释
            </button>
          )}
        </div>
      ) : visibleCards.length ? (
        <div className="card-grid">
          {visibleCards.map((c) => (
            <article className="knowledge-card" key={c.cardId}>
              <span className={`tag ${c.sourceStatus.includes('deleted') ? 'warning' : ''}`}>
                {
                  {
                    active: '来源有效',
                    keyword_deleted: '来源关键词已删除',
                    source_deleted: '来源文件已删除',
                    manual: '手动卡片',
                  }[c.sourceStatus]
                }
              </span>
              <h3>{c.front}</h3>
              <div className="prose">
                <Markdown text={c.back} onSourceId={(id) => void openInlineSource(id)} />
              </div>
              {c.sourceRef && <Sources refs={[c.sourceRef]} onSource={onSource} />}
              {c.ownSourceRef && <Sources refs={[c.ownSourceRef]} onSource={onSource} />}
              <div className="row small muted">
                <span>到期 {c.due ? new Date(c.due).toLocaleString('zh-CN') : '待首次复习'}</span>
                <button onClick={() => setEditing({ ...c })}>编辑</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <h3>把理解留下来</h3>
          <p>从笔记关键词、划词或手动创建第一张卡片。</p>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="编辑卡片"
            onKeyDown={(e) => {
              trapFocus(e);
              if (e.key === 'Escape') setEditing(undefined);
            }}
          >
            <h2>编辑卡片</h2>
            <label>
              正面
              <input
                autoFocus
                value={editing.front}
                onChange={(e) => setEditing({ ...editing, front: e.target.value })}
              />
            </label>
            <label>
              背面
              <textarea
                rows={8}
                value={editing.back}
                onChange={(e) => setEditing({ ...editing, back: e.target.value })}
              />
            </label>
            <div className="row end">
              <button onClick={() => setEditing(undefined)}>取消</button>
              <button
                className="primary"
                onClick={async () => {
                  try {
                    await api(`/cards/${editing.cardId}`, {
                      method: 'PUT',
                      body: json({
                        ...editing,
                        expectedRevision: editing.revision,
                        idempotencyKey: key(),
                      }),
                    });
                    setEditing(undefined);
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                保存
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
export function Graph({ onSource }: { onSource: (s: SourceRef) => void }) {
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [alias, setAlias] = useState('');
  const [canonical, setCanonical] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceObjectId, setSourceObjectId] = useState('');
  const [targetObjectId, setTargetObjectId] = useState('');
  const [selectedRef, setSelectedRef] = useState<SourceRef>();
  async function load(nextQuery = query) {
    try {
      setData(await api(`/graph?query=${encodeURIComponent(nextQuery)}`));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const objects = data.nodes.filter((n) => n.kind !== 'concept');
  const relationRefs = data.edges
    .flatMap((e) => (e.sourceRef?.objectId === sourceObjectId ? [e.sourceRef] : []))
    .filter(
      (r, i, a) =>
        a.findIndex((v) => v.sourceId === r.sourceId && v.revisionId === r.revisionId) === i,
    );
  function selectSource(ref: SourceRef) {
    setSelectedRef(ref);
    setSourceObjectId(ref.objectId);
    onSource(ref);
  }
  return (
    <div className="knowledge">
      <h2>来源图谱</h2>
      <p className="muted small">只展示有记录的出现、引用与用户关联；点击关系查看出处。</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          aria-label="图谱概念"
          placeholder="查找一个概念或对象"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button>查询</button>
      </form>
      <details className="claims">
        <summary>纠正概念别名</summary>
        <p className="small muted">
          仅在你确认两个名称指同一概念时保存。歧义缩写保留独立，不自动合并。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!alias.trim() || !canonical.trim()) return;
            setBusy(true);
            setError('');
            setMessage('');
            try {
              await api('/graph/aliases', {
                method: 'POST',
                body: json({ alias: alias.trim(), canonical: canonical.trim() }),
              });
              setQuery(canonical.trim());
              await load(canonical.trim());
              setMessage('别名映射已保存，请核对更新后的概念关系。');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            别名
            <input
              aria-label="需要纠正的概念别名"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="例如：RAG"
            />
          </label>
          <label>
            规范名称
            <input
              aria-label="概念规范名称"
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder="例如：retrieval augmented generation"
            />
          </label>
          <button disabled={busy || !alias.trim() || !canonical.trim()}>确认保存别名</button>
        </form>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="small muted" role="status">
          {message}
        </p>
      )}
      {data.nodes.length ? (
        <>
          <div className="graph">
            <ReactFlow
              nodes={data.nodes.map((n, i) => ({
                id: n.id,
                data: { label: n.label },
                position: { x: (i % 3) * 220, y: Math.floor(i / 3) * 130 },
                style: {
                  background: n.kind === 'paper' ? '#e9edf9' : '#e8f4ed',
                  border: '1px solid #ccd5e2',
                  borderRadius: 12,
                },
              }))}
              edges={data.edges.map((e) => ({
                ...e,
                type: 'default',
                label: e.type,
                animated: false,
              }))}
              onNodeClick={(_, node) => {
                const edge = data.edges.find(
                  (e) => (e.source === node.id || e.target === node.id) && e.sourceRef,
                );
                if (edge?.sourceRef) selectSource(edge.sourceRef);
              }}
              onEdgeClick={(_, edge) => {
                const ref = data.edges.find((e) => e.id === edge.id)?.sourceRef;
                if (ref) selectSource(ref);
              }}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
          <details className="claims">
            <summary>添加有出处的用户关联</summary>
            <p className="small muted">
              选择当前图中的两个对象，并用来源对象的已记录证据说明关联；关联代表你的判断。
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  !selectedRef ||
                  selectedRef.objectId !== sourceObjectId ||
                  !targetObjectId ||
                  sourceObjectId === targetObjectId
                )
                  return;
                setBusy(true);
                setError('');
                setMessage('');
                try {
                  await api('/graph/relations', {
                    method: 'POST',
                    body: json({ sourceObjectId, targetObjectId, sourceRef: selectedRef }),
                  });
                  await load();
                  setMessage('用户关联已保存，原始来源版本保持不变。');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                来源对象
                <select
                  aria-label="关联来源对象"
                  value={sourceObjectId}
                  onChange={(e) => {
                    setSourceObjectId(e.target.value);
                    setSelectedRef(undefined);
                  }}
                >
                  <option value="">选择对象</option>
                  {objects.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标对象
                <select
                  aria-label="关联目标对象"
                  value={targetObjectId}
                  onChange={(e) => setTargetObjectId(e.target.value)}
                >
                  <option value="">选择对象</option>
                  {objects
                    .filter((n) => n.id !== sourceObjectId)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                关联依据
                <select
                  aria-label="关联的版本化来源"
                  value={selectedRef?.sourceId || ''}
                  onChange={(e) =>
                    setSelectedRef(relationRefs.find((r) => r.sourceId === e.target.value))
                  }
                >
                  <option value="">选择已记录来源</option>
                  {relationRefs.map((r) => (
                    <option key={r.sourceId} value={r.sourceId}>
                      {r.kind === 'note' ? '笔记' : r.kind === 'card' ? '卡片' : '论文'}
                      {r.page ? ` p.${r.page}` : ''} · {r.quote?.slice(0, 60) || r.revisionId}
                    </option>
                  ))}
                </select>
              </label>
              {selectedRef && <Sources refs={[selectedRef]} onSource={onSource} />}
              <button
                disabled={
                  busy ||
                  !selectedRef ||
                  selectedRef.objectId !== sourceObjectId ||
                  !targetObjectId ||
                  targetObjectId === sourceObjectId
                }
              >
                保存用户关联
              </button>
            </form>
          </details>
        </>
      ) : (
        <div className="empty">
          <h3>关系从来源中生长</h3>
          <p>导入论文、保存带关键词的笔记后，查看可追溯的关联。</p>
        </div>
      )}
    </div>
  );
}
export function Search({ onSource }: { onSource: (s: SourceRef) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [results, setResults] = useState<Evidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="knowledge">
      <h2>跨论文检索</h2>
      <p className="muted">从论文、个人笔记与卡片中找回资料；个人解释需另回原文核对。</p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!query.trim()) return;
          setBusy(true);
          setError('');
          try {
            const d = await api<{ items: Evidence[] }>(
              `/search?q=${encodeURIComponent(query)}${kind ? `&kind=${kind}` : ''}`,
            );
            setResults(d.items || []);
            setSearched(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <select aria-label="检索范围" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部资料</option>
          <option value="paper">论文原文</option>
          <option value="note">个人笔记</option>
          <option value="card">解释卡片</option>
        </select>
        <input
          aria-label="检索问题"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如：检索增强的证据来自哪里？"
        />
        <button className="primary" disabled={busy}>
          {busy ? '检索中…' : '检索'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {results.map((r, i) => (
        <article className="search-result" key={i}>
          <span className="tag">
            {r.sourceRef.kind === 'paper'
              ? '论文原文'
              : r.sourceRef.kind === 'note'
                ? '个人笔记'
                : '卡片 · 个人理解'}
          </span>
          <div className="prose">
            <Markdown text={r.text} />
          </div>
          <Sources refs={[r.sourceRef]} onSource={onSource} />
          {r.originSourceRef && (
            <div className="small muted">
              创建依据（不等于支持解释）
              <Sources refs={[r.originSourceRef]} onSource={onSource} />
            </div>
          )}
          {r.path && <p className="small muted">扩展路径：{r.path.join(' → ')}</p>}
        </article>
      ))}
      {searched && !results.length && !error && (
        <div className="empty">
          <h3>当前材料未找到匹配证据</h3>
          <p>换一个关键词，或导入相关论文后重试。</p>
        </div>
      )}
    </div>
  );
}
