/**
 * Docs tab (REVAMP_PLAN.md Wave R4b): reads the markdown files under
 * `web/content/docs/` at build time. Server-only (uses `node:fs`), so this
 * module must only be imported from server components.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export type DocPage = {
  slug: string;
  title: string;
  order: number;
  content: string;
};

const DOCS_DIR = path.join(process.cwd(), "content", "docs");

function readDoc(slug: string): DocPage {
  const raw = fs.readFileSync(path.join(DOCS_DIR, `${slug}.md`), "utf8");
  const { data, content } = matter(raw);
  return {
    slug,
    title: typeof data.title === "string" ? data.title : slug,
    order: typeof data.order === "number" ? data.order : 0,
    content,
  };
}

/** All doc pages, sorted by their `order` front-matter field. */
export function getAllDocs(): DocPage[] {
  const slugs = fs
    .readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));
  return slugs.map(readDoc).sort((a, b) => a.order - b.order);
}

export function getDoc(slug: string): DocPage | undefined {
  try {
    return readDoc(slug);
  } catch {
    return undefined;
  }
}
