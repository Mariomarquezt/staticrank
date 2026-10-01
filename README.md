# Static Rank — free edition

An SEO plugin for [Instatic](https://github.com/CoreBunch/Instatic), the
self-hosted static-HTML CMS. This repository is the **free edition**, MIT
licensed. It is the whole SEO foundation: meta, sitemap, schema, analytics
and the editor panel.

Plugin id: `monkeywebs.seo`

## What it does

- **Meta engine** — per-entry title, meta description, canonical, robots,
  Open Graph and Twitter tags, baked into the published HTML at publish
  time. Title templates with `%title%` / `%site%` / `%sep%` placeholders,
  per-table defaults, and site-wide fallbacks.
- **Editor SEO panel** — live preview of the Google result, a readability
  and on-page analysis, and character counts that tell you when a title or
  description will be truncated.
- **Sitemap + robots + llms.txt**, regenerated on publish.
- **IndexNow** — pings search engines when a published page changes.
- **schema.org JSON-LD** — a `@graph` with WebSite, WebPage, Organization
  or Person, and BreadcrumbList.
- **First-party analytics** — daily page-view and 404 counts from a small
  script, no third parties, no cookies, no visitor identifiers, no IP
  storage, and Do Not Track / Global Privacy Control respected. Off by
  default.
- **Site verification tags** for Google, Bing and Pinterest.
- **Setup wizard**, dashboard widget, ⌘K commands, settings export/import.
- **Slug-move visibility** — when a page is renamed, Instatic mints the
  301 itself; this shows you what changed.

## Install

Download a release zip and upload it in your Instatic admin under
**Plugins → Upload Plugin**.

## Build from source

The Instatic plugin SDK has no published npm package yet, so the build
borrows it from an Instatic checkout:

```sh
INSTATIC=/path/to/your/Instatic scripts/build.sh lint
INSTATIC=/path/to/your/Instatic scripts/build.sh build
```

That writes `dist/` and `staticrank.plugin.zip`.

Run the tests with [Bun](https://bun.sh):

```sh
bun test
```

## Open core

There is also a **Pro** edition — a paid superset of this plugin sharing
the same plugin id, so upgrading keeps your stored data. Pro adds an MCP
server (so an AI agent can drive your SEO), a redirect manager, Search
Console integration, a site audit, a visual schema builder, AI-assisted
titles and descriptions, and full keyword analysis.

Some UI in this repository is a locked affordance for those features — it
renders, tells you it is a Pro feature, and does nothing else. That code
ships inside the free plugin by design; there is no hidden Pro logic here.

## Contributing

Issues and pull requests are welcome. Two things worth knowing:

- This repository is **generated** from a private monorepo that holds both
  editions, so a merged pull request is ported by hand rather than merged
  directly into that tree. Your commit authorship is preserved in the
  port. Please keep pull requests focused — it makes porting reliable.
- The plugin id `monkeywebs.seo` is frozen. Installed sites key all their
  stored data to it, so it can never change.

## Licence

MIT — see [LICENSE](LICENSE).
