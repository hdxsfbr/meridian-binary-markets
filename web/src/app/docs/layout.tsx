import type { ReactNode } from "react";
import { getAllDocs } from "@/lib/docs";
import { DocsNav } from "@/components/DocsNav";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const docs = getAllDocs();

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-8">
      <div className="flex flex-col gap-8 lg:flex-row">
        <DocsNav docs={docs} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
