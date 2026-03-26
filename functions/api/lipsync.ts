import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY?: string
  RUNPOD_AIVIS_ENDPOINT_URL?: string
  RUNPOD_WAV2LIP_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const MAX_TEXT_LENGTH = 50
const MAX_VIDEO_BYTES = 6 * 1024 * 1024
const ALLOWED_ENHANCERS = new Set(['none', 'gpen', 'gfpgan', 'codeformer', 'restoreformer'])
const SIGNUP_TICKET_GRANT = 5
const LIPSYNC_TOTAL_CREDIT_COST = 2
const LIPSYNC_STAGE_CREDIT_COST = 1

const ERROR_LOGIN_REQUIRED = 'ログインが必要です。'
const ERROR_AUTH_FAILED = '認証に失敗しました。'
const ERROR_GOOGLE_ONLY = 'Googleログインのみ対応しています。'
const ERROR_SUPABASE_NOT_SET = 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。'
const ERROR_RUNPOD_NOT_SET = 'サーバー設定が不足しています。管理者にお問い合わせください。'
const INTERNAL_SERVER_ERROR_MESSAGE = 'サーバー内部エラーが発生しました。時間をおいて再度お試しください。'
const ERROR_NO_CREDITS = 'クレジットが不足しています。'
const ERROR_INVALID_CREDIT_REQUEST = 'クレジット処理に失敗しました。'
const ERROR_EMAIL_MISSING = 'メールアドレスを取得できませんでした。'
const ERROR_USAGE_NOT_FOUND = 'ジョブ情報が見つかりません。'
const GENERIC_AUDIO_STAGE_ERROR = '音声の準備に失敗しました。'
const GENERIC_VIDEO_STAGE_ERROR = '動画の生成に失敗しました。'

type TicketEventRow = {
  usage_id: string
  user_id: string | null
  email: string | null
  delta: number | null
  metadata: Record<string, unknown> | null
}

const parseTicketMetadata = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const extractBearerToken = (request: Request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/Bearer\s+(.+)/i)
  return match ? match[1] : ''
}

const getSupabaseAdmin = (env: Env) => {
  const url = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const isGoogleUser = (user: User) => {
  if (user.app_metadata?.provider === 'google') return true
  if (Array.isArray(user.identities)) {
    return user.identities.some((identity) => identity.provider === 'google')
  }
  return false
}

const normalizeEmail = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

const isUsageOwnedByUser = (
  event: Pick<TicketEventRow, 'user_id' | 'email'>,
  user: User,
) => {
  if (event.user_id && event.user_id === user.id) return true
  const userEmail = normalizeEmail(user.email ?? '')
  return Boolean(userEmail && normalizeEmail(event.email) === userEmail)
}

const fetchUsageEvent = async (
  admin: ReturnType<typeof createClient>,
  usageId: string,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email, delta, metadata')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (error || !data) {
    return { event: null as TicketEventRow | null, error }
  }

  return {
    event: {
      usage_id: String(data.usage_id),
      user_id: data.user_id ? String(data.user_id) : null,
      email: data.email ? String(data.email) : null,
      delta: Number.isFinite(Number(data.delta)) ? Number(data.delta) : null,
      metadata: parseTicketMetadata(data.metadata),
    } satisfies TicketEventRow,
    error: null,
  }
}

const fetchTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()
  if (userError) {
    return { error: userError }
  }
  if (byUser) {
    return { data: byUser, error: null }
  }
  if (!email) {
    return { data: null, error: null }
  }
  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('email', email)
    .maybeSingle()
  if (emailError) {
    return { error: emailError }
  }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email
  if (!email) {
    return { data: null, error: null }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return { data: null, error }
  }
  if (existing) {
    return { data: existing, error: null, created: false }
  }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) {
      return { data: null, error: retryError }
    }
    return { data: retry, error: null, created: false }
  }

  await admin.from('ticket_events').insert({
    usage_id: makeUsageId(),
    email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted, error: null, created: true }
}

const ensureTicketAvailable = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  requiredCredits: number,
  corsHeaders: HeadersInit = {},
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: ERROR_EMAIL_MISSING }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: ERROR_NO_CREDITS }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < requiredCredits) {
    return { response: jsonResponse({ error: ERROR_NO_CREDITS }, 402, corsHeaders) }
  }

  return { existing }
}

const consumeCredits = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  creditCost: number,
  metadata: Record<string, unknown>,
  corsHeaders: HeadersInit = {},
) => {
  const cost = Math.max(1, Math.floor(creditCost))
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: ERROR_EMAIL_MISSING }, 400, corsHeaders) }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }
  if (!existing) {
    return { response: jsonResponse({ error: ERROR_NO_CREDITS }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: usageId,
    p_cost: cost,
    p_reason: 'generate_video',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to update tickets.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: ERROR_NO_CREDITS }, 402, corsHeaders) }
    }
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: ERROR_INVALID_CREDIT_REQUEST }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyConsumed: Boolean(result?.already_consumed),
  }
}

const refundCredits = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  refundSuffix: string,
  refundAmount: number,
  metadata: Record<string, unknown>,
  corsHeaders: HeadersInit = {},
) => {
  const amount = Math.max(1, Math.floor(refundAmount))
  const email = user.email
  if (!email || !usageId) {
    return { skipped: true }
  }

  const { event, error: usageError } = await fetchUsageEvent(admin, usageId)
  if (usageError) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }
  if (!event || !isUsageOwnedByUser(event, user) || Number(event.delta) >= 0) {
    return { skipped: true }
  }

  const refundUsageId = `${usageId}:refund:${refundSuffix}`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()
  if (refundCheckError) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }
  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: ticketRow, error: ticketRowError } = await ensureTicketRow(admin, user)
  if (ticketRowError) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }
  if (!ticketRow) {
    return { response: jsonResponse({ error: ERROR_NO_CREDITS }, 402, corsHeaders) }
  }

  if (!ticketRow.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', ticketRow.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: ticketRow.id,
    p_usage_id: refundUsageId,
    p_amount: amount,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to refund tickets.'
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: ERROR_INVALID_CREDIT_REQUEST }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyRefunded: Boolean(result?.already_refunded),
  }
}

const requireGoogleUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: jsonResponse({ error: ERROR_LOGIN_REQUIRED }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: ERROR_SUPABASE_NOT_SET }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: ERROR_AUTH_FAILED }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: ERROR_GOOGLE_ONLY }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const parseJsonSafe = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    return null
  }
}

const normalizeBase64 = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

const estimateBase64Bytes = (value: string) => {
  const normalized = value.replace(/\s+/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

const normalizeEndpoint = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? ''

const parseRunpodError = (payload: any, fallback = INTERNAL_SERVER_ERROR_MESSAGE) => {
  const detail =
    payload?.error ||
    payload?.message ||
    payload?.output?.error ||
    payload?.output?.message ||
    payload?.result?.error ||
    payload?.result?.message
  if (!detail) return fallback
  if (typeof detail === 'string') return detail
  return JSON.stringify(detail)
}

const requestRunpod = async (
  endpoint: string,
  path: string,
  apiKey: string,
  init: RequestInit = {},
) => {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let payload: any = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  return { ok: response.ok, status: response.status, payload }
}

const extractAivisAudio = (payload: any) => {
  const output = payload?.output ?? payload?.result?.output ?? payload?.result ?? payload
  const candidates = [
    output?.audio,
    output?.output?.audio,
    payload?.audio,
    payload?.output?.audio,
    payload?.result?.audio,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeBase64(candidate)
    if (normalized) return normalized
  }
  return ''
}

const extractSpeakerId = (payload: any) => {
  const output = payload?.output ?? payload?.result?.output ?? payload?.result ?? payload
  const speaker = output?.speaker ?? payload?.speaker
  const parsed = Number(speaker)
  return Number.isFinite(parsed) ? parsed : null
}

const extractRunpodJobId = (payload: any) => {
  const raw = payload?.id ?? payload?.job_id ?? payload?.output?.id ?? payload?.output?.job_id
  if (!raw) return ''
  return String(raw)
}

const extractRunpodStatus = (payload: any) => {
  const raw = payload?.status ?? payload?.output?.status ?? payload?.result?.status
  if (!raw) return 'UNKNOWN'
  return String(raw).toUpperCase()
}

const extractRunpodOutputError = (payload: any) =>
  parseRunpodError(payload, '')

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const parseBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false
  }
  return fallback
}

const normalizeVideoExt = (value: unknown) => {
  if (typeof value !== 'string') return '.mp4'
  const trimmed = value.trim().toLowerCase()
  const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) return '.mp4'
  return ext
}

const normalizeEnhancer = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ALLOWED_ENHANCERS.has(raw) ? raw : 'codeformer'
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { headers: corsHeaders })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const aivisEndpoint = normalizeEndpoint(env.RUNPOD_AIVIS_ENDPOINT_URL)
  const wav2lipEndpoint = normalizeEndpoint(env.RUNPOD_WAV2LIP_ENDPOINT_URL)
  if (!runpodApiKey || !aivisEndpoint || !wav2lipEndpoint) {
    return jsonResponse({ error: ERROR_RUNPOD_NOT_SET }, 500, corsHeaders)
  }

  const body = await parseJsonSafe(request)
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'JSONボディが必要です。' }, 400, corsHeaders)
  }

  const text = String((body as any).text ?? '').trim()
  if (!text) {
    return jsonResponse({ error: 'セリフ(text)は必須です。' }, 400, corsHeaders)
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `セリフは${MAX_TEXT_LENGTH}文字以内にしてください。` }, 400, corsHeaders)
  }

  const videoBase64 = normalizeBase64((body as any).video_base64 ?? (body as any).videoBase64)
  const videoUrl = typeof (body as any).video_url === 'string' ? String((body as any).video_url).trim() : ''
  if (videoUrl) {
    return jsonResponse({ error: "video_url is not allowed. Use video_base64." }, 400, corsHeaders)
  }
  if (!videoBase64) {
    return jsonResponse({ error: "video_base64 is required." }, 400, corsHeaders)
  }

  const estimatedVideoBytes = estimateBase64Bytes(videoBase64)
  if (estimatedVideoBytes > MAX_VIDEO_BYTES) {
    return jsonResponse(
      { error: "Video is too large. Please use a short video under 6MB." },
      413,
      corsHeaders,
    )
  }

  const styleIdRaw = (body as any).style_id ?? (body as any).speaker
  let styleId: number | undefined
  if (styleIdRaw !== undefined && styleIdRaw !== null && String(styleIdRaw).trim() !== '') {
    const parsedStyleId = Number(styleIdRaw)
    if (!Number.isFinite(parsedStyleId)) {
      return jsonResponse({ error: 'style_id は数値で指定してください。' }, 400, corsHeaders)
    }
    styleId = Math.floor(parsedStyleId)
  }
  const speedScale = Number(clamp((body as any).speed_scale ?? (body as any).speedScale, 1, 0.5, 2).toFixed(2))
  const pitchScale = Number(clamp((body as any).pitch_scale ?? (body as any).pitchScale, 0, -0.15, 0.15).toFixed(3))
  const intonationScale = Number(clamp((body as any).intonation_scale ?? (body as any).intonationScale, 1, 0, 2).toFixed(2))
  const aivisQuery = {
    speedScale,
    pitchScale,
    intonationScale,
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, LIPSYNC_TOTAL_CREDIT_COST, corsHeaders)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  const usageId = `lipsync:${makeUsageId()}`
  const ticketMeta = {
    source: 'lipsync',
    stage: 'all',
    ticket_cost: LIPSYNC_TOTAL_CREDIT_COST,
  }
  const ticketCharge = await consumeCredits(
    auth.admin,
    auth.user,
    usageId,
    LIPSYNC_TOTAL_CREDIT_COST,
    ticketMeta,
    corsHeaders,
  )
  if ('response' in ticketCharge) {
    return ticketCharge.response
  }
  let ticketsLeft =
    Number.isFinite(Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft))
      ? Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft)
      : null

  const refundAudioFailure = async () => {
    const refund = await refundCredits(
      auth.admin,
      auth.user,
      usageId,
      'audio',
      LIPSYNC_TOTAL_CREDIT_COST,
      {
        source: 'lipsync',
        stage: 'audio',
        reason: 'audio_failed',
        refund_amount: LIPSYNC_TOTAL_CREDIT_COST,
      },
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const next = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(next)) ticketsLeft = next
    return null
  }

  const refundVideoFailure = async (status?: string | null) => {
    const refund = await refundCredits(
      auth.admin,
      auth.user,
      usageId,
      'video',
      LIPSYNC_STAGE_CREDIT_COST,
      {
        source: 'lipsync',
        stage: 'video',
        reason: 'video_failed',
        status: status ?? null,
        refund_amount: LIPSYNC_STAGE_CREDIT_COST,
      },
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const next = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(next)) ticketsLeft = next
    return null
  }

  const callAivis = async (input: Record<string, unknown>) =>
    requestRunpod(aivisEndpoint, '/runsync', runpodApiKey, {
      method: 'POST',
      body: JSON.stringify({ input }),
    })

  const aivisInput: Record<string, unknown> = { text, query: aivisQuery }
  if (styleId !== undefined) {
    aivisInput.speaker = styleId
    aivisInput.style_id = styleId
  }

  let aivisRun = await callAivis(aivisInput)
  if (!aivisRun.ok) {
    const refundResponse = await refundAudioFailure()
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        error: GENERIC_AUDIO_STAGE_ERROR,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }

  let audioBase64 = extractAivisAudio(aivisRun.payload)
  const firstAivisError = extractRunpodOutputError(aivisRun.payload)

  const shouldRetryWithoutSpeaker =
    !audioBase64 &&
    styleId !== undefined &&
    /style\s+\d+\s+is\s+not\s+found|speaker|style/i.test(firstAivisError)

  if (shouldRetryWithoutSpeaker) {
    aivisRun = await callAivis({ text, query: aivisQuery })
    if (!aivisRun.ok) {
      const refundResponse = await refundAudioFailure()
      if (refundResponse) return refundResponse
      return jsonResponse(
        {
          error: GENERIC_AUDIO_STAGE_ERROR,
          ticketsLeft,
        },
        502,
        corsHeaders,
      )
    }
    audioBase64 = extractAivisAudio(aivisRun.payload)
  }

  if (!audioBase64) {
    const refundResponse = await refundAudioFailure()
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        error: GENERIC_AUDIO_STAGE_ERROR,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }

  const wav2lipInput: Record<string, unknown> = {
    audio_base64: audioBase64,
    audio_ext: '.wav',
    checkpoint_path:
      String((body as any).checkpoint_path ?? 'checkpoints/wav2lip_gan.onnx').trim() ||
      'checkpoints/wav2lip_gan.onnx',
    denoise: parseBoolean((body as any).denoise, false),
    enhancer: normalizeEnhancer((body as any).enhancer),
    blending: Number(clamp((body as any).blending, 6, 0, 10).toFixed(2)),
    face_occluder: parseBoolean((body as any).face_occluder, true),
    face_mask: parseBoolean((body as any).face_mask, true),
    pads: Math.floor(clamp((body as any).pads, 4, 0, 64)),
    face_mode: Math.floor(clamp((body as any).face_mode, 0, 0, 4)),
    resize_factor: Math.floor(clamp((body as any).resize_factor, 1, 1, 8)),
    target_face_index: Math.floor(clamp((body as any).target_face_index, 0, 0, 32)),
    face_id_threshold: Number(clamp((body as any).face_id_threshold, 0.45, 0, 1).toFixed(3)),
    keep_original_audio: parseBoolean((body as any).keep_original_audio, true),
    generated_audio_mix_volume: Number(clamp((body as any).generated_audio_mix_volume, 1, 0, 2).toFixed(2)),
    original_audio_mix_volume: Number(clamp((body as any).original_audio_mix_volume, 0.9, 0, 2).toFixed(2)),
  }

  wav2lipInput.video_base64 = videoBase64
  wav2lipInput.video_ext = normalizeVideoExt((body as any).video_ext ?? (body as any).videoExt)

  const wav2lipRun = await requestRunpod(wav2lipEndpoint, '/run', runpodApiKey, {
    method: 'POST',
    body: JSON.stringify({ input: wav2lipInput }),
  })
  if (!wav2lipRun.ok) {
    const refundResponse = await refundVideoFailure(extractRunpodStatus(wav2lipRun.payload))
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        error: GENERIC_VIDEO_STAGE_ERROR,
        usage_id: usageId,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }

  const jobId = extractRunpodJobId(wav2lipRun.payload)
  if (!jobId) {
    const refundResponse = await refundVideoFailure(extractRunpodStatus(wav2lipRun.payload))
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        error: GENERIC_VIDEO_STAGE_ERROR,
        usage_id: usageId,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }

  return jsonResponse(
    {
      id: jobId,
      status: extractRunpodStatus(wav2lipRun.payload),
      speaker: extractSpeakerId(aivisRun.payload),
      usage_id: usageId,
      ticketsLeft,
    },
    200,
    corsHeaders,
  )
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const wav2lipEndpoint = normalizeEndpoint(env.RUNPOD_WAV2LIP_ENDPOINT_URL)
  if (!runpodApiKey || !wav2lipEndpoint) {
    return jsonResponse({ error: ERROR_RUNPOD_NOT_SET }, 500, corsHeaders)
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')?.trim()
  const usageId = url.searchParams.get('usage_id')?.trim() ?? ''
  if (!id) {
    return jsonResponse({ error: 'idが必要です。' }, 400, corsHeaders)
  }

  let ticketsLeft: number | null = null
  const refundVideoFailure = async (status?: string | null) => {
    if (!usageId) return null
    const usageEvent = await fetchUsageEvent(auth.admin, usageId)
    if (usageEvent.error) {
      return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
    }
    if (!usageEvent.event || !isUsageOwnedByUser(usageEvent.event, auth.user) || Number(usageEvent.event.delta) >= 0) {
      return jsonResponse({ error: ERROR_USAGE_NOT_FOUND }, 404, corsHeaders)
    }
    const refund = await refundCredits(
      auth.admin,
      auth.user,
      usageId,
      'video',
      LIPSYNC_STAGE_CREDIT_COST,
      {
        source: 'lipsync',
        stage: 'video',
        reason: 'video_failed',
        status: status ?? null,
        refund_amount: LIPSYNC_STAGE_CREDIT_COST,
      },
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const next = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(next)) ticketsLeft = next
    return null
  }

  const statusResponse = await requestRunpod(
    wav2lipEndpoint,
    `/status/${encodeURIComponent(id)}`,
    runpodApiKey,
    { method: 'GET' },
  )

  if (!statusResponse.ok) {
    const refundResponse = await refundVideoFailure('STATUS_ERROR')
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        error: GENERIC_VIDEO_STAGE_ERROR,
        usage_id: usageId || null,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }

  const payload = statusResponse.payload ?? {}
  const status = extractRunpodStatus(payload)
  const output = payload?.output ?? {}
  const outputBase64 = normalizeBase64(output?.output_base64)
  const outputFilename = output?.output_filename ? String(output.output_filename) : null
  const videoMime = outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'

  if (status === 'COMPLETED') {
    return jsonResponse(
      {
        id,
        status,
        output_filename: outputFilename,
        video: outputBase64 ? `data:${videoMime};base64,${outputBase64}` : null,
        output_size_bytes: output?.output_size_bytes ?? null,
        runtime: output?.runtime ?? null,
        usage_id: usageId || null,
        ticketsLeft,
      },
      200,
      corsHeaders,
    )
  }

  if (status.includes('FAILED') || status.includes('ERROR') || status.includes('CANCEL')) {
    const refundResponse = await refundVideoFailure(status)
    if (refundResponse) return refundResponse
    return jsonResponse(
      {
        id,
        status,
        error: GENERIC_VIDEO_STAGE_ERROR,
        usage_id: usageId || null,
        ticketsLeft,
      },
      200,
      corsHeaders,
    )
  }

  return jsonResponse(
    {
      id,
      status,
      delayTime: payload?.delayTime ?? null,
      executionTime: payload?.executionTime ?? null,
      usage_id: usageId || null,
      ticketsLeft,
    },
    200,
    corsHeaders,
  )
}
