import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Plus,
  Search as SearchIcon,
  NotebookPen,
  Layers,
  Network,
  ArrowUp,
  Check,
  ChevronUp,
  ChevronDown,
  Square,
  PanelRightClose,
  PanelRightOpen,
  Upload,
  ArrowRight,
  AlertCircle,
  Home,
  HelpCircle,
} from 'lucide-react';
import type {
  Paper,
  SourceRef,
  ReadingPlan,
  RunSnapshot,
  RunEvent,
  Evidence,
  ReadingSummary,
} from '../../../packages/contracts';
import { readingDirections, readingEffects, readingQuestion } from '../../../packages/contracts/reading-options';
import { api, json, key } from './api';
import PdfViewer from './PdfViewer';
import { Markdown, Sources, Notes, Cards, CardDialog, Graph, Search } from './Knowledge';
import { HomePage, GuidePage, RunTrace, type PageView } from './Showcase';
type Tab = 'read' | 'notes' | 'cards' | 'graph' | 'search';
type Message = { role: 'user' | 'assistant'; text: string; run?: RunSnapshot };
const statusLabel: Record<string, string> = {
  queued: '排队中',
  processing: '正在解析',
  ready: '可阅读',
  partial: '部分完成',
  failed: '解析失败',
  deleted: '已删除',
  running: '正在阅读',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
};
export default function App() {
  const routePage = () =>
    (['workbench', 'guide'].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : 'home') as PageView;
  const [page, setPage] = useState<PageView>(routePage);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selected, setSelected] = useState<Paper>();
  const [health, setHealth] = useState<any>();
  const [tab, setTab] = useState<Tab>('read');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [session, setSession] = useState('');
  const [plan, setPlan] = useState<ReadingPlan>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<RunSnapshot>();
  const [question, setQuestion] = useState('');
  const [depth, setDepth] = useState('');
  const [direction, setDirection] = useState('');
  const [readings, setReadings] = useState<ReadingSummary[]>([]);
  const [mode, setMode] = useState<'function' | 'code'>('function');
  const [source, setSource] = useState<SourceRef>();
  const [sourcePaper, setSourcePaper] = useState<Paper>();
  const [viewer, setViewer] = useState(() => window.matchMedia('(min-width:901px)').matches);
  const [cardDraft, setCardDraft] = useState<any>();
  const [cardRevision, setCardRevision] = useState(0);
  const [noteSeed, setNoteSeed] = useState<{
    markdown: string;
    sourceRefs: SourceRef[];
    nonce: string;
  }>();
  const [toolStatus, setToolStatus] = useState('');
  const [filter, setFilter] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const stream = useRef<EventSource | undefined>(undefined);
  const generation = useRef(0);
  const seq = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const contentScroll = useRef<HTMLDivElement>(null);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const busy = run?.status === 'running' || run?.status === 'queued';
  const activeWorkbench = page === 'workbench';
  const showViewer = activeWorkbench && viewer;
  useEffect(() => {
    contentScroll.current?.scrollTo({ top: 0 });
  }, [page]);
  function navigate(next: PageView) {
    setPage(next);
    if (location.hash !== '#' + next) location.hash = next;
    setError('');
    setNotice('');
  }
  useEffect(() => {
    const changed = () => setPage(routePage());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  async function refreshPapers() {
    const d = await api<{ items: Paper[] }>('/papers');
    setPapers(d.items || []);
    setSelected((p) => (p ? d.items.find((x) => x.paperId === p.paperId) || p : p));
  }
  useEffect(() => {
    api('/health')
      .then(setHealth)
      .catch((e) => {
        setHealth({ status: 'offline' });
        setError(e.message);
      });
    void api<{ items: Paper[] }>('/papers')
      .then((d) => {
        setPapers(d.items || []);
        const id = localStorage.getItem('scholarpi.paper');
        const p = d.items.find((v) => v.paperId === id);
        if (p) {
          if (routePage() === 'workbench') void choose(p);
          else setSelected(p);
        }
      })
      .catch((e) => setError(e.message));
    return () => stream.current?.close();
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [run?.text, messages.length]);
  useEffect(() => {
    if (selected && session) localStorage.setItem(`scholarpi.session.${selected.paperId}`, session);
  }, [selected?.paperId, session]);
  async function choose(p: Paper, fresh = false) {
    navigate('workbench');
    const selectionToken = ++generation.current;
    stream.current?.close();
    setSelected(p);
    localStorage.setItem('scholarpi.paper', p.paperId);
    setSource(undefined);
    setSourcePaper(undefined);
    setViewer(window.matchMedia('(min-width:901px)').matches);
    setSession('');
    setMessages([]);
    setPlan(undefined);
    setRun(undefined);
    setReadings([]);
    setQuestion('');
    setDepth('');
    setDirection('');
    setTab('read');
    setError('');
    try {
      const history = await api<{ items: ReadingSummary[] }>(`/papers/${p.paperId}/readings?revisionId=${p.revisionId}`);
      if (selectionToken !== generation.current) return;
      setReadings(history.items);
      const saved = localStorage.getItem(`scholarpi.session.${p.paperId}`);
      if (saved && !fresh) {
        try {
          const restored = await api<any>(`/sessions/${saved}`);
          if (selectionToken !== generation.current) return;
          if (restored.purpose === 'workspace' && (restored.revisionId === p.revisionId || restored.paperRevisionId === p.revisionId)) {
            setSession(saved);
            setMessages(restored.messages || []);
            setPlan(restored.plan);
            const runId = restored.activeRunId || localStorage.getItem(`scholarpi.run.${saved}`);
            if (runId) {
              const snapshot = await api<RunSnapshot>(`/runs/${runId}`);
              setRun(snapshot);
              if (['queued', 'running'].includes(snapshot.status))
                connect(runId, generation.current);
              else applySnapshot(snapshot);
            }
            return;
          }
        } catch {
          localStorage.removeItem(`scholarpi.session.${p.paperId}`);
        }
      }
      const d = await api<{ sessionId: string; messages?: Message[]; plan?: ReadingPlan }>(
        '/sessions',
        { method: 'POST', body: json({ paperId: p.paperId, revisionId: p.revisionId, fresh }) },
      );
      if (selectionToken !== generation.current) return;
      setSession(d.sessionId);
      setMessages(d.messages || []);
      setPlan(d.plan);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function importPaper(file: File) {
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const d = await api<{ paperId: string; revisionId: string; jobId?: string; duplicate: boolean; fileHash: string; paper: Paper }>('/papers', {
        method: 'POST',
        body: form,
      });
      await refreshPapers();
      await choose(d.paper);
      const importNotice = d.duplicate
        ? 'SHA-256 文件指纹一致，已打开原论文和保存的讲解，没有新增论文或重复解析。'
        : 'PDF 已接收。请选择阅读目标和讲解效果；解析与索引在后台进行。';
      setNotice(importNotice);
      if (d.duplicate || !d.jobId || ['ready', 'partial'].includes(d.paper.status)) {
        setUploading(false);
        return;
      }
      setUploading(false);
      let count = 0;
      const poll = async () => {
        try {
          const job = await api<any>(`/jobs/${d.jobId}`);
          await refreshPapers();
          if (
            [
              'done',
              'completed',
              'ready',
              'partial',
              'failed',
              'cancelled',
              'interrupted',
            ].includes(job.status)
          ) {
            setUploading(false);
            const p = await api<Paper>(`/papers/${d.paperId}?revisionId=${d.revisionId}`);
            setSelected(current => current?.paperId === p.paperId && current.revisionId === p.revisionId ? p : current);
            if (job.error) setError(String(job.error));
            return;
          }
          if (count++ < 900) setTimeout(() => void poll(), 2000);
          else {
            setUploading(false);
            setError('导入仍在运行，请刷新论文状态。');
          }
        } catch (e) {
          setUploading(false);
          setError((e as Error).message);
        }
      };
      void poll();
    } catch (e) {
      setUploading(false);
      setError((e as Error).message);
    }
  }
  function applySnapshot(snapshot: RunSnapshot) {
    setRun(snapshot);
    if (snapshot.plan) setPlan(snapshot.plan);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)) {
      stream.current?.close();
      localStorage.removeItem(`scholarpi.run.${snapshot.sessionId}`);
      setToolStatus('');
      setMessages((ms) =>
        ms.some((m) => m.run?.runId === snapshot.runId)
          ? ms.map((m) =>
              m.run?.runId === snapshot.runId
                ? { role: 'assistant', text: snapshot.text, run: snapshot }
                : m,
            )
          : [...ms, { role: 'assistant', text: snapshot.text, run: snapshot }],
      );
      setRun(undefined);
      if (snapshot.error) setError(snapshot.error);
      if (snapshot.paperId && selected?.paperId === snapshot.paperId && selected.revisionId === snapshot.paperRevisionId) {
        const token = generation.current;
        void api<{ items: ReadingSummary[] }>(`/papers/${snapshot.paperId}/readings?revisionId=${snapshot.paperRevisionId}`)
          .then(d => { if (token === generation.current) setReadings(d.items); }).catch(e => setError(e.message));
      }
    }
  }
  function connect(runId: string, token: number) {
    stream.current?.close();
    seq.current = 0;
    const es = new EventSource(`/api/runs/${runId}/events`);
    stream.current = es;
    const consume = (raw: MessageEvent) => {
      if (!raw.data) return;
      if (token !== generation.current) return;
      try {
        const e = JSON.parse(raw.data) as RunEvent;
        if (e.type === 'reset') {
          void api<RunSnapshot>(`/runs/${runId}`).then(applySnapshot);
          return;
        }
        if (e.seq <= seq.current) return;
        seq.current = e.seq;
        const p = e.payload as any;
        if (e.type === 'snapshot' || e.type === 'done') applySnapshot(p);
        else if (e.type === 'text_delta')
          setRun((r) => (r ? { ...r, text: r.text + (p.delta || '') } : r));
        else if (e.type === 'plan') setPlan(p);
        else if (e.type === 'claims') setRun((r) => (r ? { ...r, claims: p.items } : r));
        else if (e.type === 'evidence') setRun((r) => (r ? { ...r, evidence: p.items } : r));
        else if (e.type === 'document_progress')
          setToolStatus(
            p.status === 'parsing'
              ? '正在解析全文…'
              : `扫描原页转写 ${p.completedPages?.length ?? 0}/${p.pages?.length ?? 0}（后台任务）`,
          );
        else if (e.type === 'tool') setToolStatus(`${p.name} · ${p.status}`);
        else if (e.type === 'error') setError(p.message || '阅读任务失败');
      } catch {
        setError('收到无法解析的任务事件，请刷新任务状态。');
      }
    };
    es.onmessage = consume;
    [
      'snapshot',
      'text_delta',
      'plan',
      'tool',
      'claims',
      'evidence',
      'done',
      'error',
      'reset',
    ].forEach((name) => es.addEventListener(name, consume as EventListener));
    es.onerror = () => {
      if (token === generation.current)
        void api<RunSnapshot>(`/runs/${runId}`)
          .then((snapshot) => {
            if (token === generation.current) applySnapshot(snapshot);
          })
          .catch((e) => setError(e.message));
    };
  }
  async function ask(text: string, action?: string, force = false, requestedDepth = depth) {
    if (!selected || !session || busy || pendingQuestion || !text.trim()) return;
    if (!requestedDepth) { setNotice('先选择希望达到的讲解效果：建立直觉、掌握方法或深入技术。'); return; }
    setError('');
    setQuestion('');
    setPendingQuestion(text);
    setMessages((ms) => [...ms, { role: 'user', text }]);
    const token = generation.current;
    try {
      const d = await api<{ runId: string; reused: boolean }>(`/sessions/${session}/turns`, {
        method: 'POST',
        body: json({ question: text, action, depth: requestedDepth, mode, force, idempotencyKey: key() }),
      });
      localStorage.setItem(`scholarpi.run.${session}`, d.runId);
      const snapshot = await api<RunSnapshot>(`/runs/${d.runId}`);
      if (token !== generation.current) return;
      if (d.reused) {
        await openReading(d.runId);
        setNotice('已复用相同论文版本、问题、讲解效果与工具模式的完成结果。本次没有新调用模型。');
        return;
      }
      setRun(snapshot);
      if (['queued', 'running'].includes(snapshot.status)) connect(d.runId, token);
      else applySnapshot(snapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingQuestion('');
    }
  }
  async function locate(ref: SourceRef) {
    try {
      const saved = await api<{ sourceRef: SourceRef; available: boolean }>(
        `/sources/${ref.sourceId}?revisionId=${encodeURIComponent(ref.revisionId)}`,
      );
      if (!saved.available) {
        setError('来源文件已删除，解释快照仍保留。');
        return;
      }
      ref = { ...saved.sourceRef, ...(ref.quote ? { quote: ref.quote } : {}) };
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setSource(ref);
    setViewer(ref.kind === 'paper');
    if (ref.kind === 'note') {
      setTab('notes');
      return;
    }
    if (ref.kind === 'card') {
      setTab('cards');
      return;
    }
    if (selected?.paperId !== ref.objectId) {
      try {
        const p = await api<Paper>(`/papers/${ref.objectId}`);
        setSourcePaper(p);
      } catch (e) {
        setError(`来源无法打开：${(e as Error).message}`);
      }
    }
  }
  async function openReading(runId: string) {
    const token = generation.current;
    const snapshot = await api<RunSnapshot>(`/runs/${runId}`);
    const restored = await api<any>(`/sessions/${snapshot.sessionId}`);
    if (token !== generation.current) return;
    stream.current?.close();
    setSession(snapshot.sessionId);
    setMessages(restored.messages || [{ role: 'user', text: snapshot.question }, { role: 'assistant', text: snapshot.text, run: snapshot }]);
    setPlan(restored.plan ?? snapshot.plan);
    setRun(undefined);
    setDepth(snapshot.depth ?? 'standard');
    setDirection(snapshot.action ?? '');
    setMode(snapshot.mode);
    setQuestion('');
    setTab('read');
    setNotice('已打开保存的真实讲解。点击页码核对原文，或展开“运行过程”查看原始记录。');
  }
  async function changePlan(index: number, action: 'up' | 'down' | 'skip' | 'done' | 'pending') {
    if (!plan) return;
    const steps = plan.steps.map((s) => ({ ...s }));
    if (action === 'up' || action === 'down') {
      const target = index + (action === 'up' ? -1 : 1);
      if (!steps[target]) return;
      [steps[index], steps[target]] = [steps[target], steps[index]];
    } else steps[index].status = action === 'skip' ? 'skipped' : action;
    try {
      const updated = await api<ReadingPlan>(`/sessions/${session}/plan`, {
        method: 'PUT',
        body: json({ plan: { ...plan, steps } }),
      });
      setPlan(updated);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const evidenceRefs = (r?: RunSnapshot) =>
    r?.evidence?.map((e) => e.sourceRef) || r?.claims?.flatMap((c) => c.sourceRefs) || [];
  function answerTools(text: string, r?: RunSnapshot) {
    return (
      <div className="answer-tools">
        <button onClick={() => void ask('请用更通俗的方式解释刚才的内容。', 'simplify')}>
          更通俗一点
        </button>
        <button
          onClick={() =>
            void ask('解释刚才内容涉及的公式或图表，并给出原页来源。', 'figure_equation')
          }
        >
          看公式／图表
        </button>
        <button
          onClick={() =>
            void ask('补充理解刚才内容需要的背景，区分背景知识和论文结论。', 'background')
          }
        >
          补背景
        </button>
        <button
          onClick={() => {
            setNoteSeed({ markdown: text, sourceRefs: evidenceRefs(r), nonce: key() });
            setTab('notes');
          }}
        >
          记到笔记
        </button>
        <button
          onClick={() => {
            const selectedText = window.getSelection()?.toString().trim();
            setCardDraft({
              front: selectedText ? selectedText.slice(0, 120) : '关于这篇论文的理解',
              back: selectedText || text,
              origin: 'selection',
              sourceRef: evidenceRefs(r)[0],
            });
          }}
        >
          加入卡片
        </button>
      </div>
    );
  }
  const hasPaper = !!selected;
  return (
    <div
      className={`app ${showViewer ? '' : 'viewer-hidden'} ${activeWorkbench ? '' : 'intro-page'}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          aria-label="ScholarPi · 返回首页"
          onClick={(e) => {
            e.preventDefault();
            navigate('home');
          }}
        >
          <span className="brand-icon">π</span>
          <span>
            Scholar<span className="brand-pi">Pi</span>
            <small>让每一份理解都有出处</small>
          </span>
        </a>
        <nav className="primary-nav" aria-label="主导航">
          {(
            [
              ['home', '首页', Home],
              ['guide', '使用指南', HelpCircle],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-button ${page === id ? 'selected' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              title={label}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <button
          className="import-button"
          disabled={uploading}
          onClick={() => upload.current?.click()}
        >
          <Plus size={17} />
          {uploading ? '导入处理中…' : '导入论文'}
          <kbd>PDF</kbd>
        </button>
        <input
          hidden
          ref={upload}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importPaper(f);
            e.target.value = '';
          }}
        />
        <button
          className={`nav-button ${activeWorkbench && tab === 'search' ? 'selected' : ''}`}
          title="查找论文、笔记与卡片"
          onClick={() => {
            navigate('workbench');
            setTab('search');
          }}
        >
          <SearchIcon size={17} />
          查找知识
        </button>
        <div className="sidebar-section">
          <span>论文库</span>
          <span>{papers.length}</span>
        </div>
        <div className="library-filter">
          <SearchIcon size={14} />
          <input
            aria-label="筛选论文"
            placeholder="查找论文…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="paper-list">
          {papers
            .filter(
              (p) => p.status !== 'deleted' && p.title.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((p) => (
              <button
                className={`paper-item ${activeWorkbench && p.paperId === selected?.paperId ? 'active' : ''}`}
                key={p.paperId}
                title={`打开论文：${p.title}`}
                onClick={() => void choose(p)}
              >
                <BookOpen size={17} />
                <span>
                  <strong>{p.title}</strong>
                  <small>
                    <i className={`status-dot ${p.status}`} />
                    {statusLabel[p.status]} · {p.pageCount || '—'} 页
                  </small>
                </span>
              </button>
            ))}
          {!papers.length && (
            <div className="library-empty">
              还没有论文
              <br />
              从一份 PDF 开始
            </div>
          )}
        </div>
        {activeWorkbench && tab === 'read' && plan && (
          <>
            <div className="sidebar-section">
              <span>当前阅读路线</span>
              <span>
                {plan.steps.filter((s) => s.status === 'done').length}/{plan.steps.length}
              </span>
            </div>
            <ol className="reading-plan">
              {plan.steps.map((step, i) => (
                <li key={step.id} className={step.status}>
                  <div className="step-row">
                    <button
                      className="step-number"
                      title="点击标记已读／未懂"
                      onClick={() =>
                        void changePlan(i, step.status === 'done' ? 'pending' : 'done')
                      }
                    >
                      {step.status === 'done' ? <Check size={12} /> : i + 1}
                    </button>
                    <button
                      className="step-goal"
                      onClick={() => void ask(`按阅读路线讲解：${step.goal}`)}
                    >
                      {step.goal}
                    </button>
                  </div>
                  <p>{step.rationale}</p>
                  {step.prerequisites.length > 0 && (
                    <small>前置：{step.prerequisites.join('、')}</small>
                  )}
                  <Sources refs={step.sourceRefs} onSource={(s) => void locate(s)} />
                  <div className="plan-actions">
                    <button
                      disabled={i === 0 || busy}
                      aria-label={`上移 ${step.goal}`}
                      onClick={() => void changePlan(i, 'up')}
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      disabled={i === plan.steps.length - 1 || busy}
                      aria-label={`下移 ${step.goal}`}
                      onClick={() => void changePlan(i, 'down')}
                    >
                      <ChevronDown size={13} />
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void changePlan(i, step.status === 'skipped' ? 'pending' : 'skip')
                      }
                    >
                      {step.status === 'skipped' ? '恢复' : '跳过'}
                    </button>
                    <button disabled={busy} onClick={() => void changePlan(i, 'pending')}>
                      未懂
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
        <footer className="sidebar-footer">
          <span className={`status-dot ${health?.status === 'offline' ? 'failed' : 'ready'}`} />
          {!health
            ? '连接本地服务…'
            : health.status === 'offline'
              ? '本地服务不可达'
              : '本地工作区'}
          <button
            aria-label="刷新服务和论文"
            onClick={() => {
              void refreshPapers().catch((e) => setError(e.message));
              void api('/health')
                .then(setHealth)
                .catch(() => setHealth({ status: 'offline' }));
            }}
          >
            刷新
          </button>
        </footer>
      </aside>
      <main className="main-panel">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">
              {
                {
                  home: '开始使用',
                  workbench: '阅读工作台',
                  guide: '使用与项目说明',
                }[page]
              }
            </span>
            <h1>
              {activeWorkbench
                ? tab === 'search'
                  ? '查找知识'
                  : selected?.title || '我的知识工作台'
                : {
                    home: 'ScholarPi',
                    workbench: '阅读工作台',
                    guide: '使用指南',
                  }[page]}
            </h1>
          </div>
          {activeWorkbench && selected && (
            <button
              className="session-button"
              title="开始这篇论文的新对话，旧记录保留"
              disabled={busy}
              onClick={() => void choose(selected, true)}
            >
              新对话
            </button>
          )}
          {activeWorkbench && selected && (
            <details className="paper-options">
              <summary>更多</summary>
              <button
                className="delete-paper small"
                disabled={busy}
                onClick={async () => {
                  if (!confirm('删除这篇论文及其原文？卡片快照和复习记录会保留。')) return;
                  try {
                    await api(`/papers/${selected.paperId}`, { method: 'DELETE' });
                    stream.current?.close();
                    generation.current++;
                    setSelected(undefined);
                    setSession('');
                    setPlan(undefined);
                    setMessages([]);
                    setRun(undefined);
                    navigate('home');
                    localStorage.removeItem('scholarpi.paper');
                    await refreshPapers();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                删除论文
              </button>
            </details>
          )}
          {activeWorkbench && selected && (
            <button
              className="viewer-toggle"
              title={viewer ? '收起原文面板' : '展开原文 PDF'}
              aria-expanded={viewer}
              onClick={() => setViewer(!viewer)}
            >
              {viewer ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
              {viewer ? '收起原文' : '展开原文'}
            </button>
          )}
        </header>
        {activeWorkbench && (
          <nav className="tabs" aria-label="工作台栏目">
            {(
              [
                ['read', '论文讲解', BookOpen],
                ['notes', '我的笔记', NotebookPen],
                ['cards', '解释卡片', Layers],
                ['graph', '来源关系', Network],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
        )}
        {activeWorkbench && (
          <div className="workspace-hint">
            {
              {
                read: '自由选择阅读目标与讲解效果，或打开保存的讲解。点页码核对原文，再继续追问。',
                notes: '记录你自己的理解。确认标题和内容后点击“保存笔记”。',
                cards: '卡片保存当时的解释；可查看来源，并按记忆情况安排复习。',
                graph: '查看概念出现在哪些材料里。点击关系可以查看对应出处。',
                search: '按关键词或意思查找论文、笔记与卡片。',
              }[tab]
            }
            <button onClick={() => navigate('guide')}>操作说明</button>
          </div>
        )}
        {error && (
          <div className="error error-banner" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <p className="notice-banner" role="status">
            {notice}
          </p>
        )}
        {activeWorkbench && selected && tab !== 'search' && (
          <div className="coverage">
            <span className={`status-dot ${selected.status}`} />
            {statusLabel[selected.status]}
            <details className="file-identity"><summary>文件唯一标识 · SHA-256</summary><code>{selected.fileHash}</code><p>按 PDF 的实际字节识别；改文件名不会变，文件内容变了会得到不同指纹。</p></details>
            <span>
              已处理 {selected.coverage.processedPages.length}/{selected.pageCount} 页
            </span>
            {selected.coverage.pendingPages.length > 0 && (
              <span>待处理 {selected.coverage.pendingPages.length} 页</span>
            )}
            {selected.coverage.scannedPages.length > 0 && (
              <span>扫描页 {selected.coverage.scannedPages.length}</span>
            )}
          </div>
        )}
        <div className="content-scroll" ref={contentScroll}>
          {page === 'home' ? (
            <HomePage
              papers={papers}
              selected={selected}
              onChoose={(p) => void choose(p)}
              onImport={() => upload.current?.click()}
              onNavigate={navigate}
              uploading={uploading}
            />
          ) : page === 'guide' ? (
            <GuidePage onNavigate={navigate} />
          ) : tab === 'notes' ? (
            <Notes
              paper={selected}
              requestedNoteId={source?.kind === 'note' ? source.objectId : undefined}
              requestedSource={source?.kind === 'note' ? source : undefined}
              seed={noteSeed}
              onSource={(s) => void locate(s)}
              onCard={setCardDraft}
            />
          ) : tab === 'cards' ? (
            <Cards
              refreshKey={cardRevision}
              requestedSource={source?.kind === 'card' ? source : undefined}
              onSource={(s) => void locate(s)}
              onNew={() => setCardDraft({ front: '', back: '', origin: 'manual' })}
            />
          ) : tab === 'graph' ? (
            <Graph onSource={(s) => void locate(s)} />
          ) : tab === 'search' ? (
            <Search onSource={(s) => void locate(s)} />
          ) : (
            <>
              <div className={`welcome ${messages.length ? 'compact' : ''}`}>
                <span className="intro-mark">π</span>
                <span className="eyebrow">READ · UNDERSTAND · REMEMBER</span>
                <h2>{hasPaper ? '从问题开始，读懂这篇论文' : '把论文变成自己的理解'}</h2>
                <p>
                  {hasPaper
                    ? '选择一个阅读方向，或直接问你关心的问题。解释和来源一起展开。'
                    : '导入 PDF，按路线阅读，在原文中核对证据，再把理解存成笔记与卡片。'}
                </p>
                {!hasPaper && (
                  <button
                    className="primary"
                    onClick={() => upload.current?.click()}
                    disabled={uploading}
                  >
                    <Upload size={16} />
                    导入第一篇论文
                    <ArrowRight size={16} />
                  </button>
                )}
                {hasPaper && (
                  <div className="task-grid">
                    {[
                      ...readingDirections.map(o => [o.id, o.label, o.description]),
                    ].map(([action, title, description], i) => (
                      <button
                        key={action}
                        disabled={busy || !session || !!pendingQuestion}
                        className={direction === action ? 'chosen' : ''}
                        onClick={() => { setDirection(action); setQuestion(readingQuestion(action)); }}
                      >
                        <span className="task-index">0{i + 1}</span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                        <ArrowUp size={15} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {hasPaper && <section className="saved-readings">
                <div className="section-heading"><h3>已保存的讲解</h3><span>{readings.length} 份真实结果</span></div>
                {readings.length ? <div className="reading-history-grid">{readings.map(r => <button key={r.runId}
                  disabled={busy || !!pendingQuestion} onClick={() => void openReading(r.runId).catch(e => setError(e.message))}>
                  <strong>{readingDirections.find(o => o.id === r.action)?.label ?? '自由提问'} · {readingEffects.find(o => o.id === r.depth)?.label ?? '标准讲解'}</strong>
                  <span>{r.question}</span><small>{new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })} · 打开结果与过程</small>
                </button>)}</div> : <p className="muted">还没有这份文件的保存结果。选择目标与效果后开始讲解，完成后会自动保存在这里。</p>}
              </section>}
              <div className="conversation">
                {messages.map((m, i) => (
                  <article key={i} className={`message ${m.role}`}>
                    <div className="message-label">
                      {m.role === 'user' ? '你' : 'ScholarPi'}
                      {m.run && (
                        <span className="tag">{statusLabel[m.run.status] || m.run.status}</span>
                      )}
                    </div>
                    <div className="prose">
                      <Markdown
                        text={m.text || '本次任务没有生成讲解内容。'}
                        onSourceId={(id) => {
                          void api<{ sourceRef: SourceRef }>(`/sources/${id}`)
                            .then((s) => locate(s.sourceRef))
                            .catch((e) => setError(e.message));
                        }}
                      />
                    </div>
                    {m.role === 'assistant' && (
                      <>
                        <Sources refs={evidenceRefs(m.run)} onSource={(s) => void locate(s)} />
                        {m.run?.claims && (
                          <details className="claims">
                            <summary>论断与证据 · {m.run.claims.length}</summary>
                            {m.run.claims.map((c) => (
                              <div key={c.claimId}>
                                <span className="tag">
                                  {
                                    {
                                      paper_fact: '论文事实',
                                      personal_note: '个人理解',
                                      background: '背景补充',
                                    }[c.category]
                                  }{' '}
                                  · {c.support}
                                </span>
                                <p>{c.text}</p>
                                <Sources refs={c.sourceRefs} onSource={(s) => void locate(s)} />
                              </div>
                            ))}
                          </details>
                        )}
                        {m.run?.keywords?.length ? (
                          <div className="sources">
                            {m.run.keywords.map((k, i) => (
                              <button
                                key={i}
                                onClick={() =>
                                  setCardDraft({
                                    front: k.term,
                                    back: k.explanation,
                                    origin: 'keyword',
                                    keyword: k.term,
                                    sourceRef: k.sourceRefs[0],
                                  })
                                }
                              >
                                {k.term} ＋卡片
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {m.run?.quiz?.length ? (
                          <details className="claims">
                            <summary>可选理解题 · {m.run.quiz.length}</summary>
                            {m.run.quiz.map((q, i) => (
                              <div key={i}>
                                <p>{q.question}</p>
                                <details>
                                  <summary>查看参考解释</summary>
                                  <Markdown text={q.answer} />
                                  <Sources refs={q.sourceRefs} onSource={(s) => void locate(s)} />
                                </details>
                              </div>
                            ))}
                          </details>
                        ) : null}
                        {m.text && answerTools(m.text, m.run)}
                        {m.run && <RunTrace runId={m.run.runId} />}
                        {m.run?.cacheScope === 'paper' && <button className="small" disabled={busy || !!pendingQuestion}
                          onClick={() => { setDepth(m.run!.depth ?? 'standard'); void ask(m.run!.question!, m.run!.action, true, m.run!.depth ?? 'standard'); }}>重新生成此问题</button>}
                        {m.run?.usage && (
                          <p className="small muted">
                            模型请求 {m.run.usage.calls} · 输入{' '}
                            {m.run.usage.totalInput ?? m.run.usage.input} / 输出{' '}
                            {m.run.usage.output} token ·{' '}
                            {m.run.mode === 'code' ? 'Code Mode' : 'Function Calling'}
                          </p>
                        )}
                      </>
                    )}
                  </article>
                ))}
                {run && (
                  <article className="message assistant">
                    <div className="message-label">
                      ScholarPi <span className="tag pulse">{statusLabel[run.status]}</span>
                    </div>
                    <div className="prose">
                      <Markdown text={run.text || '正在整理上下文与来源…'} />
                    </div>
                    <Sources refs={evidenceRefs(run)} onSource={(s) => void locate(s)} />
                    {toolStatus && <p className="small muted">{toolStatus}</p>}
                  </article>
                )}
                <div ref={bottom} />
              </div>
            </>
          )}
        </div>
        {activeWorkbench && tab === 'read' && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question, direction || undefined);
            }}
          >
            <textarea
              aria-label="向论文提问"
              placeholder={selected ? '问这篇论文，或联系你之前的知识…' : '导入一篇论文后开始提问…'}
              value={question}
              disabled={!selected || !!pendingQuestion}
              onChange={(e) => { setQuestion(e.target.value); setDirection(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(question, direction || undefined);
                }
              }}
            />
            <div className="composer-bottom">
              <select
                aria-label="讲解效果"
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
              >
                <option value="">选择讲解效果…</option>
                {readingEffects.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <select
                aria-label="实验执行模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'function' | 'code')}
              >
                <option value="function">标准工具调用</option>
                <option value="code">代码编排 · 实验</option>
              </select>
              <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
              {busy ? (
                <button
                  type="button"
                  className="cancel-button"
                  onClick={async () => {
                    try {
                      await api(`/runs/${run.runId}/cancel`, { method: 'POST', body: json({}) });
                      applySnapshot(await api(`/runs/${run.runId}`));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Square size={13} />
                  停止本轮
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送问题"
                  disabled={!session || !question.trim() || !depth || !!pendingQuestion}
                >
                  <ArrowUp size={18} />
                  {pendingQuestion ? '提交中…' : '发送'}
                </button>
              )}
            </div>
            <p className="effect-explanation">{readingEffects.find(o => o.id === depth)?.description ?? '你希望读完后做到什么？先选择讲解效果，也可以在问题里写出自己的目标。'}</p>
            <p className="disclaimer">
              AI 讲解可能有误，请回到引用原文核对；来源可定位不等于解释正确。
            </p>
          </form>
        )}
      </main>
      {showViewer && (
        <PdfViewer
          paper={
            source?.kind === 'paper' && source.objectId !== selected?.paperId
              ? sourcePaper
              : selected
          }
          source={source}
          onClose={() => setViewer(false)}
        />
      )}{' '}
      {cardDraft && (
        <CardDialog
          draft={cardDraft}
          onClose={() => setCardDraft(undefined)}
          onSaved={() => setCardRevision((v) => v + 1)}
        />
      )}
    </div>
  );
}
