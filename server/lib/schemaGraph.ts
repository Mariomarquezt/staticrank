/**
 * Build the small, interconnected schema.org graph used by the SEO plugin.
 *
 * This module intentionally has no imports: it is also evaluated in the
 * Instatic QuickJS-WASM sandbox (ES2020, without DOM or Node APIs).
 *
 * A graph needs at least one usable HTTP(S) URL: either `page.url`, or
 * `siteUrl` (which can also provide the base for a relative page URL). If
 * neither produces a usable URL, the function returns undefined. A site-only
 * graph contains a WebSite node; a page-only graph contains a WebPage node.
 *
 * JSON is stringified first, then every `</` in the resulting string is
 * written as `<\/`, and every `<!--` as `\\u003c!--`. These escapes are applied
 * to all JSON string values and prevent HTML script parsing from treating
 * caller-provided text as the end of the JSON-LD script (or as an old-style
 * HTML comment opener).
 */

export interface SchemaGraphInput {
  siteUrl?: string
  siteName?: string
  publisher?: {
    kind: 'organization' | 'person'
    name: string
    logoUrl?: string
    sameAs?: string[]
  }
  page: {
    url?: string
    title?: string
    description?: string
    type?: 'WebPage' | 'AboutPage' | 'ContactPage' | 'CollectionPage' | 'SearchResultsPage'
    datePublished?: string
    dateModified?: string
    imageUrl?: string
    breadcrumbs?: Array<{ name: string; url?: string }>
  }
}

interface Ref {
  '@id': string
}

interface JsonObject {
  [key: string]: unknown
}

const HTTP_URL_RE = /^https?:\/\/([^\/?#\s]+)([^\s]*)$/i
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

function validHttpUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.indexOf('\\') !== -1) return undefined
  const match = HTTP_URL_RE.exec(trimmed)
  if (!match || match[1].length === 0) return undefined
  return trimmed
}

function splitSuffix(value: string): { path: string; suffix: string } {
  const query = value.indexOf('?')
  const hash = value.indexOf('#')
  let split = -1
  if (query !== -1 && hash !== -1) split = Math.min(query, hash)
  else if (query !== -1) split = query
  else if (hash !== -1) split = hash
  return split === -1
    ? { path: value, suffix: '' }
    : { path: value.slice(0, split), suffix: value.slice(split) }
}

function baseParts(base: string): { origin: string; path: string } | undefined {
  const match = HTTP_URL_RE.exec(base)
  if (!match) return undefined
  const suffix = splitSuffix(match[2])
  const path = suffix.path.length === 0 ? '/' : suffix.path
  return { origin: base.slice(0, base.length - match[2].length), path }
}

/** Resolve a URL without relying on the DOM or the host runtime's URL class. */
function resolveUrl(value: string | undefined, base?: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const input = value.trim()
  if (input.length === 0) return undefined

  const absolute = validHttpUrl(input)
  if (absolute) return absolute
  if (!base || SCHEME_RE.test(input) || input.indexOf('\\') !== -1) return undefined

  const baseInfo = baseParts(base)
  if (!baseInfo) return undefined

  if (input.indexOf('//') === 0) {
    return validHttpUrl(base.slice(0, base.indexOf(':')) + ':' + input)
  }

  const baseWithoutSuffix = splitSuffix(baseInfo.path).path
  const relative = splitSuffix(input)
  let path: string
  if (relative.path[0] === '/') {
    path = relative.path
  } else if (relative.path.length === 0) {
    path = baseWithoutSuffix
  } else {
    const slash = baseWithoutSuffix.lastIndexOf('/')
    path = (slash === -1 ? '/' : baseWithoutSuffix.slice(0, slash + 1)) + relative.path
  }

  const segments = path.split('/')
  const normalized: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      if (segment === '' && normalized.length === 0) normalized.push('')
      continue
    }
    if (segment === '..') {
      if (normalized.length > 1) normalized.pop()
      continue
    }
    normalized.push(segment)
  }
  const normalizedPath = normalized.length === 0 || (normalized.length === 1 && normalized[0] === '') ? '/' : normalized.join('/')
  return validHttpUrl(baseInfo.origin + normalizedPath + relative.suffix)
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function isDateLike(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && ISO_DATE_RE.test(value)
}

function ref(id: string): Ref {
  return { '@id': id }
}

function image(url: string): JsonObject {
  return { '@type': 'ImageObject', url }
}

function safeJson(json: string): string {
  return json.replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--')
}

export function buildSchemaGraph(input: SchemaGraphInput): string | undefined {
  const siteUrl = resolveUrl(input.siteUrl)
  const siteBase = siteUrl ? withoutTrailingSlash(siteUrl) : undefined
  const pageUrl = resolveUrl(input.page.url, siteUrl)

  if (!siteBase && !pageUrl) return undefined

  const graph: JsonObject[] = []
  const websiteId = siteBase ? `${siteBase}/#website` : undefined
  const publisherId = siteBase && input.publisher ? `${siteBase}/#${input.publisher.kind}` : undefined

  if (websiteId) {
    const website: JsonObject = { '@type': 'WebSite', '@id': websiteId, url: siteBase }
    const name = nonEmpty(input.siteName)
    if (name !== undefined) website.name = name
    if (publisherId) website.publisher = ref(publisherId)
    graph.push(website)
  }

  if (publisherId && input.publisher) {
    const publisher: JsonObject = {
      '@type': input.publisher.kind === 'person' ? 'Person' : 'Organization',
      '@id': publisherId,
    }
    const name = nonEmpty(input.publisher.name)
    if (name !== undefined) publisher.name = name

    const logoUrl = resolveUrl(input.publisher.logoUrl, siteUrl)
    if (logoUrl) publisher.logo = image(logoUrl)

    const sameAs = input.publisher.sameAs?.filter((value) => nonEmpty(value) !== undefined)
    if (sameAs && sameAs.length > 0) publisher.sameAs = sameAs
    graph.push(publisher)
  }

  if (pageUrl) {
    const pageId = `${withoutTrailingSlash(pageUrl)}/#webpage`
    const page: JsonObject = {
      '@type': input.page.type || 'WebPage',
      '@id': pageId,
      url: pageUrl,
    }
    const title = nonEmpty(input.page.title)
    if (title !== undefined) page.name = title
    const description = nonEmpty(input.page.description)
    if (description !== undefined) page.description = description
    if (websiteId) page.isPartOf = ref(websiteId)
    if (isDateLike(input.page.datePublished)) page.datePublished = input.page.datePublished
    if (isDateLike(input.page.dateModified)) page.dateModified = input.page.dateModified

    const imageUrl = resolveUrl(input.page.imageUrl, siteUrl)
    if (imageUrl) page.primaryImageOfPage = image(imageUrl)

    const breadcrumbId = `${withoutTrailingSlash(pageUrl)}/#breadcrumb`
    const breadcrumbItems = buildBreadcrumbItems(input.page.breadcrumbs, siteUrl)
    if (breadcrumbItems.length > 0) {
      page.breadcrumb = ref(breadcrumbId)
      graph.push(page)
      graph.push({
        '@type': 'BreadcrumbList',
        '@id': breadcrumbId,
        itemListElement: breadcrumbItems,
      })
    } else {
      graph.push(page)
    }
  }

  return `<script type="application/ld+json">${safeJson(JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }))}</script>`
}

function buildBreadcrumbItems(
  breadcrumbs: Array<{ name: string; url?: string }> | undefined,
  siteUrl: string | undefined,
): JsonObject[] {
  if (!breadcrumbs) return []
  const entries: Array<{ name?: string; url?: string }> = []
  for (const breadcrumb of breadcrumbs) {
    const name = nonEmpty(breadcrumb.name)
    const url = resolveUrl(breadcrumb.url, siteUrl)
    if (name === undefined && url === undefined) continue
    entries.push({ name, url })
  }

  return entries.map((entry, index) => {
    const item: JsonObject = { '@type': 'ListItem', position: index + 1 }
    if (entry.name !== undefined) item.name = entry.name
    if (entry.url !== undefined) item.item = entry.url
    return item
  })
}
