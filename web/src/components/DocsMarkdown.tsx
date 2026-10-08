import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders one docs page's markdown body with the shared design tokens
 * (REVAMP_PLAN.md Wave R4b): headings, lists, tables and code spans styled
 * to match the rest of the app; links in cyan with an underline.
 */
export function DocsMarkdown({ content }: { content: string }) {
  return (
    <div className="max-w-[720px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-4 text-2xl font-semibold text-text">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-8 mb-3 text-lg font-semibold text-text">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-6 mb-2 text-base font-semibold text-text">{children}</h3>,
          p: ({ children }) => <p className="mb-4 text-sm leading-relaxed text-text-muted">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 ml-5 list-disc space-y-1.5 text-sm text-text-muted">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-sm text-text-muted">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} className="text-cyan underline underline-offset-2 hover:text-cyan/80">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[0.85em] text-text">{children}</code>
          ),
          table: ({ children }) => (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-border text-text-muted">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-2 font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-border/60 px-3 py-2 text-text-muted">{children}</td>,
          hr: () => <hr className="my-6 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
