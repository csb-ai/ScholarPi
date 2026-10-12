import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import remarkTerms from './remark-terms';
import { MermaidDiagram } from './MermaidDiagram';
import { MarkdownCode } from './MarkdownCode';
import { normalizeMathMarkdown } from './markdown-format';
import 'katex/dist/katex.min.css';
import { cardStage, cardStages, createdText, dueText, intervalText, type CardStage, type ReviewPreview } from './card-learning';
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
export const Markdown = memo(function Markdown({
  text,
  onSourceId,
  terms,
  onTerm,
}: {
  text: string;
  onSourceId?: (id: string) => void;
  terms?: { term:string; explanation:string }[];
  onTerm?: (term:string)=>void;
}) {
  const formatted=useMemo(()=>normalizeMathMarkdown(text),[text]);
  return (
  <ReactMarkdown
    urlTransform={(url) =>
      url.startsWith('source:') ||
      url.startsWith('scholarpi-term:') ||
      url.startsWith('http:') ||
      url.startsWith('https:') ||
      url.startsWith('#')
        ? url
        : ''
    }
    components={{
      pre: ({ children, node }) => {
        const child = Array.isArray(children) ? children[0] : children;
        if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
          const code = String(child.props.children ?? '').replace(/\n$/, '');
          if (child.props.className?.split(' ').includes('language-mermaid')) {
            const source=formatted.slice(node?.position?.start.offset||0,node?.position?.end.offset??formatted.length);
            const lines=source.trimEnd().split('\n');
            const opening=lines[0]?.match(/^\s*(`{3,}|~{3,})/);
            const closing=lines[lines.length-1]?.match(/^\s*(`{3,}|~{3,})\s*$/);
            if(opening&&(!closing||closing[1][0]!==opening[1][0]||closing[1].length<opening[1].length))
              return <p className="diagram-pending" role="status">流程图代码正在生成，完成后展示图形…</p>;
            return <MermaidDiagram code={code.trim()} />;
          }
          return <MarkdownCode code={code} language={child.props.className?.replace(/^language-/, '')} />;
        }
        return <pre>{children}</pre>;
      },
      a: ({ href, children }) =>
        href?.startsWith('scholarpi-term:') ? (
          <button className="inline-term-card" title="点击将本轮解释保存为知识卡片" onClick={()=>{
            let name:string;try{name=decodeURIComponent(href.slice('scholarpi-term:'.length));}catch{return;}
            if(terms?.some(t=>t.term===name))onTerm?.(name);
          }}>{children}<sup>＋</sup></button>
        ) : href?.startsWith('source:') ? (
          onSourceId ? (
            <button className="source-inline" data-source-id={href.slice(7)} onClick={() => onSourceId(href.slice(7))}>
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
    remarkPlugins={[remarkGfm, remarkMath, [remarkTerms,{terms:terms?.map(t=>t.term)||[]}]]}
    rehypePlugins={[rehypeKatex]}
  >
    {formatted}
  </ReactMarkdown>
); });
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
  const pendingCreate = useRef<{ signature: string; id: string } | undefined>(undefined);
  function dismiss() {
    if (busy) return;
    if ((front !== draft.front || back !== draft.back) && !confirm('放弃尚未保存的卡片内容？')) return;
    onClose();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, front, back, busy]);
  return (
    <div className="modal-backdrop study-backdrop" onClick={dismiss}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        onKeyDown={trapFocus}
        aria-labelledby="card-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row"><h2 id="card-heading">创建知识卡片</h2><div className="spacer"/><button disabled={busy} onClick={dismiss} aria-label="关闭创建卡片">× 关闭</button></div>
        <p className="muted">正面写问题，反面写你确认的解释。保存的解释独立保留，之后修改笔记不会覆盖它。</p>
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
          <button disabled={busy} onClick={dismiss}>取消，返回</button>
          <button
            className="primary"
            disabled={busy || !front.trim() || !back.trim()}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const signature = JSON.stringify({ ...draft, front, back });
                if (pendingCreate.current?.signature !== signature) pendingCreate.current = { signature, id: key() };
                await api('/cards', {
                  method: 'POST',
                  body: json({ ...draft, front, back, idempotencyKey: pendingCreate.current.id }),
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
  const [editingNote, setEditingNote] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [, setEditorRevision] = useState(0);
  const pendingSave = useRef<{ signature: string; id: string } | undefined>(undefined);
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
    onUpdate: () => { setEditorRevision(n => n + 1); setSaveState('idle'); },
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
        setEditingNote(true);
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
      setEditingNote(true);
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
  const dirty = !!editor && (title !== (current?.title || '阅读笔记') || toMarkdown(editor) !== (current?.markdown || '') ||
    keywords.split(/[,，]/).map(s=>s.trim()).filter(Boolean).join(',') !== (current?.keywords || []).join(','));
  useEffect(() => {
    if (!editingNote || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editingNote, dirty]);
  function openNote(n?: Note) {
    setCurrent(n); setTitle(n?.title || '阅读笔记'); setKeywords(n?.keywords.join(', ') || '');
    setRefs(n?.sourceRefs || []); setSaveState('idle'); setMessage(''); setPreview(false);
    editor?.commands.setContent((n?.content as any) || { type: 'doc', content: (n?.markdown || '').split('\n').map(text=>({type:'paragraph',content:text?[{type:'text',text}]:[]})) });
    setEditingNote(true); pendingSave.current=undefined;
  }
  function closeNote() {
    if (busy || (dirty && !confirm('放弃尚未保存的笔记修改，返回笔记列表？'))) return;
    openNote(current); setEditingNote(false); setNoteSnapshot(undefined);
  }
  async function saveNote() {
    if (busy || !editor) return;
    if (!title.trim() || !toMarkdown(editor).trim()) { setMessage('请填写标题和笔记内容后再保存。'); setSaveState('error'); return; }
    const payload={paperId:paper?.paperId,title:title.trim(),markdown:toMarkdown(editor),content:editor.getJSON(),sourceRefs:refs,
      keywords:keywords.split(/[,，]/).map(s=>s.trim()).filter(Boolean),expectedRevision:current?.revisionId};
    const signature=JSON.stringify(payload);
    if(pendingSave.current?.signature!==signature) pendingSave.current={signature,id:key()};
    setBusy(true);setSaveState('saving');setMessage('正在保存笔记，请稍候…');
    try {
      const saved=await api<Note>(current?`/notes/${current.noteId}`:'/notes',{method:current?'PUT':'POST',body:json({...payload,idempotencyKey:pendingSave.current.id})});
      setCurrent(saved);setTitle(saved.title);setKeywords(saved.keywords.join(', '));setRefs(saved.sourceRefs);
      setNotes(items=>[saved,...items.filter(n=>n.noteId!==saved.noteId)]);
      pendingSave.current=undefined;setSaveState('saved');setMessage(`✓ 已保存「${saved.title}」 · ${new Date().toLocaleTimeString('zh-CN')}。可以继续编辑或返回笔记列表。`);
    } catch(e) {setSaveState('error');setMessage(`保存未成功：${(e as Error).message}。内容仍在编辑器中，请保留内容后重试。`);}
    finally {setBusy(false);}
  }
  if (!editingNote) return <div className="knowledge notebook-workspace">
    <header className="learning-section-heading"><div><span className="eyebrow">留住自己的理解</span><h2>我的笔记本 <span className="count">{notes.length}</span></h2><p className="muted">阅读、整理，再把需要记住的解释变成正反面卡片。</p></div><button className="primary" onClick={()=>openNote()}>＋ 写一篇笔记</button></header>
    {message && <p className="save-feedback" role="status">{message}</p>}
    <div className="notebook-grid">{notes.map(n=><button key={n.noteId} className="notebook-tile" onClick={()=>openNote(n)}><span className="eyebrow">阅读笔记</span><h3>{n.title}</h3><p>{n.markdown.slice(0,180)}</p><footer>{n.keywords.slice(0,4).join(' · ') || '自己的理解'}<span>打开 →</span></footer></button>)}</div>
    {!notes.length && <div className="empty"><h3>从一个读懂的观点开始记录</h3><p>可以直接写笔记，也可以从论文讲解中点“记到笔记”。</p></div>}
  </div>;
  return (
    <div className="knowledge note-edit-workspace" data-note-source={current?.ownSourceRef&&!dirty?JSON.stringify(current.ownSourceRef):undefined}>
      <div className="note-action-bar"><button disabled={busy} onClick={closeNote}>← 返回笔记列表</button><span className="small muted">{saveState==='saving'?'保存中…':dirty?'有未保存的修改':'内容已保存'} · Ctrl / ⌘ + Enter 保存</span><div className="spacer"/><button disabled={busy} onClick={closeNote}>取消编辑</button><button className="primary" disabled={busy || !editor} onClick={()=>void saveNote()}>{busy?'保存中…':'保存笔记'}</button></div>
      {message && <div className={`save-feedback ${saveState==='error'?'failure':saveState==='saved'?'success':''}`} role={saveState==='error'?'alert':'status'} aria-live="polite">{message}</div>}
      <div onKeyDown={e=>{if((e.ctrlKey || e.metaKey) && e.key==='Enter'){e.preventDefault();void saveNote();}}}>
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
            if (dirty && !confirm('放弃未保存修改，切换笔记？')) return;
            openNote(n);
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
      <p className="small muted">检索索引用于以后找回这篇笔记；语义索引在后台更新，不影响已经保存的正文。</p>
      <div className="row">
        <span className="small muted" role="status">
          {message}
        </span>
        <div className="spacer" />
        <button disabled={busy} onClick={closeNote}>取消，返回列表</button>
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
                setEditingNote(false);
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
          onClick={() => void saveNote()}
        >
          {busy ? '保存中…' : '保存笔记'}
        </button>
      </div>
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
export function Cards({ onSource, refreshKey, onNew, requestedSource }: {
  onSource: (s: SourceRef) => void; refreshKey: number; onNew: () => void; requestedSource?: SourceRef;
}) {
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [focusedCardId, setFocusedCardId] = useState('');
  const [viewing, setViewing] = useState<string>();
  const [browseIds, setBrowseIds] = useState<string[]>([]);
  const [queuePosition, setQueuePosition] = useState(0);
  const [stageFilter, setStageFilter] = useState<CardStage | 'all'>('all');
  const [clock, setClock] = useState(Date.now());
  const [later, setLater] = useState<{ cardId: string; due: string }[]>([]);
  const [prediction, setPrediction] = useState<ReviewPreview>();
  const [predictionError, setPredictionError] = useState('');
  const ratingInFlight = useRef(false);
  const [review, setReview] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<KnowledgeCard>();
  const [sourceSnapshot, setSourceSnapshot] = useState<{ text: string; sourceStatus: string; originSourceRef?: SourceRef }>();
  const pendingReview = useRef<{ signature: string; id: string } | undefined>(undefined);
  const pendingEdit = useRef<{ signature: string; id: string } | undefined>(undefined);
  const ratings = [
    { name: '忘记', hint: '没想起来，揭晓后才知道', style: 'again' },
    { name: '吃力', hint: '想起来了，但花了较大力气', style: 'hard' },
    { name: '记得', hint: '正常回忆，回答基本正确', style: 'good' },
    { name: '熟练', hint: '很快想起，而且非常确定', style: 'easy' },
  ];
  const refresh = async () => {
    const data = await api<{ items: KnowledgeCard[] }>('/cards');
    setCards(data.items || []);
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refreshKey]);
  useEffect(() => {
    let live = true;
    setSourceSnapshot(undefined);
    setFocusedCardId(requestedSource?.kind === 'card' ? requestedSource.objectId : '');
    setStageFilter('all');
    if (requestedSource) void api<{ text: string; sourceStatus: string; originSourceRef?: SourceRef }>(
      `/sources/${encodeURIComponent(requestedSource.sourceId)}?revisionId=${encodeURIComponent(requestedSource.revisionId)}`,
    ).then(data => { if (live) setSourceSnapshot(data); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [requestedSource]);
  const visible = focusedCardId ? cards.filter(c => c.cardId === focusedCardId) : cards;
  const shown = stageFilter === 'all' ? visible : visible.filter(c => cardStage(c, clock) === stageFilter);
  const due = shown.filter(c => !c.due || Date.parse(c.due) <= clock).sort((a,b) => (a.due || '').localeCompare(b.due || ''));
  const sequence = review ? queue : browseIds;
  const position = review ? Math.min(queuePosition, Math.max(0, queue.length - 1)) : browseIds.indexOf(viewing || '');
  const active = cards.find(c => c.cardId === (review ? queue[position] : viewing));
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), later.length ? 1000 : 30000);
    return () => clearInterval(timer);
  }, [later.length]);
  useEffect(() => {
    if (!review || !later.length) return;
    const ready = later.filter(c => Date.parse(c.due) <= clock);
    if (!ready.length) return;
    setQueue(ids => [...ids, ...ready.map(c => c.cardId).filter(id => !ids.includes(id))]);
    setLater(items => items.filter(c => !ready.some(r => r.cardId === c.cardId)));
    if (!queue.length) { setQueuePosition(0); setRevealed(false); }
  }, [clock, review, later]);
  useEffect(() => {
    let live = true;
    setPrediction(undefined); setPredictionError('');
    if (!active) return;
    void api<ReviewPreview>(`/cards/${encodeURIComponent(active.cardId)}/review-preview?revision=${active.revision}`)
      .then(result => { if (live) setPrediction(result); })
      .catch(e => { if (live) setPredictionError(e.message); });
    return () => { live = false; };
  }, [active?.cardId, active?.revision]);
  function moveCard(delta: number) {
    if (busy || ratingInFlight.current || editing || sequence.length < 2) return;
    const next = (position + delta + sequence.length) % sequence.length;
    if (review) setQueuePosition(next); else setViewing(sequence[next]);
    setRevealed(false); setError('');
  }
  function closeCard() {
    if (busy) return;
    setReview(false); setViewing(undefined); setQueue([]); setLater([]); setRevealed(false); setError('');
  }
  function closeEdit() {
    if (busy) return;
    const saved = cards.find(c => c.cardId === editing?.cardId);
    if (editing && saved && (editing.front !== saved.front || editing.back !== saved.back) && !confirm('放弃尚未保存的卡片修改？')) return;
    setEditing(undefined); setError('');
  }
  useEffect(() => {
    if (!review && !viewing && !editing) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); editing ? closeEdit() : closeCard(); return; }
      const target = e.target as HTMLElement;
      if (editing || target.closest('input,textarea,select,[contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (![' ', 'ArrowLeft', 'ArrowRight', '1', '2', '3', '4'].includes(e.key)) return;
      e.preventDefault();
      if (e.repeat || busy || ratingInFlight.current || !active) return;
      if (e.key === ' ') setRevealed(value => !value);
      else if (e.key === 'ArrowLeft') moveCard(-1);
      else if (e.key === 'ArrowRight') moveCard(1);
      else if (revealed) void rate(Number(e.key));
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.body.style.overflow = before; document.removeEventListener('keydown', keydown, true); };
  }, [review, viewing, editing, busy, revealed, active, queuePosition, queue, browseIds]);
  function startReview(ids: string[]) {
    setQueue(ids); setQueuePosition(0); setLater([]); setReviewed(0); setReview(true); setViewing(undefined); setRevealed(false); setError(''); setMessage('');
    pendingReview.current = undefined;
  }
  async function rate(rating: number) {
    if (!active || !revealed || busy || ratingInFlight.current) return;
    ratingInFlight.current = true;
    const signature = `${active.cardId}:${active.revision}:${rating}`;
    if (pendingReview.current?.signature !== signature) pendingReview.current = { signature, id: key() };
    setBusy(true); setError('');
    try {
      const updated = await api<KnowledgeCard>(`/cards/${active.cardId}/reviews`, {
        method: 'POST', body: json({ rating, expectedRevision: active.revision, idempotencyKey: pendingReview.current.id }),
      });
      setCards(items => items.map(c => c.cardId === updated.cardId ? updated : c));
      setMessage(`已记录「${ratings[rating-1].name}」，下次复习：${updated.due ? new Date(updated.due).toLocaleString('zh-CN') : '已安排'}。`);
      setReviewed(n => n + 1);
      if (review) {
        const remaining = queue.filter(id => id !== active.cardId);
        setQueue(remaining); setQueuePosition(Math.min(position, Math.max(0, remaining.length - 1)));
        const state = updated.fsrsState as { state?: number };
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
        if ([1, 3].includes(state.state ?? -1) && updated.due && Date.parse(updated.due) <= todayEnd.getTime())
          setLater(items => [...items.filter(c => c.cardId !== updated.cardId), { cardId: updated.cardId, due: updated.due! }].sort((a,b)=>a.due.localeCompare(b.due)));
      } else setViewing(browseIds[position + 1]);
      setClock(Date.now()); setRevealed(false); pendingReview.current = undefined;
    } catch (e) { setError(`本次评级未确认保存：${(e as Error).message}。可以重试同一评级，或先退出。`); }
    finally { ratingInFlight.current = false; setBusy(false); }
  }
  async function openInlineSource(id: string) {
    try { const data = await api<{ sourceRef: SourceRef }>(`/sources/${encodeURIComponent(id)}`); closeCard(); onSource(data.sourceRef); }
    catch (e) { setError(`来源无法打开：${(e as Error).message}`); }
  }
  const sourceLabel = (c: KnowledgeCard) => ({ active: '依据可查看', keyword_deleted: '原关键词已删除，解释保留', source_deleted: '原来源已删除，解释保留', manual: '独立创建' }[c.sourceStatus] || '个人理解');
  return <div className="knowledge flashcard-workspace">
    <header className="learning-section-heading">
      <div><span className="eyebrow">把读过变成记得</span><h2>我的知识卡片 <span className="count">{visible.length}</span></h2><p className="muted">先试着回忆，再揭晓解释。你的解释独立保存，不会跟着来源悄悄变化。</p></div>
      <div className="row"><button onClick={onNew}>＋ 创建卡片</button><button className="primary" disabled={!due.length} onClick={() => startReview(due.map(c=>c.cardId))}>开始今日复习 · {due.length}</button></div>
    </header>
    <div className="review-howto"><span><b>1</b> 看正面，先回忆</span><span><b>2</b> 点击卡片，揭晓反面</span><span><b>3</b> 按真实记忆自评</span></div>
    <div className="card-stage-filters" aria-label="按学习状态筛选">
      <button className={stageFilter==='all'?'active':''} onClick={()=>setStageFilter('all')}>全部 <b>{visible.length}</b></button>
      {cardStages.map(s=><button key={s.key} data-stage={s.key} className={stageFilter===s.key?'active':''} onClick={()=>setStageFilter(s.key)}>{s.label} <b>{visible.filter(c=>cardStage(c,clock)===s.key).length}</b></button>)}
    </div>
    <details className="learning-explainer"><summary>复习日期怎么来的？什么是 FSRS？</summary><p><b>FSRS：自由间隔重复调度算法</b>（Free Spaced Repetition Scheduler）。它根据你每次的记忆自评和历史状态，安排下次复习，不是固定每天重看全部卡片。</p><p>先主动回忆再看答案，能让自评更接近真实情况。忘记就安排较早再看，熟练通常间隔更长；最终日期由算法和这张卡的历史决定。它不能判断你是否真正理解论文。</p><p>本机用 SQLite 保存解释版本、记忆状态和复习记录；未评级或直接退出不会推进复习日程。</p></details>
    {focusedCardId && <p className="row small muted">正在查看被引用的卡片 <button onClick={()=>setFocusedCardId('')}>查看全部 {cards.length} 张</button></p>}
    {message && <p className="save-feedback success" role="status">✓ {message}</p>}
    {error && !review && !viewing && !editing && <p className="save-feedback failure" role="alert">{error}</p>}
    {sourceSnapshot && requestedSource && <details className="explanation-snapshot"><summary>查看引用保存版本 · {requestedSource.revisionId}（个人理解）</summary><p className="muted">这是确切的引用版本，下面卡片列表是当前版本。保存的解释不等于论文事实。</p><div className="prose"><Markdown text={sourceSnapshot.text} onSourceId={id=>void openInlineSource(id)} /></div>{sourceSnapshot.originSourceRef && <><p>创建时的依据</p><Sources refs={[sourceSnapshot.originSourceRef]} onSource={onSource}/></>}</details>}
    {shown.length ? <div className="study-card-grid">{shown.map((c,i)=><article className="study-card-tile" data-learning-state={cardStage(c,clock)} key={c.cardId}>
      <button className="study-card-cover" onClick={()=>{setBrowseIds(shown.map(item=>item.cardId));setViewing(c.cardId);setRevealed(false);setError('');setMessage('');}}><div className="card-cover-heading"><span className="card-number">{String(i+1).padStart(2,'0')} · 问题</span><span className="learning-state-pill" data-stage={cardStage(c,clock)}>{cardStages.find(s=>s.key===cardStage(c,clock))?.label}</span></div><h3>{c.front}</h3><span className="card-open-hint">先想一想，点击打开 →</span></button>
      <div className="card-schedule-line">{dueText(c,clock)}</div>
      <footer><span className="small muted" title={c.createdAtEstimated?'历史卡片按最初未复习记录的时间估计':'卡片创建日期'}>{createdText(c)}<br/>{sourceLabel(c)}</span><button onClick={()=>{setEditing({...c});setError('');}}>编辑</button></footer>
    </article>)}</div> : <div className="empty"><h3>{visible.length?'这个状态下暂时没有卡片':'从一段真正理解的解释开始'}</h3><p>在笔记里选词建卡，或创建“问题＋自己的解释”。每次先回忆，之后再揭晓答案。</p>{visible.length?<button onClick={()=>setStageFilter('all')}>查看全部卡片</button>:<button className="primary" onClick={onNew}>创建第一张卡片</button>}</div>}
    {(review || viewing) && <div className="modal-backdrop study-backdrop" onClick={closeCard}><section className="study-dialog" role="dialog" aria-modal="true" aria-label={review ? '知识卡片复习' : '查看知识卡片'} onClick={e=>e.stopPropagation()} onKeyDown={trapFocus}>
      <header className="study-dialog-header"><span>{review ? `今日复习 · 已记录 ${reviewed} 次 · 待处理 ${queue.length} 张${later.length?` · 稍后 ${later.length} 张`:''}` : `浏览卡片 · ${position+1} / ${browseIds.length} · 自评才更新日程`}</span><button autoFocus disabled={busy} aria-label="关闭卡片并返回列表" onClick={closeCard}>× 关闭</button></header>
      <div className="card-keyboard-help"><span><kbd>←</kbd><kbd>→</kbd> 切换</span><span><kbd>空格</kbd> 翻面</span><span><kbd>1</kbd>—<kbd>4</kbd> 自评</span><span><kbd>Esc</kbd> 退出</span></div>
      {active ? <>
        <div className="card-navigation"><button disabled={busy||sequence.length<2} onClick={()=>moveCard(-1)} aria-label="上一张卡片">← 上一张</button><span className="learning-state-pill" data-stage={cardStage(active,clock)}>{cardStages.find(s=>s.key===cardStage(active,clock))?.label}</span><button disabled={busy||sequence.length<2} onClick={()=>moveCard(1)} aria-label="下一张卡片">下一张 →</button></div>
        <p className="card-current-due">{dueText(active,clock)}</p>
        <div className={`flip-card ${revealed ? 'is-revealed' : ''}`} key={active.cardId}><div className="flip-card-inner">
          <button className="flip-face flip-front" tabIndex={revealed ? -1 : 0} aria-hidden={revealed} onClick={()=>setRevealed(true)}><span className="eyebrow">正面 · 先在心里回答</span><h2>{active.front}</h2><span className="muted">不用急着看答案，先试着说出自己的理解。</span><strong>点击卡片揭晓反面 ↻</strong></button>
          <div className="flip-face flip-back" aria-hidden={!revealed}><span className="eyebrow">反面 · 当时保存的解释</span>{revealed && <><div className="prose"><Markdown text={active.back} onSourceId={id=>void openInlineSource(id)}/></div><details><summary>查看解释依据与版本</summary><p className="small muted">{sourceLabel(active)}；以下依据需另行核对，不等于论文已经证明这段解释。</p>{active.sourceRef && <Sources refs={[active.sourceRef]} onSource={ref=>{closeCard();onSource(ref);}}/>}<Sources refs={active.ownSourceRef ? [active.ownSourceRef] : []} onSource={ref=>{closeCard();onSource(ref);}}/></details></>}</div>
        </div></div>
        {!revealed ? <button className="primary reveal-answer" onClick={()=>setRevealed(true)}>空格 · 我想好了，揭晓解释</button> : <><p className="rating-instruction">没看答案时，你能想起多少？按 1—4 自评，保存后进入下一张。</p><div className="memory-ratings">{ratings.map((r,i)=>{
          const estimate=prediction?.cardId===active.cardId&&prediction.revision===active.revision?prediction.options.find(o=>o.rating===i+1):undefined;
          return <button key={r.name} className={r.style} disabled={busy} onClick={()=>void rate(i+1)} title={estimate?`预计下次：${new Date(estimate.due).toLocaleString('zh-CN')}`:r.hint}><b><kbd>{i+1}</kbd> {r.name}</b><strong className="rating-forecast">{estimate?`${intervalText(estimate.intervalSeconds)}后`:predictionError?'预估暂不可用':'正在计算…'}</strong><span>{r.hint}</span></button>;
        })}</div><p className="schedule-footnote">由这张卡的 FSRS 记忆状态计算；正式保存按提交时刻重新安排。<button className="text-link" onClick={()=>setRevealed(false)}>空格 · 翻回正面</button></p>{predictionError&&<p className="small muted">无法取得预估：{predictionError}。实际评级仍由服务端计算，不显示猜测的时间。</p>}</>}
        {review && <button className="text-link" disabled={busy} onClick={()=>{const remaining=queue.filter(id=>id!==active.cardId);setQueue(remaining);setQueuePosition(Math.min(position,Math.max(0,remaining.length-1)));setRevealed(false);pendingReview.current=undefined;}}>暂时跳过，不记录评级</button>}
      </> : later.length ? <div className="review-complete"><span>◷</span><h2>这一批已经看完</h2><p>有 {later.length} 张学习中的卡片，预计 {intervalText(Math.max(0,(Date.parse(later[0].due)-clock)/1000))}后再出现。</p><p>你可以等到时间继续，也可以先退出；下次日期已经保存在本机。</p><button className="primary" onClick={closeCard}>暂时结束复习</button></div> : <div className="review-complete"><span>✓</span><h2>本轮复习结束</h2><p>已记录 {reviewed} 次复习。其余卡片按各自日期再见。</p><button className="primary" onClick={closeCard}>返回卡片列表</button></div>}
      {busy && <p role="status">正在保存，请稍候…</p>}{error && <p className="save-feedback failure" role="alert">{error}</p>}{message && <p className="small muted" role="status">{message}</p>}
      <footer className="study-dialog-footer"><span>{active?createdText(active)+' · ':''}切换、翻面和退出不记录评级。</span><button disabled={busy} onClick={closeCard}>{review ? '退出本轮复习' : '返回卡片列表'}</button></footer>
    </section></div>}
    {editing && <div className="modal-backdrop study-backdrop" onClick={closeEdit}><section className="modal card-edit-dialog" role="dialog" aria-modal="true" aria-label="编辑知识卡片" onClick={e=>e.stopPropagation()} onKeyDown={trapFocus}>
      <div className="row"><h2>编辑卡片</h2><div className="spacer"/><button disabled={busy} onClick={closeEdit} aria-label="关闭卡片编辑">× 关闭</button></div><p className="muted">正面留问题，反面写解释。修改只在保存后生效。</p>
      <label>正面 · 想让自己回忆的问题<input autoFocus value={editing.front} onChange={e=>setEditing({...editing,front:e.target.value})}/></label><label>反面 · 揭晓后的解释<textarea rows={8} value={editing.back} onChange={e=>setEditing({...editing,back:e.target.value})}/></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row end"><button disabled={busy} onClick={closeEdit}>取消，返回列表</button><button className="primary" disabled={busy || !editing.front.trim() || !editing.back.trim()} onClick={async()=>{
        const signature=JSON.stringify({id:editing.cardId,front:editing.front,back:editing.back,revision:editing.revision});
        if(pendingEdit.current?.signature!==signature) pendingEdit.current={signature,id:key()};
        setBusy(true);setError('');
        try { const updated=await api<KnowledgeCard>(`/cards/${editing.cardId}`,{method:'PUT',body:json({...editing,expectedRevision:editing.revision,idempotencyKey:pendingEdit.current.id})}); setCards(items=>items.map(c=>c.cardId===updated.cardId?updated:c));setEditing(undefined);pendingEdit.current=undefined;setMessage('卡片已保存，原有复习历史保留。'); }
        catch(e){setError((e as Error).message);}finally{setBusy(false);}
      }}>{busy?'保存中…':'保存修改'}</button></div>
    </section></div>}
  </div>;
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
