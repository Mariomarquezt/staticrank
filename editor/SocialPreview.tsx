/**
 * Social share previews (task 3.4, Pro) — visual Facebook and X (large
 * summary) share cards for the editor panel. Standalone component: the
 * panel mounts it at a marked slot; it imports NOTHING from SeoPanel.
 *
 * Resolution parity: all fallback logic (og override → resolved value,
 * site-relative og:image → configured origin) lives in the PURE module
 * editor/lib/socialPreview.ts, which reuses the server's own
 * `resolveAbsoluteUrl`/`normalizeSiteOrigin` — the cards can never show
 * an image or title the head bake would not emit.
 *
 * Rendering: CSS-only platform mockups (no external assets — CSP +
 * zip-only rule). Like the SERP preview card (SeoPanel.tsx), the cards
 * render on fixed literal-color surfaces ON PURPOSE — they depict
 * Facebook / X, not the admin theme, so no theme tokens here. The
 * surrounding chrome (headings, hints) uses the host design system
 * exactly like the rest of the panel.
 *
 * Free tier: the whole section is the shared locked-in-place ProLock
 * affordance (DESIGN §3.4 / §3.3 rule 6) — same pattern as the panel's
 * other Pro teasers.
 */
import { Stack, Text } from '@instatic/host-ui'
import { ProLock } from '../admin/ProLock'
import { missingImageHint, resolveSocialCard, type SocialCard } from './lib/socialPreview'

export interface SocialPreviewProps {
  proUnlocked: boolean
  // The panel's current form values + merged fallbacks, same inputs the SERP preview uses:
  title: string          // resolved display title (post-fallback)
  description: string    // resolved description (post-fallback)
  ogTitle?: string       // stored og override, if any
  ogDescription?: string
  ogImage?: string       // absolute or site-relative URL, may be empty
  siteUrl: string        // bare origin ('' when unconfigured)
  slug: string
  siteName: string
}

// ---------------------------------------------------------------------------
// Shared card pieces (literal platform colors — see header comment)
// ---------------------------------------------------------------------------

const CARD_MAX_WIDTH = 500

/**
 * 1.91:1 image area (the og:image ratio both platforms crop to). Renders
 * the resolved og:image via <img>, or a graceful no-image placeholder.
 * `paddingTop` percentage keeps the ratio without any script.
 */
function CardImage({ imageUrl, rounded }: { imageUrl: string | null; rounded: boolean }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        paddingTop: `${(100 / 1.91).toFixed(4)}%`, // 1.91:1
        background: '#e4e6eb',
        borderTopLeftRadius: rounded ? 15 : 0,
        borderTopRightRadius: rounded ? 15 : 0,
        overflow: 'hidden',
      }}
    >
      {imageUrl !== null ? (
        <img
          src={imageUrl}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#8a8d91',
            fontSize: 13,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          No share image set
        </div>
      )}
    </div>
  )
}

function FacebookCard({ card }: { card: SocialCard }) {
  return (
    <div
      style={{
        maxWidth: CARD_MAX_WIDTH,
        border: '1px solid #dddfe2',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#ffffff',
        fontFamily: 'Helvetica, Arial, sans-serif',
      }}
    >
      <CardImage imageUrl={card.imageUrl} rounded={false} />
      <div style={{ background: '#f0f2f5', padding: '10px 12px' }}>
        <div
          style={{
            color: '#606770',
            fontSize: 12,
            lineHeight: '16px',
            textTransform: 'uppercase',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.host !== '' ? card.host : 'example.com'}
        </div>
        <div
          style={{
            color: '#1c1e21',
            fontSize: 16,
            fontWeight: 600,
            lineHeight: '20px',
            marginTop: 3,
          }}
        >
          {card.fbTitle}
        </div>
        {card.fbDescription !== '' ? (
          <div style={{ color: '#606770', fontSize: 14, lineHeight: '18px', marginTop: 3 }}>
            {card.fbDescription}
          </div>
        ) : (
          <div style={{ color: '#8a8d91', fontSize: 13, lineHeight: '18px', marginTop: 3 }}>
            No description — Facebook may pull its own text.
          </div>
        )}
      </div>
    </div>
  )
}

function XCard({ card }: { card: SocialCard }) {
  return (
    <div
      style={{
        maxWidth: CARD_MAX_WIDTH,
        border: '1px solid #cfd9de',
        borderRadius: 16,
        overflow: 'hidden',
        background: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <CardImage imageUrl={card.imageUrl} rounded />
      <div style={{ padding: '10px 12px', borderTop: '1px solid #cfd9de' }}>
        <div
          style={{
            color: '#536471',
            fontSize: 13,
            lineHeight: '17px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.host !== '' ? card.host : 'example.com'}
        </div>
        <div style={{ color: '#0f1419', fontSize: 15, lineHeight: '19px', marginTop: 2 }}>
          {card.xTitle}
        </div>
        {card.xDescription !== '' ? (
          <div style={{ color: '#536471', fontSize: 14, lineHeight: '18px', marginTop: 2 }}>
            {card.xDescription}
          </div>
        ) : (
          <div style={{ color: '#8b98a5', fontSize: 13, lineHeight: '18px', marginTop: 2 }}>
            No description — X may show the card without one.
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function SocialPreviews(props: SocialPreviewProps): JSX.Element {
  if (!props.proUnlocked) {
    // §3.4 locked-in-place affordance — shared component, shared copy shape.
    return (
      <ProLock action="Social previews" benefit="visual Facebook and X share previews." />
    )
  }

  const card = resolveSocialCard({
    title: props.title,
    description: props.description,
    ogTitle: props.ogTitle,
    ogDescription: props.ogDescription,
    ogImage: props.ogImage,
    siteUrl: props.siteUrl,
  })

  return (
    <Stack gap={12}>
      <Stack gap={4}>
        <Text variant="strong">Social previews</Text>
        <Text variant="muted" size="sm">
          How this page's link unfurls when shared. Approximate — platforms clip
          by rendered width, not characters.
        </Text>
      </Stack>
      <Stack gap={4}>
        <Text variant="muted" size="sm">
          Facebook
        </Text>
        <FacebookCard card={card} />
      </Stack>
      <Stack gap={4}>
        <Text variant="muted" size="sm">
          X
        </Text>
        <XCard card={card} />
      </Stack>
      {/* Classified no-image copy: the site-URL hint ONLY when a Site URL
          would actually fix it (single-slash site-relative path + missing/
          invalid origin); every other unresolvable value gets a neutral
          line — pointing those at settings would mislead. */}
      {missingImageHint(props.ogImage, props.siteUrl) === 'needs-site-url' && (
        <Text variant="muted" size="sm">
          The stored share image is site-relative and no site URL is configured, so
          publish will not emit it.
        </Text>
      )}
      {missingImageHint(props.ogImage, props.siteUrl) === 'unpreviewable' && (
        <Text variant="muted" size="sm">
          Share image URL can't be previewed — publish will not emit it.
        </Text>
      )}
    </Stack>
  )
}
