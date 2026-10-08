"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { DocPage } from "@/lib/docs";

type DocsNavProps = {
  docs: Array<Pick<DocPage, "slug" | "title">>;
};

/**
 * Docs page picker (REVAMP_PLAN.md Wave R4b): a sidebar list on >=1024px, a
 * select dropdown above the content on narrower screens. Both derive the
 * current page from the URL, same pattern as `Nav.tsx`.
 */
export function DocsNav({ docs }: DocsNavProps) {
  const pathname = usePathname() ?? "/docs";
  const router = useRouter();
  const currentSlug = pathname.split("/")[2];

  return (
    <>
      <nav aria-label="Documentation" className="hidden w-56 shrink-0 lg:block">
        <ul className="flex flex-col gap-1">
          {docs.map((doc) => {
            const active = doc.slug === currentSlug;
            return (
              <li key={doc.slug}>
                <Link
                  href={`/docs/${doc.slug}`}
                  aria-current={active ? "page" : undefined}
                  className={`block rounded-md px-3 py-2 text-sm ${
                    active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
                  }`}
                >
                  {doc.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mb-4 lg:hidden">
        <label htmlFor="docs-page-select" className="sr-only">
          Choose a docs page
        </label>
        <select
          id="docs-page-select"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
          value={currentSlug}
          onChange={(e) => router.push(`/docs/${e.target.value}`)}
        >
          {docs.map((doc) => (
            <option key={doc.slug} value={doc.slug}>
              {doc.title}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
