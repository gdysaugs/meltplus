import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { saveGeneratedAsset } from '../lib/downloadMedia'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './video-studio.css'
import './lip-sync.css'

const API_ENDPOINT = '/api/lipsync'
const TICKETS_ENDPOINT = '/api/tickets'
const POLL_INTERVAL_MS = 4000
const MAX_POLL_COUNT = 120
const LIPSYNC_CREDIT_COST = 2
const W2L_SYNC_CHECKPOINT = 'checkpoints/wav2lip.onnx'
const W2L_QUALITY_CHECKPOINT = 'checkpoints/wav2lip_gan.onnx'
const DEFAULT_W2L_BLENDING = 10
const DEFAULT_PADS = 4
const DEFAULT_FACE_MODE = 0
const DEFAULT_RESIZE_FACTOR = 1
const DEFAULT_TARGET_FACE_INDEX = 0
const DEFAULT_FACE_ID_THRESHOLD = 0.45
const DEFAULT_KEEP_ORIGINAL_AUDIO = true
const DEFAULT_GENERATED_AUDIO_MIX_VOLUME = 1
const DEFAULT_ORIGINAL_AUDIO_MIX_VOLUME = 0.9
const DEFAULT_AIVIS_SPEED_SCALE = 1
const DEFAULT_AIVIS_PITCH_SCALE = 0
const DEFAULT_AIVIS_INTONATION_SCALE = 1
const AIVIS_STYLE_OPTIONS = [
  { value: '888753760', label: '女の子 / ノーマル' },
  { value: '888753761', label: '女の子 / ふつー' },
  { value: '888753762', label: '女の子 / あまあま' },
  { value: '888753763', label: '女の子 / おちつき' },
  { value: '888753764', label: '女の子 / からかい' },
  { value: '888753765', label: '女の子 / せつなめ' },
  { value: '1325133120', label: 'ヒロイン' },
  { value: '1431611904', label: 'ヒロイン2' },
]
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'リクエストに失敗しました。'
  if (typeof value === 'string') return value
  if (value instanceof Error && value.message) return value.message
  const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
  const picked = maybe?.error ?? maybe?.message ?? maybe?.detail
  if (typeof picked === 'string' && picked) return picked
  return String(value)
}

const isTicketShortage = (status: number, message: string) => {
  if (status === 402) return true
  const lowered = message.toLowerCase()
  return (
    lowered.includes('no ticket') ||
    lowered.includes('insufficient_tickets') ||
    lowered.includes('insufficient tickets') ||
    lowered.includes('token') ||
    lowered.includes('credit') ||
    lowered.includes('クレジット')
  )
}

const mapStatusText = (status: string) => {
  const normalized = status.toUpperCase()
  if (normalized.includes('COMPLETED')) return '生成が完了しました。'
  if (normalized.includes('IN_QUEUE') || normalized.includes('QUEUED')) return 'キュー待機中です...'
  if (normalized.includes('IN_PROGRESS') || normalized.includes('PROCESS')) return '口パク動画を生成中です...'
  if (normalized.includes('FAILED') || normalized.includes('ERROR')) return '生成に失敗しました。'
  return `状態: ${status}`
}

type LipSyncQualityMode = 'sync' | 'quality'

export function LipSync() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [videoPayload, setVideoPayload] = useState<string | null>(null)
  const [videoExt, setVideoExt] = useState('.mp4')
  const [videoName, setVideoName] = useState('')
  const [lineText, setLineText] = useState('')
  const [selectedStyleId, setSelectedStyleId] = useState(AIVIS_STYLE_OPTIONS[0]?.value ?? '')
  const [aivisSpeedScale, setAivisSpeedScale] = useState(DEFAULT_AIVIS_SPEED_SCALE)
  const [aivisPitchScale, setAivisPitchScale] = useState(DEFAULT_AIVIS_PITCH_SCALE)
  const [aivisIntonationScale, setAivisIntonationScale] = useState(DEFAULT_AIVIS_INTONATION_SCALE)
  const [qualityMode, setQualityMode] = useState<LipSyncQualityMode>('quality')
  const [statusMessage, setStatusMessage] = useState('')
  const [resultVideo, setResultVideo] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [showTicketModal, setShowTicketModal] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [isSavingResult, setIsSavingResult] = useState(false)
  const runIdRef = useRef(0)
  const previewUrlRef = useRef<string | null>(null)
  const navigate = useNavigate()
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
    if (!token) return null
    setTicketStatus('loading')
    setTicketMessage('')
    const res = await fetch(TICKETS_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'クレジットの取得に失敗しました。')
      setTicketCount(null)
      return null
    }
    const nextCount = Number(data?.tickets ?? 0)
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(nextCount)
    return nextCount
  }, [])

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  const handleVideoChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setErrorMessage('')
    setStatusMessage('')
    setResultVideo(null)

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }

    const preview = URL.createObjectURL(file)
    previewUrlRef.current = preview
    setVideoPreview(preview)
    setVideoName(file.name)

    const extMatch = file.name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)
    setVideoExt(extMatch ? `.${extMatch[1]}` : '.mp4')

    try {
      const dataUrl = await readFileAsDataUrl(file)
      setVideoPayload(toBase64(dataUrl))
    } catch (error) {
      setVideoPayload(null)
      setErrorMessage(normalizeErrorMessage(error))
    } finally {
      event.target.value = ''
    }
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!session?.access_token || !videoPayload || !lineText.trim()) return
    if (ticketStatus === 'loading') {
      setStatusMessage('クレジットを確認中...')
      return
    }
    if (accessToken) {
      setStatusMessage('クレジットを確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < LIPSYNC_CREDIT_COST) {
        setShowTicketModal(true)
        setStatusMessage('')
        return
      }
    } else if (ticketCount !== null && ticketCount < LIPSYNC_CREDIT_COST) {
      setShowTicketModal(true)
      return
    }

    const runId = ++runIdRef.current
    setIsRunning(true)
    setErrorMessage('')
    setResultVideo(null)
    setStatusMessage('音声を準備しています...')

    try {
      const payload: Record<string, unknown> = {
        text: lineText.trim(),
        video_base64: videoPayload,
        video_ext: videoExt,
        checkpoint_path: qualityMode === 'sync' ? W2L_SYNC_CHECKPOINT : W2L_QUALITY_CHECKPOINT,
        blending: DEFAULT_W2L_BLENDING,
        denoise: false,
        face_occluder: true,
        face_mask: true,
        pads: DEFAULT_PADS,
        face_mode: DEFAULT_FACE_MODE,
        resize_factor: DEFAULT_RESIZE_FACTOR,
        target_face_index: DEFAULT_TARGET_FACE_INDEX,
        face_id_threshold: DEFAULT_FACE_ID_THRESHOLD,
        keep_original_audio: DEFAULT_KEEP_ORIGINAL_AUDIO,
        generated_audio_mix_volume: Number(DEFAULT_GENERATED_AUDIO_MIX_VOLUME.toFixed(2)),
        original_audio_mix_volume: Number(DEFAULT_ORIGINAL_AUDIO_MIX_VOLUME.toFixed(2)),
        speed_scale: Number(aivisSpeedScale.toFixed(2)),
        pitch_scale: Number(aivisPitchScale.toFixed(3)),
        intonation_scale: Number(aivisIntonationScale.toFixed(2)),
      }
      const styleIdRaw = selectedStyleId.trim()
      if (styleIdRaw) {
        const styleIdValue = Number(styleIdRaw)
        if (Number.isFinite(styleIdValue)) {
          const normalizedStyleId = Math.floor(styleIdValue)
          payload.style_id = normalizedStyleId
          payload.speaker = normalizedStyleId
        }
      }

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      }

      const startRes = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      const startPayload = await startRes.json().catch(() => ({}))
      const startedTickets = Number(startPayload?.ticketsLeft ?? startPayload?.tickets_left)
      if (Number.isFinite(startedTickets)) setTicketCount(startedTickets)
      if (!startRes.ok) {
        const message = normalizeErrorMessage(startPayload)
        if (isTicketShortage(startRes.status, message)) {
          setShowTicketModal(true)
          throw new Error('TICKET_SHORTAGE')
        }
        throw new Error(message)
      }

      const jobId = typeof startPayload?.id === 'string' ? startPayload.id : ''
      const usageId = typeof startPayload?.usage_id === 'string' ? startPayload.usage_id : ''
      if (!jobId) {
        throw new Error('動画ジョブIDの取得に失敗しました。')
      }
      setStatusMessage('動画生成ジョブを開始しました。')

      for (let index = 0; index < MAX_POLL_COUNT; index += 1) {
        if (runIdRef.current !== runId) return
        await wait(POLL_INTERVAL_MS)

        const query = usageId
          ? `${API_ENDPOINT}?id=${encodeURIComponent(jobId)}&usage_id=${encodeURIComponent(usageId)}`
          : `${API_ENDPOINT}?id=${encodeURIComponent(jobId)}`
        const statusRes = await fetch(query, { headers })
        const statusPayload = await statusRes.json().catch(() => ({}))
        const polledTickets = Number(statusPayload?.ticketsLeft ?? statusPayload?.tickets_left)
        if (Number.isFinite(polledTickets)) setTicketCount(polledTickets)
        if (!statusRes.ok) {
          const message = normalizeErrorMessage(statusPayload)
          if (isTicketShortage(statusRes.status, message)) {
            setShowTicketModal(true)
            throw new Error('TICKET_SHORTAGE')
          }
          throw new Error(message)
        }

        const status = String(statusPayload?.status ?? '').toUpperCase()
        setStatusMessage(mapStatusText(status || 'IN_PROGRESS'))

        if (status === 'COMPLETED') {
          if (typeof statusPayload?.video === 'string' && statusPayload.video) {
            setResultVideo(statusPayload.video)
            setStatusMessage('生成が完了しました。')
            return
          }
          throw new Error('生成は完了しましたが動画データを取得できませんでした。')
        }

        if (status.includes('FAILED') || status.includes('ERROR') || status.includes('CANCEL')) {
          throw new Error(normalizeErrorMessage(statusPayload))
        }
      }

      throw new Error('処理がタイムアウトしました。時間をおいて再試行してください。')
    } catch (error) {
      if (runIdRef.current !== runId) return
      const message = normalizeErrorMessage(error)
      if (message === 'TICKET_SHORTAGE') {
        setErrorMessage('クレジット不足')
        setStatusMessage('クレジット不足')
      } else {
        setErrorMessage(message)
        setStatusMessage('')
      }
    } finally {
      if (runIdRef.current === runId) {
        setIsRunning(false)
      }
    }
  }, [aivisIntonationScale, aivisPitchScale, aivisSpeedScale, accessToken, fetchTickets, lineText, qualityMode, selectedStyleId, session?.access_token, ticketCount, ticketStatus, videoExt, videoPayload])

  const handleSaveResult = useCallback(async () => {
    if (!resultVideo || isSavingResult) return
    setIsSavingResult(true)
    try {
      await saveGeneratedAsset({
        source: resultVideo,
        filenamePrefix: 'meltplus-lipsync',
        fallbackExtension: 'mp4',
      })
    } finally {
      setIsSavingResult(false)
    }
  }, [isSavingResult, resultVideo])

  const canGenerate = Boolean(session && videoPayload && lineText.trim() && !isRunning)

  if (!authReady || !session) return null

  return (
    <div className="studio-page lipsync-page">
      <TopNav />
      <main className="lipsync-shell">
        <section className="lipsync-card">
          <h1 className="lipsync-title">LipSync Pipeline</h1>
          <p className="lipsync-description">動画とセリフを入力すると、音声を準備して口パク動画を作成します。</p>

          <p className="studio-token-line">
            クレジット残高:
            <strong className="studio-token-value">{session ? ticketCount ?? 0 : '--'}</strong>
            <span className="studio-token-cost">{`消費: ${LIPSYNC_CREDIT_COST}クレジット`}</span>
          </p>
          {ticketStatus === 'error' && ticketMessage && <p className="studio-inline-error">{ticketMessage}</p>}

          <label className="lipsync-field">
            <span className="lipsync-label">参照動画</span>
            <input
              className="lipsync-input-file"
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              onChange={handleVideoChange}
              disabled={isRunning}
            />
          </label>
          {videoName && <p className="lipsync-meta">選択中: {videoName}</p>}

          <label className="lipsync-field">
            <span className="lipsync-label">セリフ</span>
            <textarea
              className="lipsync-textarea"
              value={lineText}
              onChange={(event) => setLineText(event.target.value)}
              placeholder="ここに喋らせたいセリフを入力"
              rows={5}
              maxLength={100}
              disabled={isRunning}
            />
          </label>

          <label className="lipsync-field">
            <span className="lipsync-label">{'\u97f3\u58f0\u30b9\u30bf\u30a4\u30eb'}</span>
            <select
              className="lipsync-input"
              value={selectedStyleId}
              onChange={(event) => setSelectedStyleId(event.target.value)}
              disabled={isRunning}
            >
              {AIVIS_STYLE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <div className="lipsync-aivis-grid">
            <label className="lipsync-field">
              <span className="lipsync-label">{'\u8a71\u901f'}</span>
              <input
                className="lipsync-input"
                type="number"
                min={0.5}
                max={2}
                step={0.05}
                value={aivisSpeedScale}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (!Number.isFinite(next)) return
                  setAivisSpeedScale(Math.min(2, Math.max(0.5, next)))
                }}
                disabled={isRunning}
              />
            </label>

            <label className="lipsync-field">
              <span className="lipsync-label">{'\u30d4\u30c3\u30c1'}</span>
              <input
                className="lipsync-input"
                type="number"
                min={-0.15}
                max={0.15}
                step={0.01}
                value={aivisPitchScale}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (!Number.isFinite(next)) return
                  setAivisPitchScale(Math.min(0.15, Math.max(-0.15, next)))
                }}
                disabled={isRunning}
              />
            </label>

            <label className="lipsync-field">
              <span className="lipsync-label">{'\u6291\u63da'}</span>
              <input
                className="lipsync-input"
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={aivisIntonationScale}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (!Number.isFinite(next)) return
                  setAivisIntonationScale(Math.min(2, Math.max(0, next)))
                }}
                disabled={isRunning}
              />
            </label>
          </div>
          <p className="lipsync-meta">{'\u8a71\u901f\u30fb\u30d4\u30c3\u30c1\u30fb\u6291\u63da\u306f\u97f3\u58f0\u751f\u6210\u306b\u53cd\u6620\u3055\u308c\u307e\u3059\u3002'}</p>
          <div className="lipsync-mode-row" role="tablist" aria-label="生成モード">
            <button
              type="button"
              role="tab"
              aria-selected={qualityMode === 'sync'}
              className={`lipsync-mode-button${qualityMode === 'sync' ? ' is-active' : ''}`}
              onClick={() => setQualityMode('sync')}
              disabled={isRunning}
            >
              口パク重視
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={qualityMode === 'quality'}
              className={`lipsync-mode-button${qualityMode === 'quality' ? ' is-active' : ''}`}
              onClick={() => setQualityMode('quality')}
              disabled={isRunning}
            >
              画質重視
            </button>
          </div>

          <button type="button" className="lipsync-submit" onClick={handleGenerate} disabled={!canGenerate}>
            {isRunning ? '生成中...' : '口パク動画を生成'}
          </button>

          {statusMessage && <p className="lipsync-status">{statusMessage}</p>}
          {errorMessage && <p className="lipsync-error">{errorMessage}</p>}
        </section>

        <section className="lipsync-preview-grid">
          <article className="lipsync-preview-card">
            <h2>入力動画</h2>
            {videoPreview ? (
              <video src={videoPreview} controls preload="metadata" playsInline />
            ) : (
              <p>動画をアップロードするとここに表示されます。</p>
            )}
          </article>

          <article className="lipsync-preview-card">
            <h2>生成結果</h2>
            {resultVideo ? (
              <div className="studio-result-media">
                <button
                  type="button"
                  className="studio-save-btn"
                  onClick={handleSaveResult}
                  disabled={isSavingResult}
                >
                  {isSavingResult ? 'Saving...' : 'Save'}
                </button>
                <video src={resultVideo} controls preload="metadata" playsInline />
              </div>
            ) : (
              <p>生成後の口パク動画がここに表示されます。</p>
            )}
          </article>
        </section>
      </main>

      {showTicketModal && (
        <div className="studio-modal-overlay" role="dialog" aria-modal="true">
          <div className="studio-modal-card">
            <h3>クレジット不足</h3>
            <p>リップシンク生成にはクレジット2枚が必要です。購入ページで追加してください。</p>
            <div className="studio-modal-actions">
              <button type="button" className="studio-btn studio-btn--ghost" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="studio-btn studio-btn--primary" onClick={() => navigate('/purchase')}>
                購入ページへ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
