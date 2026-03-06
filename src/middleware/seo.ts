import { getRouteMeta, BASE_URL } from "../seo";

class TitleHandler {
  private title: string;
  constructor(title: string) {
    this.title = title;
  }
  text(text: Text) {
    if (text.text.trim()) {
      text.replace(this.title);
    }
  }
}

class MetaContentHandler {
  private value: string;
  constructor(value: string) {
    this.value = value;
  }
  element(element: Element) {
    element.setAttribute("content", this.value);
  }
}

class CanonicalHandler {
  private href: string;
  constructor(href: string) {
    this.href = href;
  }
  element(element: Element) {
    element.setAttribute("href", this.href);
  }
}

export function rewriteHtmlMeta(response: Response, pathname: string): Response {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  const meta = getRouteMeta(pathname);
  const canonicalUrl = `${BASE_URL}${pathname === "/" ? "/" : pathname}`;

  return new HTMLRewriter()
    .on("title", new TitleHandler(meta.title))
    .on('meta[name="description"]', new MetaContentHandler(meta.description))
    .on(
      'meta[name="robots"]',
      new MetaContentHandler(meta.noindex ? "noindex, nofollow" : "index, follow"),
    )
    .on('meta[property="og:title"]', new MetaContentHandler(meta.title))
    .on('meta[property="og:description"]', new MetaContentHandler(meta.description))
    .on('meta[property="og:url"]', new MetaContentHandler(canonicalUrl))
    .on('meta[name="twitter:title"]', new MetaContentHandler(meta.title))
    .on('meta[name="twitter:description"]', new MetaContentHandler(meta.description))
    .on('link[rel="canonical"]', new CanonicalHandler(canonicalUrl))
    .transform(response);
}
