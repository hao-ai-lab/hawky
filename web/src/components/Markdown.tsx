// =============================================================================
// Markdown Component
//
// Renders markdown using react-markdown (battle-tested, React components)
// with remark-gfm (tables, strikethrough) and rehype-highlight (syntax
// highlighting via highlight.js).
//
// Replaces Streamdown which had Shiki loading issues in our setup.
// =============================================================================

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
// remark-breaks renders a single `\n` as a visible <br>, matching the
// "hard line break" convention used by Slack, Claude.ai, Discord, and
// every other chat UI. Without this, CommonMark's default "soft break"
// collapses single newlines into spaces, which makes lines like
// "<emoji> item 1\n<emoji> item 2" render as a single run-on paragraph.
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { useState, useCallback, useEffect, useRef } from "react";
import mermaid from "mermaid";
// highlight.js themes — light by default, dark via media query
import "highlight.js/styles/github.css";
// Import KaTeX CSS for math rendering (fonts + layout)
// NOTE: This must be imported here (not in globals.css) so Vite bundles it
import "katex/dist/katex.css";

// Initialize mermaid (theme set dynamically before each render)
mermaid.initialize({ startOnLoad: false, theme: "default" });

interface MarkdownProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
  /**
   * Safe mode: use when rendering content that is untrusted OR that might
   * accidentally collide with markdown special chars common in prose (shell
   * vars, prices, etc). Applies two defenses:
   *   - Disables the remark-math plugin so `$HOME and $PATH` in an
   *     ask_user prompt doesn't get turned into broken KaTeX, dropping the
   *     second `$` and corrupting the instruction.
   *   - Overrides the `img` component so `![...](url)` renders as a
   *     text placeholder rather than issuing a network fetch. Prevents an
   *     unsolicited tracking-pixel / SSRF leak via model-generated content.
   *
   * The regular path keeps math + images enabled — they're useful in the
   * assistant-message renderer, which is the only place tuples with
   * trusted content + math. Safe mode is opt-in for dialogs and other
   * surfaces that only need structural markdown (bold, lists, code).
   */
  safeMode?: boolean;
}

/** Copy button for code blocks */
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [code]);

  return (
    <button
      onClick={handleCopy}
      className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-2 py-1"
      title="Copy code"
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

/** Extract raw text from React children (for copy button) */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as any).props.children);
  }
  return "";
}

// Module-level SVG cache — keyed by chart+theme to invalidate on theme change
const mermaidCache = new Map<string, string>();
let mermaidIdCounter = 0;
let lastMermaidTheme = "";

/** Get current app theme from the document's dark class (not OS preference) */
function getAppTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "default";
  return document.documentElement.classList.contains("dark") ? "dark" : "default";
}

/** Ensure mermaid is configured for the current app theme. Clears cache on theme change. */
function syncMermaidTheme(): void {
  const theme = getAppTheme();
  if (theme !== lastMermaidTheme) {
    lastMermaidTheme = theme;
    mermaid.initialize({ startOnLoad: false, theme });
    // Invalidate cache — old SVGs have wrong colors
    mermaidCache.clear();
  }
}

/**
 * Post-render DOM pass: find all unprocessed mermaid code blocks inside a
 * container and replace them with rendered SVGs. This avoids React component
 * lifecycle issues (unmount/remount on parent re-render) that cause scroll jumps.
 */
function processMermaidBlocks(container: HTMLElement): void {
  syncMermaidTheme();

  const codeBlocks = container.querySelectorAll<HTMLElement>("code.language-mermaid");
  for (const code of codeBlocks) {
    const pre = code.closest("pre");
    const wrapper = pre?.closest(".code-block-container");
    const target = wrapper ?? pre;
    const htmlTarget = target as HTMLElement;
    if (!htmlTarget || htmlTarget.dataset.mermaidProcessed) continue;

    const chart = code.textContent?.trim() ?? "";
    if (!chart) continue;

    // Check cache (keyed by chart text — cleared on theme change)
    const cached = mermaidCache.get(chart);
    if (cached) {
      applyMermaidSvg(htmlTarget, cached);
      continue;
    }

    // Render async — only mark as processed on success
    const id = `mermaid-${++mermaidIdCounter}`;
    htmlTarget.dataset.mermaidProcessed = "rendering";
    mermaid.render(id, chart)
      .then(({ svg }) => {
        mermaidCache.set(chart, svg);
        applyMermaidSvg(htmlTarget, svg);
      })
      .catch((err) => {
        // Show visible error, allow retry by not marking as fully processed
        delete htmlTarget.dataset.mermaidProcessed;
        const errMsg = err instanceof Error ? err.message : String(err);
        // Replace content with error display
        htmlTarget.innerHTML = `<div class="p-3 text-xs text-red-600 dark:text-red-400 font-mono">Mermaid error: ${errMsg.replace(/</g, "&lt;")}</div>`;
        htmlTarget.className = "my-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 overflow-hidden";
        // Clean up mermaid's injected error elements
        const errorEl = document.getElementById(id);
        if (errorEl) errorEl.remove();
      });
  }
}

function applyMermaidSvg(el: HTMLElement, svg: string): void {
  el.innerHTML = svg;
  el.className = "my-3 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden";
  el.dataset.mermaidProcessed = "1";
  const svgEl = el.querySelector("svg");
  if (svgEl) {
    svgEl.style.maxWidth = "100%";
    svgEl.style.height = "auto";
    svgEl.removeAttribute("width");
  }
}

/**
 * Escape currency dollar signs when two currency amounts would be falsely
 * paired by remark-math as inline math.
 *
 * remark-math pairs two `$` as inline math delimiters, consuming the dollar
 * signs and rendering the text between them in KaTeX's math font. When both
 * dollars are currency (e.g. `$688.55, text ($625.54)` or `$10.00 and $20.00`),
 * this produces broken output.
 *
 * Detection: both `$` must be followed by a currency pattern
 * (\d[\d,]*(?:\.\d+)?[KMBkmb]? ending at a word boundary). The lazy `[^$]*?`
 * cannot cross a `$`, so it won't span a valid `$math$` pair sitting between
 * two currency amounts (e.g. `Year $2024$ costs $10 today` is left alone —
 * `$2024$` stays as math, `$10` is unpaired and renders literally).
 *
 * Known limitation: when a currency amount appears BEFORE digit-only math
 * in the same paragraph (e.g. `Costs $50, year $2024$`), the regex matches
 * `$50 ... $2024` and escapes both, so the trailing `$` is left orphaned and
 * `$2024$` no longer renders as math. Currency rendering wins over rare math
 * because the alternative (no escape) lets remark-math falsely pair the
 * dollar signs and consume both currency and prose into KaTeX. To use math
 * with digit-leading content next to currency, prefer display math `$$...$$`.
 *
 * Preserves: display math ($$), already-escaped (\$), code blocks/inline code,
 * inline math like `$2x + 3$`, `$0.5\alpha$`, `$1.5 \times 10^{23}$`.
 *
 * Also preserves: display math ($$), already-escaped (\$), code blocks/inline code.
 */
function escapeCurrencyDollars(text: string): string {
  return text.replace(
    /(```[\s\S]*?```|`[^`\n]*`)|(?<![\\$])\$\d[\d,]*(?:\.\d+)?[KMBkmb]?\b[^$]*?\$\d[\d,]*(?:\.\d+)?[KMBkmb]?\b/g,
    (match, codeBlock) => {
      if (codeBlock) return codeBlock;
      return match.replace(/\$/g, () => "\\$");
    },
  );
}

export function Markdown({ content, isStreaming = false, className, safeMode = false }: MarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Post-render: process mermaid code blocks into SVG diagrams
  useEffect(() => {
    if (!isStreaming && containerRef.current) {
      processMermaidBlocks(containerRef.current);
    }
  });

  if (!content.trim()) return null;

  return (
    <div ref={containerRef} className={`markdown-content min-w-0 break-words ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={
          safeMode
            ? [remarkGfm, remarkBreaks]
            : [remarkGfm, remarkBreaks, remarkMath]
        }
        rehypePlugins={
          safeMode
            ? [[rehypeHighlight, { detect: true, ignoreMissing: true }]]
            : [rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]
        }
        components={{
          ...(safeMode && {
            // Never fetch remote URLs from model-generated content — render
            // the image syntax as a small text placeholder so the user still
            // sees "something was here" without the network request.
            img({ alt }: any) {
              return (
                <span className="text-stone-400 dark:text-stone-500 italic text-sm">
                  [image{alt ? `: ${alt}` : ""}]
                </span>
              );
            },
          }),
          // Code blocks: wrap in container with language label + copy button
          pre({ children, ...props }) {
            const codeEl = children as any;
            const className = codeEl?.props?.className ?? "";
            const langMatch = className.match(/language-(\w+)/);
            const language = langMatch?.[1] ?? "";
            const codeText = extractText(codeEl?.props?.children);

            // Mermaid: handled by post-render DOM pass (processMermaidBlocks)

            return (
              <div className="code-block-container my-3 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-900">
                {/* Header: language + copy */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {language || "code"}
                  </span>
                  <CopyButton code={codeText} />
                </div>
                {/* Code body */}
                <pre {...props} className="p-4 overflow-x-auto text-[13px] leading-relaxed !bg-transparent !m-0">
                  {children}
                </pre>
              </div>
            );
          },
          // Inline code
          code({ children, className, ...props }) {
            // If it has a language class, it's inside a pre (handled above)
            if (className?.includes("language-")) {
              return <code className={className} {...props}>{children}</code>;
            }
            // Inline code — allow breaking long identifiers on mobile
            return (
              <code className="bg-gray-100 dark:bg-gray-800 rounded px-1 py-0.5 text-xs font-mono break-all" {...props}>
                {children}
              </code>
            );
          },
          // Links open in new tab
          a({ href, children, ...props }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-link dark:text-link-dark underline underline-offset-2" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {escapeCurrencyDollars(content)}
      </ReactMarkdown>
    </div>
  );
}
