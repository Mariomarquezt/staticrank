/**
 * pageUrl — the ONE (siteOrigin, slug) → absolute page URL mapping (task
 * 2.3 review finding: the sitemap builder and the schema.org wiring must
 * never disagree about a page's URL, so both consume this module).
 *
 * No imports: evaluated in the Instatic QuickJS-WASM sandbox (ES2020,
 * no DOM/Node APIs) and unit-tested under plain `bun test`.
 *
 * Contract (mirrors the host's slug → route mapping):
 * - The host maps slug `index` to `/` and every other page to `/<slug>`
 *   (vendor server/publish/publishSite.ts:
 *   `page.slug === 'index' ? '/' : '/' + page.slug`).
 * - Nested slugs keep their `/` separators; every SEGMENT is
 *   percent-encoded defensively (stored slugs are storage data).
 * - `siteOrigin` must already be a normalized bare origin without a
 *   trailing slash (seo-config validation + `normalizeSiteOrigin`
 *   guarantee it); this module never re-validates it.
 */

/** Absolute public URL for a page slug (index slug → site root). */
export function pageUrl(siteOrigin: string, slug: string): string {
  if (slug === 'index') return `${siteOrigin}/`
  const path = slug
    .split('/')
    .map((segment) => encodePathSegment(segment))
    .join('/')
  return `${siteOrigin}/${path}`
}

/** Replace only unpaired UTF-16 surrogates before URI encoding. */
function replaceLoneSurrogates(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2)
        index++
      } else {
        result += '\uFFFD'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\uFFFD'
    } else {
      result += value.charAt(index)
    }
  }
  return result
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(replaceLoneSurrogates(segment))
}

/**
 * Human label for one slug path segment: `-`/`_` runs become spaces,
 * surrounding whitespace is trimmed, and each word is capitalized
 * (`case-studies` → `Case Studies`). Falls back to the raw segment when
 * prettifying produces an empty string.
 */
export function prettifySegment(segment: string): string {
  const pretty = segment
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/(?:^|\s)\S/g, (ch) => ch.toUpperCase())
  return pretty === '' ? segment : pretty
}

/**
 * Breadcrumb trail for a page slug (feeds BreadcrumbList in the schema
 * graph — buildSchemaGraph escapes/validates every URL again itself):
 *
 *   - Home (name "Home", url = site root) …
 *   - one crumb per INTERMEDIATE path segment (name = prettified
 *     segment, url = cumulative encoded path) …
 *   - the current page (name = `pageTitle`, falling back to the
 *     prettified last segment; NO url — schema.org convention for the
 *     current item).
 *
 * The `index` slug (the site root itself) yields a single unlinked crumb
 * (`pageTitle` falling back to "Home") — the page IS Home, so a linked
 * Home crumb would just self-reference.
 */
export function slugBreadcrumbs(
  siteOrigin: string,
  slug: string,
  pageTitle?: string,
): Array<{ name: string; url?: string }> {
  const segments = slug === 'index' ? [] : slug.split('/').filter((s) => s !== '')
  if (segments.length === 0) {
    return [{ name: pageTitle !== undefined && pageTitle !== '' ? pageTitle : 'Home' }]
  }
  const crumbs: Array<{ name: string; url?: string }> = [
    { name: 'Home', url: `${siteOrigin}/` },
  ]
  let path = ''
  for (const segment of segments.slice(0, -1)) {
    path += `/${encodePathSegment(segment)}`
    crumbs.push({ name: prettifySegment(segment), url: `${siteOrigin}${path}` })
  }
  const last = segments[segments.length - 1]!
  crumbs.push({
    name: pageTitle !== undefined && pageTitle !== '' ? pageTitle : prettifySegment(last),
  })
  return crumbs
}
