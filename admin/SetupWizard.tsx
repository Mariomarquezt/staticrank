/**
 * Setup wizard (task 2.6) — the guided flow inside the SEO Settings admin
 * app. Auto-shown by the settings app while setup is incomplete (no
 * stored siteUrl — admin/lib/wizard.ts), dismissible, and revisitable via
 * the "Setup guide" button.
 *
 * The wizard owns NO save path of its own: every step edits the SAME
 * ConfigFormState the settings tabs edit and saves through the EXISTING
 * dirty-merge machinery (`save()` from settings.tsx — refetch, merge only
 * dirty entries, POST the modeled sections explicitly). "Continue" saves
 * when the form is dirty and just advances when it isn't, so skipping a
 * step writes nothing.
 *
 * The finish step's mini-audit is pure client logic over the STORED
 * config document (buildSetupAudit) plus one published-state hint from an
 * existing route: a GET of the plugin's own public /sitemap.xml (which
 * 404s with a hint until siteUrl is set AND the site has published pages
 * — server/index.ts). Pro teasers per DESIGN §3.4 ride the audit items.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Code,
  Heading,
  Input,
  Separator,
  Stack,
  Switch,
  Text,
} from '@instatic/host-ui'
import type { SeoConfigData } from '../server/seoConfig'
import {
  PRO_TEASERS,
  WIZARD_STEPS,
  buildSetupAudit,
  isConfigComplete,
  nextStep,
  prevStep,
  runtimeDocUrls,
  stepIndex,
  type WizardStepId,
} from './lib/wizard'
import { previewTemplate, type ConfigFormState } from './lib/configForm'

export interface SetupWizardProps {
  pluginId: string
  form: ConfigFormState
  fieldErrors: Record<string, string>
  dirty: boolean
  saving: boolean
  /** The freshly-stored config document (updated after every save). */
  storedConfig: SeoConfigData
  updateForm: (patch: Partial<ConfigFormState>) => void
  /** The settings app's dirty-merge save. Resolves true on success. */
  save: () => Promise<boolean>
  /** Fetch against the plugin's runtime routes (finish-step hint). */
  fetchRoute: (path: string) => Promise<Response>
  onClose: () => void
}

type SitemapHint = 'checking' | 'serving' | 'pending'

function StepDots({ current }: { current: WizardStepId }) {
  const index = stepIndex(current)
  return (
    <Text variant="muted" size="sm">
      Step {index + 1} of {WIZARD_STEPS.length} — {WIZARD_STEPS[index]!.title}
    </Text>
  )
}

export function SetupWizard(props: SetupWizardProps) {
  const [step, setStep] = useState<WizardStepId>('basics')
  const [stepError, setStepError] = useState<string | null>(null)
  const [sitemapHint, setSitemapHint] = useState<SitemapHint>('checking')

  // Finish-step published-state hint — one read of the plugin's own
  // public sitemap route; failures degrade to 'pending' (never blocks).
  const fetchRouteRef = useRef(props.fetchRoute)
  fetchRouteRef.current = props.fetchRoute
  useEffect(() => {
    if (step !== 'finish') return
    let cancelled = false
    setSitemapHint('checking')
    void fetchRouteRef.current('/sitemap.xml')
      .then((res) => {
        if (!cancelled) setSitemapHint(res.ok ? 'serving' : 'pending')
      })
      .catch(() => {
        if (!cancelled) setSitemapHint('pending')
      })
  }, [step])

  async function continueFrom(current: WizardStepId): Promise<void> {
    setStepError(null)
    if (props.dirty) {
      const ok = await props.save()
      if (!ok) {
        setStepError('Fix the highlighted fields to continue.')
        return
      }
    }
    const next = nextStep(current)
    if (next !== null) setStep(next)
  }

  const err = (field: string): string | undefined => props.fieldErrors[field]
  const urls = runtimeDocUrls(props.pluginId, props.storedConfig)

  return (
    <Card>
      <Stack gap={16}>
        <Stack gap={8} direction="row" align="center" justify="between">
          <Heading level={2}>Setup guide</Heading>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            Close
          </Button>
        </Stack>
        <StepDots current={step} />

        {step === 'basics' && (
          <Stack gap={12}>
            <Text variant="muted">
              The essentials every other feature builds on. Only the site URL is required —
              canonicals, the sitemap, and IndexNow need it.
            </Text>
            <Input
              label="Site URL"
              type="url"
              value={props.form.siteUrl}
              placeholder="https://example.com"
              invalid={err('site.siteUrl') !== undefined}
              description={err('site.siteUrl') ?? 'Bare origin only (no path).'}
              onChange={(value) => props.updateForm({ siteUrl: value })}
            />
            <Input
              label="Site name"
              value={props.form.siteName}
              placeholder="Acme Inc."
              invalid={err('site.siteName') !== undefined}
              description={err('site.siteName') ?? 'Feeds %site% in title templates.'}
              onChange={(value) => props.updateForm({ siteName: value })}
            />
            <Input
              label="Title separator"
              value={props.form.separator}
              placeholder="-"
              invalid={err('site.separator') !== undefined}
              description={err('site.separator') ?? 'Feeds %sep% in title templates.'}
              onChange={(value) => props.updateForm({ separator: value })}
            />
          </Stack>
        )}

        {step === 'titles' && (
          <Stack gap={12}>
            <Text variant="muted">
              How page titles render in search results. Per-entry SEO titles always win; this
              template shapes everything else.
            </Text>
            <Input
              label="Site title template"
              value={props.form.siteTitleTemplate}
              placeholder="%title% %sep% %site%"
              invalid={err('site.titleTemplate') !== undefined}
              description={
                err('site.titleTemplate') ?? 'Variables: %title%, %site%, %sep%, %slug%.'
              }
              onChange={(value) => props.updateForm({ siteTitleTemplate: value })}
            />
            {previewTemplate(props.form.siteTitleTemplate, props.form) !== '' && (
              <Text variant="muted" size="sm">
                Sample: {previewTemplate(props.form.siteTitleTemplate, props.form)}
              </Text>
            )}
            <Text variant="muted" size="sm">
              Per-table templates live in Settings → Titles.
            </Text>
          </Stack>
        )}

        {step === 'indexing' && (
          <Stack gap={12}>
            <Switch
              label="IndexNow instant indexing"
              checked={props.form.indexNowEnabled}
              description="Notify search engines (Bing, Yandex, …) when published pages change."
              onChange={(next) => props.updateForm({ indexNowEnabled: next })}
            />
            <Separator />
            <Text variant="strong">Your sitemap and llms.txt</Text>
            <Text variant="muted" size="sm">
              Served by the plugin — submit the sitemap URL in the search consoles
              {urls.absolute ? ':' : ' (shown relative until the Site URL is saved):'}
            </Text>
            <Code>{urls.sitemap}</Code>
            <Code>{urls.llmsTxt}</Code>
          </Stack>
        )}

        {step === 'verification' && (
          <Stack gap={12}>
            <Text variant="muted">
              Optional — only needed to claim the site in each console. Paste the bare token or
              the full &lt;meta&gt; tag; it is stripped to the token.
            </Text>
            <Input
              label="Google Search Console"
              value={props.form.verificationGoogle}
              placeholder='Token or <meta name="google-site-verification" …>'
              invalid={err('verification.google') !== undefined}
              description={err('verification.google')}
              onChange={(value) => props.updateForm({ verificationGoogle: value })}
            />
            <Input
              label="Bing Webmaster Tools"
              value={props.form.verificationBing}
              placeholder='Token or <meta name="msvalidate.01" …>'
              invalid={err('verification.bing') !== undefined}
              description={err('verification.bing')}
              onChange={(value) => props.updateForm({ verificationBing: value })}
            />
            <Input
              label="Pinterest"
              value={props.form.verificationPinterest}
              placeholder='Token or <meta name="p:domain_verify" …>'
              invalid={err('verification.pinterest') !== undefined}
              description={err('verification.pinterest')}
              onChange={(value) => props.updateForm({ verificationPinterest: value })}
            />
          </Stack>
        )}

        {step === 'analytics' && (
          <Stack gap={12}>
            <Switch
              label="First-party page-view counts"
              checked={props.form.analyticsEnabled}
              description="Counts page views and 404 hits with a small first-party script — no third-party services."
              onChange={(next) => props.updateForm({ analyticsEnabled: next })}
            />
            <Text variant="muted" size="sm">
              Privacy: daily per-path counts only — no cookies, no visitor identifiers, no IP
              storage, query strings never leave the page, and Do&nbsp;Not&nbsp;Track /
              Global Privacy Control browsers are never counted. Off by default.
            </Text>
          </Stack>
        )}

        {step === 'finish' && (
          <Stack gap={12}>
            <Text variant="strong">Setup summary</Text>
            {buildSetupAudit(props.storedConfig).map((item) => (
              <Stack key={item.id} gap={2}>
                <Stack gap={6} direction="row" align="center">
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      flexShrink: 0,
                      textAlign: 'center',
                      color: item.ok ? 'var(--success-text)' : 'var(--warning-text)',
                    }}
                  >
                    {item.ok ? '✓' : '•'}
                  </span>
                  <Text size="sm">{item.label}</Text>
                </Stack>
                <Text variant="muted" size="sm">
                  {item.detail}
                  {item.pro !== undefined ? ` ${item.pro}` : ''}
                </Text>
              </Stack>
            ))}
            <Text variant="muted" size="sm">
              {/* C#1: "configured" vs "serving" — the sitemap route also 404s
                  until the site has published pages, and publish state is not
                  cheaply observable here, so the config-complete branch is
                  phrased conditionally. */}
              Sitemap:{' '}
              {sitemapHint === 'checking'
                ? 'checking…'
                : sitemapHint === 'serving'
                  ? 'serving — search engines can fetch it.'
                  : isConfigComplete(props.storedConfig)
                    ? 'configured but not serving yet — it appears once the site is published.'
                    : 'not serving — it needs the Site URL saved first, then a published site.'}
            </Text>
            <Separator />
            <Text variant="muted" size="sm">
              {PRO_TEASERS.audit}
            </Text>
          </Stack>
        )}

        {stepError !== null && (
          <Alert tone="danger" title="Could not continue">
            {stepError}
          </Alert>
        )}

        <Separator />
        <Stack gap={8} direction="row" align="center">
          {prevStep(step) !== null && (
            <Button
              variant="secondary"
              size="sm"
              disabled={props.saving}
              onClick={() => {
                setStepError(null)
                setStep(prevStep(step)!)
              }}
            >
              Back
            </Button>
          )}
          {step !== 'finish' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={props.saving}
              onClick={() => void continueFrom(step)}
            >
              {props.saving ? 'Saving…' : props.dirty ? 'Save & continue' : 'Continue'}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={props.onClose}>
              Done
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  )
}
