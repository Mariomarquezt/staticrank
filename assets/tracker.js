(function () {
  'use strict'

  try {
    var win = window
    var nav = win.navigator || {}
    var doc = win.document
    var config = win.__mwSeoAnalytics

    if (!config || config.enabled !== true || typeof config.endpoint !== 'string' || !config.endpoint ||
        typeof config.siteId !== 'string' || !config.siteId) return
    // DNT/GPC opt-out, including legacy serializations (review B2#6):
    // Firefox/spec use '1', older Gecko/IE accepted 'yes', and pre-
    // Chromium IE/Edge exposed the flag as navigator.msDoNotTrack.
    function dntEnabled(value) {
      return value === '1' || value === 'yes'
    }
    if (dntEnabled(nav.doNotTrack) || dntEnabled(win.doNotTrack) || dntEnabled(nav.msDoNotTrack) ||
        nav.globalPrivacyControl || nav.webdriver) return

    // Keep this tiny payload logic in sync with server/lib/trackerPayload.ts.
    function widthBucket(width) {
      if (typeof width !== 'number' || !Number.isFinite(width)) return ''
      if (width < 600) return 'm'
      if (width < 1024) return 't'
      return 'd'
    }

    function referrerOrigin(referrer, pageOrigin) {
      try {
        var referrerUrl = new URL(referrer)
        var pageUrl = new URL(pageOrigin)
        if ((referrerUrl.protocol !== 'http:' && referrerUrl.protocol !== 'https:') ||
            (pageUrl.protocol !== 'http:' && pageUrl.protocol !== 'https:')) return ''
        return referrerUrl.origin === pageUrl.origin ? '' : referrerUrl.origin
      } catch (_) {
        return ''
      }
    }

    var sent = false
    function send() {
      if (sent) return
      sent = true
      try {
        var body = JSON.stringify({
          t: 'pv',
          // Pathname ONLY (review B2#4): query strings can carry emails,
          // tokens, and search terms — they never leave the page.
          u: win.location.pathname,
          r: referrerOrigin(doc.referrer || '', win.location.origin),
          w: widthBucket(win.innerWidth),
          s: config.siteId
        })
        if (typeof nav.sendBeacon === 'function') {
          try {
            if (nav.sendBeacon(config.endpoint, body) !== false) return
          } catch (_) {}
        }
        if (typeof win.fetch === 'function') {
          var request = win.fetch(config.endpoint, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'text/plain' },
            body: body
          })
          if (request && typeof request.catch === 'function') request.catch(function () {})
        }
      } catch (_) {}
    }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', send, { once: true })
    } else {
      send()
    }
  } catch (_) {}
}())
