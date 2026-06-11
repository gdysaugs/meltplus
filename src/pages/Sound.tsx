import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { Session } from '@supabase/supabase-js'
import { TopNav } from '../components/TopNav'
import { supabase } from '../lib/supabaseClient'
import './camera.css'
import './video-studio.css'
import './sound.css'

const API_ENDPOINT = '/api/sound'
const MAX_PROMPT_LENGTH = 300
const MAX_VIDEO_SECONDS = 10
const TICKET_COST = 1
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type AudioMode = 'mode1' | 'mode2'

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('動画の読み込みに失敗しました。'))
    reader.readAsDataURL(file)
  })

type VideoMetadata = {
  duration: number
  width: number
  height: number
}

const readVideoMetadata = (file: File) =>
  new Promise<VideoMetadata>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: Number.isFinite(video.videoWidth) ? video.videoWidth : 0,
        height: Number.isFinite(video.videoHeight) ? video.videoHeight : 0,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('動画の長さを確認できませんでした。'))
    }
    video.src = url
  })

const normalizeVideo = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  const ext = filename?.split('.').pop()?.toLowerCase()
  const mime = ext === 'webm' ? 'video/webm' : 'video/mp4'
  return `data:${mime};base64,${value}`
}

const extractVideo = (payload: any) => {
  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
  ]
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    const direct = root.video || root.video_base64 || root.output_base64
    const normalized = normalizeVideo(direct, root.output_filename)
    if (normalized) return normalized

    for (const key of ['videos', 'outputs', 'output_videos', 'images']) {
      const list = root[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const itemVideo = normalizeVideo(item?.video ?? item?.data ?? item?.url ?? item, item?.filename)
        if (itemVideo) return itemVideo
      }
    }
  }
  return null
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id
const extractPipelineUsageId = (payload: any) => payload?.pipeline_usage_id || payload?.pipelineUsageId || ''

const inferVideoExt = (source: string) => {
  if (source.startsWith('data:video/webm')) return '.webm'
  if (source.startsWith('data:video/quicktime')) return '.mov'
  if (source.startsWith('data:video/x-matroska')) return '.mkv'
  return '.mp4'
}

const extractErrorMessage = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.detail ||
  payload?.output?.error ||
  payload?.result?.error ||
  payload?.output?.message ||
  payload?.result?.message

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel') || normalized.includes('timeout')
}

const mapStatusText = (status: string) => {
  const normalized = status.toUpperCase()
  if (normalized.includes('COMPLETED')) return '生成が完了しました。'
  if (normalized.includes('IN_QUEUE') || normalized.includes('QUEUED')) return '音声付き動画を生成しています'
  if (normalized.includes('IN_PROGRESS') || normalized.includes('PROCESS')) return '音声付き動画を生成しています'
  if (isFailureStatus(normalized)) return '生成に失敗しました。'
  return '音声付き動画を生成しています'
}

const isTicketShortage = (status: number, message: string) => {
  if (status === 402) return true
  const lowered = message.toLowerCase()
  return lowered.includes('no ticket') || lowered.includes('insufficient') || lowered.includes('credit')
}

export function Sound() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')

  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourceBase64, setSourceBase64] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [sourceExt, setSourceExt] = useState('.mp4')
  const [sourceDuration, setSourceDuration] = useState<number | null>(null)
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [audioMode, setAudioMode] = useState<AudioMode>('mode1')

  const [resultVideo, setResultVideo] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)

  const previewUrlRef = useRef<string | null>(null)
  const runIdRef = useRef(0)
  const accessToken = session?.access_token ?? ''

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

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
    },
    [],
  )

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return
    setTicketStatus('loading')
    setTicketMessage('')
    const res = await fetch('/api/tickets', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'クレジット情報の取得に失敗しました。')
      setTicketCount(null)
      return
    }
    setTicketStatus('idle')
    setTicketCount(Number(data?.tickets ?? 0))
  }, [])

  useEffect(() => {
    if (!accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets])

  const resetSource = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setSourcePreview(null)
    setSourceBase64('')
    setSourceName('')
    setSourceExt('.mp4')
    setSourceDuration(null)
    setSourceSize(null)
  }, [])

  const handleVideoChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return

      setErrorMessage('')
      setStatusMessage('')
      setResultVideo(null)

      try {
        const metadata = await readVideoMetadata(file)
        if (metadata.duration > MAX_VIDEO_SECONDS + 0.25) {
          resetSource()
          setErrorMessage(`動画は${MAX_VIDEO_SECONDS}秒以内にしてください。`)
          return
        }

        const dataUrl = await readFileAsDataUrl(file)
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        const previewUrl = URL.createObjectURL(file)
        previewUrlRef.current = previewUrl

        const extMatch = file.name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)
        setSourcePreview(previewUrl)
        setSourceBase64(toBase64(dataUrl))
        setSourceName(file.name)
        setSourceExt(extMatch ? `.${extMatch[1]}` : '.mp4')
        setSourceDuration(metadata.duration)
        setSourceSize(metadata.width > 0 && metadata.height > 0 ? { width: metadata.width, height: metadata.height } : null)
      } catch (error) {
        resetSource()
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    },
    [resetSource],
  )

  const canGenerate = useMemo(
    () => Boolean(sourceBase64 && prompt.trim() && prompt.trim().length <= MAX_PROMPT_LENGTH && accessToken && !isRunning),
    [accessToken, isRunning, prompt, sourceBase64],
  )

  const previewStyle = useMemo(
    () =>
      ({
        '--studio-aspect': sourceSize ? `${sourceSize.width} / ${sourceSize.height}` : '16 / 9',
      }) as CSSProperties,
    [sourceSize],
  )

  const pollJob = useCallback(
    async (jobId: string, runId: number, token: string, mode: AudioMode) => {
      for (let i = 0; i < 180; i += 1) {
        if (runIdRef.current !== runId) return null
        const params = new URLSearchParams({
          id: jobId,
          mode,
        })
        const res = await fetch(`${API_ENDPOINT}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(extractErrorMessage(data) || 'ステータス確認に失敗しました。')

        const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
        if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

        const video = extractVideo(data)
        if (video) {
          return {
            video,
            pipelineUsageId: String(extractPipelineUsageId(data) || `audio:${jobId}`),
          }
        }

        const status = String(data?.status || data?.state || '')
        if (isFailureStatus(status) || extractErrorMessage(data)) {
          throw new Error(extractErrorMessage(data) || '生成に失敗しました。')
        }
        setStatusMessage(mapStatusText(status))
        await wait(2500)
      }
      throw new Error('生成がタイムアウトしました。')
    },
    [],
  )

  const muxWithOriginalVideo = useCallback(
    async (audioVideoSource: string, pipelineUsageId: string, token: string, mode: AudioMode) => {
      if (!pipelineUsageId) throw new Error('結合用IDを取得できませんでした。')
      const audioVideoBase64 = toBase64(audioVideoSource)
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            mux_only: true,
            mode,
            pipeline_usage_id: pipelineUsageId,
            base_video_base64: sourceBase64,
            base_video_name: sourceName || `base${sourceExt}`,
            base_video_ext: sourceExt,
            audio_video_base64: audioVideoBase64,
            audio_video_name: `audio-source${inferVideoExt(audioVideoSource)}`,
            audio_video_ext: inferVideoExt(audioVideoSource),
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(extractErrorMessage(data) || '動画と音声の結合に失敗しました。')
      }
      const muxedVideo = extractVideo(data)
      if (!muxedVideo) throw new Error('動画と音声の結合結果を取得できませんでした。')
      return muxedVideo
    },
    [sourceBase64, sourceExt, sourceName],
  )

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !accessToken) return
    const trimmedPrompt = prompt.trim()
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      setErrorMessage(`プロンプトは${MAX_PROMPT_LENGTH}文字以内にしてください。`)
      return
    }

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setIsRunning(true)
    setResultVideo(null)
    setErrorMessage('')
    setStatusMessage('音声付き動画を生成しています')

    try {
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            prompt: trimmedPrompt,
            mode: audioMode,
            video_base64: sourceBase64,
            video_name: sourceName || `source${sourceExt}`,
            video_ext: sourceExt,
            video_duration: sourceDuration,
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = extractErrorMessage(data) || '生成開始に失敗しました。'
        if (isTicketShortage(res.status, message)) {
          throw new Error('クレジットが不足しています。')
        }
        throw new Error(message)
      }

      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

      let audioVideo = ''
      let pipelineUsageId = String(extractPipelineUsageId(data) || '')
      const immediate = extractVideo(data)
      if (immediate) {
        if (runIdRef.current !== runId) return
        audioVideo = immediate
      } else {
        const jobId = extractJobId(data)
        if (!jobId) throw new Error('ジョブIDを取得できませんでした。')
        pipelineUsageId = pipelineUsageId || `audio:${jobId}`
        const polled = await pollJob(String(jobId), runId, accessToken, audioMode)
        if (runIdRef.current !== runId || !polled) return
        audioVideo = polled.video
        pipelineUsageId = polled.pipelineUsageId || pipelineUsageId
      }

      if (audioMode === 'mode2') {
        if (runIdRef.current !== runId) return
        setResultVideo(audioVideo)
        setStatusMessage('生成が完了しました。')
        return
      }

      setStatusMessage('音声付き動画を生成しています')
      const muxedVideo = await muxWithOriginalVideo(audioVideo, pipelineUsageId, accessToken, audioMode)
      if (runIdRef.current !== runId) return
      setResultVideo(muxedVideo)
      setStatusMessage('生成が完了しました。')
    } catch (error) {
      if (runIdRef.current !== runId) return
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStatusMessage('')
    } finally {
      if (runIdRef.current === runId) {
        setIsRunning(false)
        if (accessToken) void fetchTickets(accessToken)
      }
    }
  }, [accessToken, audioMode, canGenerate, fetchTickets, muxWithOriginalVideo, pollJob, prompt, sourceBase64, sourceDuration, sourceExt, sourceName])

  if (!authReady) {
    return (
      <div className="studio-page">
        <TopNav />
        <main className="studio-loader">読み込み中...</main>
      </div>
    )
  }

  return (
    <div className="studio-page sound-page">
      <TopNav />
      <main className="studio-wrap">
        <section className="studio-panel studio-panel--controls">
          <header className="studio-heading">
            <h1>音声付き動画生成</h1>
            <p>動画とプロンプトから、効果音付きの動画を生成します。動画は10秒以内、プロンプトは300文字以内です。</p>
          </header>

          <div className="studio-ticket-row">
            <span className="studio-ticket-label">保有クレジット</span>
            <strong className="studio-ticket-value">{ticketStatus === 'loading' ? '確認中' : ticketCount ?? '-'}</strong>
            <span className="studio-ticket-cost">1回 {TICKET_COST}枚</span>
          </div>
          {ticketMessage ? <p className="studio-inline-error">{ticketMessage}</p> : null}

          <section className="studio-section">
            <h2 className="studio-section-title">STYLE</h2>
            <div className="audio-mode-toggle" role="group" aria-label="スタイル">
              <button
                type="button"
                className={`audio-mode-toggle__button${audioMode === 'mode1' ? ' is-active' : ''}`}
                onClick={() => setAudioMode('mode1')}
                disabled={isRunning}
              >
                スタイル1
              </button>
              <button
                type="button"
                className={`audio-mode-toggle__button${audioMode === 'mode2' ? ' is-active' : ''}`}
                onClick={() => setAudioMode('mode2')}
                disabled={isRunning}
              >
                スタイル2
              </button>
            </div>
          </section>

          <section className="studio-section">
            <h2 className="studio-section-title">VIDEO</h2>
            <label className="studio-upload">
              <input type="file" accept="video/*" onChange={handleVideoChange} disabled={isRunning} />
              <span className="studio-upload-inner">
                <strong>動画をアップロード</strong>
                <span>10秒以内の動画を選択してください。</span>
              </span>
            </label>
            {sourcePreview ? (
              <div className="sound-source">
                <video src={sourcePreview} controls />
                <div className="sound-source__meta">
                  <span>{sourceName}</span>
                  <span>
                    {sourceDuration ? `${sourceDuration.toFixed(1)}秒` : ''}
                    {sourceSize ? ` / ${sourceSize.width}x${sourceSize.height}` : ''}
                  </span>
                </div>
                <button className="studio-btn studio-btn--ghost" type="button" onClick={resetSource} disabled={isRunning}>
                  動画を外す
                </button>
              </div>
            ) : null}
          </section>

          <section className="studio-section">
            <h2 className="studio-section-title">PROMPT</h2>
            <label className="studio-field">
              <span>プロンプト</span>
              <textarea
                rows={5}
                maxLength={MAX_PROMPT_LENGTH}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value.slice(0, MAX_PROMPT_LENGTH))}
                placeholder="例: 雨音、足音、衣擦れ、部屋の反響など、入れたい音を入力"
                disabled={isRunning}
              />
              <span className="studio-field-note">
                {prompt.length}/{MAX_PROMPT_LENGTH}
              </span>
            </label>
          </section>

          <div className="studio-generate-dock">
            <button className="studio-btn studio-btn--primary" type="button" onClick={handleGenerate} disabled={!canGenerate}>
              {isRunning ? '生成中...' : '生成開始'}
            </button>
            {statusMessage ? <p className="studio-status">{statusMessage}</p> : null}
            {errorMessage ? <p className="studio-inline-error">{errorMessage}</p> : null}
          </div>
        </section>

        <section className="studio-panel studio-panel--preview">
          <div className="studio-preview-head">
            <h2>生成結果</h2>
          </div>
          <div className="studio-canvas sound-canvas" style={previewStyle}>
            {isRunning ? (
              <div className="studio-loading" role="status" aria-live="polite">
                <div className="studio-loading__halo" aria-hidden="true">
                  <div className="studio-loading__core" />
                  <div className="studio-spinner" />
                </div>
                <p className="studio-loading__title">プレビューを準備しています</p>
                <p className="studio-loading__subtitle">音声付き動画を生成しています</p>
                <div className="studio-loading__steps" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : resultVideo ? (
              <video className="studio-result-media" src={resultVideo} controls />
            ) : (
              <div className="studio-empty">生成結果はここに表示されます。</div>
            )}
          </div>
          {resultVideo ? (
            <a className="studio-save-btn sound-download" href={resultVideo} download="meltplus-audio-video.mp4">
              保存
            </a>
          ) : null}
        </section>
      </main>
    </div>
  )
}
