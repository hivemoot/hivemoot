"use client";

import { createContext, useContext } from "react";
import Markdown, { type ExtraProps } from "react-markdown";

const InPre = createContext(false);

function MdPre({ children }: React.ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  return (
    <InPre.Provider value={true}>
      <pre className="my-2.5 overflow-x-auto rounded-lg bg-black/40 p-3.5 text-[13px] leading-relaxed">{children}</pre>
    </InPre.Provider>
  );
}

function MdCode({ className, children }: React.ComponentPropsWithoutRef<"code"> & ExtraProps) {
  const inPre = useContext(InPre);
  if (inPre) {
    return <code className={`${className ?? ""} font-mono text-[13px]`}>{children}</code>;
  }
  return <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

export function MarkdownContent({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`text-sm leading-relaxed text-zinc-300 ${className ?? ""}`}>
      <Markdown
        components={{
          h1: ({ children: c }) => <h1 className="mb-2 mt-4 text-base font-bold text-[#fafafa]">{c}</h1>,
          h2: ({ children: c }) => <h2 className="mb-1.5 mt-3 text-sm font-bold text-[#fafafa]">{c}</h2>,
          h3: ({ children: c }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-200">{c}</h3>,
          p: ({ children: c }) => <p className="my-1.5">{c}</p>,
          ul: ({ children: c }) => <ul className="my-1.5 ml-5 list-disc">{c}</ul>,
          ol: ({ children: c }) => <ol className="my-1.5 ml-5 list-decimal">{c}</ol>,
          li: ({ children: c }) => <li className="mt-0.5">{c}</li>,
          code: MdCode,
          pre: MdPre,
          a: ({ href, children: c }) => (
            <a href={href} className="text-honey-500 hover:underline" target="_blank" rel="noopener noreferrer">{c}</a>
          ),
          strong: ({ children: c }) => <strong className="font-semibold text-[#fafafa]">{c}</strong>,
          em: ({ children: c }) => <em className="italic text-zinc-400">{c}</em>,
          blockquote: ({ children: c }) => (
            <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 italic text-zinc-500">{c}</blockquote>
          ),
          hr: () => <hr className="my-3 border-white/10" />,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
