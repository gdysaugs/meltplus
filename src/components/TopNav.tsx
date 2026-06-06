import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { NavLink } from 'react-router-dom'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
const OAUTH_STATE_KEY = 'meltplus_oauth_state'

const createOAuthState = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const setStoredOAuthState = (value: string) => {
  try {
    window.sessionStorage.setItem(OAUTH_STATE_KEY, value)
  } catch {
    // no-op
  }
}

const getStoredOAuthState = () => {
  try {
    return window.sessionStorage.getItem(OAUTH_STATE_KEY) ?? ''
  } catch {
    return ''
  }
}

const clearStoredOAuthState = () => {
  try {
    window.sessionStorage.removeItem(OAUTH_STATE_KEY)
  } catch {
    // no-op
  }
}

const clearOAuthCallbackParams = (url: URL) => {
  url.hash = ''
  url.searchParams.delete('auth_callback')
  url.searchParams.delete('oauth_state')
}

type TopNavProps = {
  hideGuestAuthButton?: boolean
}

export function TopNav({ hideGuestAuthButton = false }: TopNavProps = {}) {
  const [session, setSession] = useState<Session | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(!supabase)

  useEffect(() => {
    if (!supabase) {
      setIsAuthReady(true)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setIsAuthReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setIsAuthReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || typeof window === 'undefined') return

    const rawHash = window.location.hash
    if (!rawHash || !rawHash.includes('access_token=')) return

    const hashParams = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash)
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')
    if (!accessToken || !refreshToken) return

    const callbackUrl = new URL(window.location.href)
    const isAuthCallback = callbackUrl.searchParams.get('auth_callback') === '1'
    const callbackState = callbackUrl.searchParams.get('oauth_state') ?? ''
    const storedState = getStoredOAuthState()
    if (!isAuthCallback || !callbackState || !storedState || callbackState !== storedState) {
      clearOAuthCallbackParams(callbackUrl)
      window.history.replaceState({}, document.title, callbackUrl.toString())
      return
    }

    clearStoredOAuthState()

    let isCancelled = false
    void supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error || isCancelled) return
        const url = new URL(window.location.href)
        clearOAuthCallbackParams(url)
        window.history.replaceState({}, document.title, url.toString())
      })
      .catch(() => {
        // no-op: onAuthStateChange/getSession already handles auth status display.
      })

    return () => {
      isCancelled = true
    }
  }, [])

  const handleGoogleSignIn = useCallback(async () => {
    if (!supabase || !isAuthConfigured) {
      window.alert('\u8a8d\u8a3c\u8a2d\u5b9a\u304c\u672a\u5b8c\u4e86\u3067\u3059\u3002')
      return
    }

    const oauthState = createOAuthState()
    const redirectUrl = new URL(OAUTH_REDIRECT_URL ?? window.location.origin, window.location.origin)
    redirectUrl.searchParams.set('auth_callback', '1')
    redirectUrl.searchParams.set('oauth_state', oauthState)
    setStoredOAuthState(oauthState)

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl.toString(), skipBrowserRedirect: true },
    })

    if (error) {
      clearStoredOAuthState()
      window.alert(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    clearStoredOAuthState()
    window.alert('\u8a8d\u8a3cURL\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002')
  }, [])

  const isLoggedIn = Boolean(session)
  const showGuestHeader = isAuthReady && !isLoggedIn
  const homePath = showGuestHeader ? '/' : '/video'

  return (
    <header className={`top-nav${showGuestHeader ? ' top-nav--guest' : ''}`}>
      <div className="top-nav__brand">
        <img className="top-nav__logo" src="/favicon.png" alt="" aria-hidden="true" />
        <NavLink className="top-nav__title" to={homePath}>
          MeltPlus
        </NavLink>
      </div>
      {showGuestHeader ? (
        <div className="top-nav__guest-center">
          <p className="top-nav__guest-copy">{'\u30a2\u30ab\u30a6\u30f3\u30c8\u3092\u4f5c\u6210\u3057\u3066\u7121\u6599\u3067\u59cb\u3081\u307e\u3057\u3087\u3046'}</p>
          {!hideGuestAuthButton && (
            <button type="button" className="top-nav__auth-button" onClick={handleGoogleSignIn}>
              {'\u30b5\u30a4\u30f3\u30a2\u30c3\u30d7/\u30ed\u30b0\u30a4\u30f3'}
            </button>
          )}
        </div>
      ) : (
        <nav className="top-nav__links">
          <NavLink to="/video" className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
            I2V
          </NavLink>
          <NavLink to="/image" className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
            I2I
          </NavLink>
          <NavLink to="/sound" className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
            Sound
          </NavLink>
          <NavLink to="/purchase" className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`}>
            {'\u30b9\u30c8\u30a2'}
          </NavLink>
        </nav>
      )}
    </header>
  )
}
