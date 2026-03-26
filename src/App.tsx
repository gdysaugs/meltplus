import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { Account } from './pages/Account'
import { Image } from './pages/Image'
import { Purchase } from './pages/Purchase'
import { Terms } from './pages/Terms'
import { Tokushoho } from './pages/Tokushoho'
import { Video } from './pages/Video'
import { VideoActive } from './pages/VideoActive'
import { LipSync } from './pages/LipSync'

function useAuthState() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setAuthReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  return { session, authReady }
}

function RootRouteGate() {
  const { session, authReady } = useAuthState()
  if (!authReady) return null
  if (session) return <Navigate to="/video" replace />
  return <Video />
}

function AuthRouteGate({ children }: { children: JSX.Element }) {
  const { session, authReady } = useAuthState()
  if (!authReady) return null
  if (!session) return <Navigate to="/" replace />
  return children
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRouteGate />} />
      <Route path="/video" element={<AuthRouteGate><Video /></AuthRouteGate>} />
      <Route path="/video-active" element={<AuthRouteGate><VideoActive /></AuthRouteGate>} />
      <Route path="/t2v" element={<Navigate to="/video" replace />} />
      <Route path="/lip" element={<AuthRouteGate><LipSync /></AuthRouteGate>} />
      <Route path="/image" element={<AuthRouteGate><Image /></AuthRouteGate>} />
      <Route path="/purchase" element={<AuthRouteGate><Purchase /></AuthRouteGate>} />
      <Route path="/account" element={<AuthRouteGate><Account /></AuthRouteGate>} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/tokushoho" element={<Tokushoho />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
