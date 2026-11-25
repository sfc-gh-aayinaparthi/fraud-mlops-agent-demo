'use client';

import { FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The agent's full run report (the same content it emails). Older runs only
 * logged a subject and one-line summary, so fall back to those.
 * Raw HTML in the markdown is not rendered.
 */
export function AgentReport({ body, subject, summary }: { body?: string | null; subject?: string | null; summary?: string | null }) {
  if (!body && !subject && !summary) return <p className="text-sm text-muted-foreground">The agent hasn&rsquo;t written its report yet.</p>;
  if (!body) {
    return (
      <div className="space-y-1.5 text-sm">
        {subject && <p className="font-medium">{subject.replace(/^\[[^\]]+\]\s*/, '')}</p>}
        {summary && <p className="text-muted-foreground">{summary}</p>}
        <p className="text-xs text-muted-foreground">Only a summary was saved for this run; the full report was emailed.</p>
      </div>
    );
  }
  return (
    <div className="report text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h3 className="mb-3 text-base font-semibold">{children}</h3>,
          h2: ({ children }) => <h4 className="mb-1.5 mt-4 text-sm font-semibold">{children}</h4>,
          h3: ({ children }) => <h5 className="mb-1 mt-3 text-sm font-medium">{children}</h5>,
          p: ({ children }) => <p className="mb-2">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-brand hover:underline">{children}</a>,
          table: ({ children }) => <div className="mb-3 overflow-x-auto"><table className="w-full text-xs">{children}</table></div>,
          th: ({ children }) => <th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">{children}</th>,
          td: ({ children }) => <td className="tabular border-b border-border/50 px-2 py-1">{children}</td>,
          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>,
        }}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

export function ReportHeading() {
  return <span className="flex items-center gap-2"><FileText className="h-4 w-4 text-agent" aria-hidden />Agent report</span>;
}
