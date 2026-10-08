import { redirect } from "next/navigation";
import { getAllDocs } from "@/lib/docs";

export default function DocsIndexPage() {
  const docs = getAllDocs();
  redirect(`/docs/${docs[0].slug}`);
}
