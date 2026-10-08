import { notFound } from "next/navigation";
import { getAllDocs, getDoc } from "@/lib/docs";
import { DocsMarkdown } from "@/components/DocsMarkdown";

export function generateStaticParams() {
  return getAllDocs().map((doc) => ({ slug: doc.slug }));
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (doc === undefined) {
    notFound();
  }
  return <DocsMarkdown content={doc.content} />;
}
