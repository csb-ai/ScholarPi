import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  FileText,
  X,
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Paper, SourceRef } from '../../../packages/contracts';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
export default function PdfViewer({
  paper,
  source,
  onClose,
}: {
  paper?: Paper;
  source?: SourceRef;
  onClose?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState<number[]>();
  const [loading, setLoading] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(480);
  useEffect(() => {
    setDoc(undefined);
    setPage(1);
    setError('');
    if (!paper) return;
    const task = pdfjs.getDocument(
      `/api/papers/${encodeURIComponent(paper.paperId)}/pdf?revisionId=${encodeURIComponent(source?.revisionId ?? paper.revisionId)}`,
    );
    task.promise.then(setDoc).catch((e) => setError(e.message));
    return () => {
      void task.destroy();
    };
  }, [paper?.paperId, source?.revisionId ?? paper?.revisionId]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setViewportWidth(entries[0].contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [paper?.paperId]);
  useEffect(() => {
    if (source?.page) setPage(source.page);
  }, [source]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let cancelled = false;
    let render: pdfjs.RenderTask | undefined;
    setLoading(true);
    setError('');
    doc
      .getPage(page)
      .then((p) => {
        if (cancelled || !canvas.current) return;
        const natural = p.getViewport({ scale: 1 });
        const width = Math.max(240, viewportWidth - 32);
        const scale = (width / natural.width) * zoom;
        const viewport = p.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        canvas.current.width = viewport.width * ratio;
        canvas.current.height = viewport.height * ratio;
        setSize({ width: viewport.width, height: viewport.height });
        if (source?.bbox && source.page === page) {
          const b = source.bbox;
          setBox([
            b[0] * viewport.width,
            b[1] * viewport.height,
            (b[2] - b[0]) * viewport.width,
            (b[3] - b[1]) * viewport.height,
          ]);
        } else setBox(undefined);
        render = p.render({
          canvasContext: canvas.current.getContext('2d')!,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        return render.promise;
      })
      .catch((e) => {
        if (e.name !== 'RenderingCancelledException' && !cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, page, zoom, source, viewportWidth]);
  return (
    <section className="pdf-panel">
      <header className="panel-title">
        <span>
          <FileText size={16} /> 原文与证据
        </span>
        <button aria-label="关闭原文面板" onClick={onClose}>
          <X size={16} />
          关闭原文
        </button>
        {paper && (
          <a
            href={`/api/papers/${paper.paperId}/pdf?revisionId=${encodeURIComponent(source?.revisionId ?? paper.revisionId)}`}
            target="_blank"
            rel="noreferrer"
            aria-label="新窗口打开 PDF"
          >
            <ExternalLink size={15} />
          </a>
        )}
      </header>
      {paper ? (
        <>
          <div className="pdf-tools">
            <button aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={16} />
            </button>
            <label>
              物理页{' '}
              <input
                aria-label="PDF 物理页码"
                type="number"
                min={1}
                max={doc?.numPages || paper.pageCount || 1}
                value={page}
                onChange={(e) =>
                  setPage(
                    Math.min(
                      doc?.numPages || paper.pageCount || 1,
                      Math.max(1, Number(e.target.value)),
                    ),
                  )
                }
              />{' '}
              / {doc?.numPages || paper.pageCount || '—'}
            </label>
            <button
              aria-label="下一页"
              disabled={page >= (doc?.numPages || paper.pageCount)}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <div className="spacer" />
            <button
              aria-label="缩小"
              disabled={zoom <= 0.6}
              onClick={() => setZoom((v) => v - 0.2)}
            >
              <ZoomOut size={16} />
            </button>
            <button aria-label="放大" disabled={zoom >= 2} onClick={() => setZoom((v) => v + 0.2)}>
              <ZoomIn size={16} />
            </button>
          </div>
          {source && (
            <div className="source-banner">
              证据 · 第 {source.page || '—'} 页{source.quote && <span>{source.quote}</span>}
            </div>
          )}
          <div className="pdf-scroll" ref={container}>
            {loading && <div className="muted small">正在渲染原页…</div>}
            {error && <div className="error">PDF 读取失败：{error}</div>}
            <div className="pdf-page" style={size}>
              <canvas ref={canvas} style={size} />
              {box && (
                <div
                  className="pdf-highlight"
                  style={{ left: box[0], top: box[1], width: box[2], height: box[3] }}
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="empty pdf-empty">
          <FileText size={40} />
          <h3>原文始终在旁边</h3>
          <p>
            导入论文后，在这里查看 PDF。
            <br />
            点击回答中的来源可定位原页。
          </p>
        </div>
      )}
    </section>
  );
}
