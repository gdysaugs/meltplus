import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY?: string
  RUNPOD_MMAUDIO_ENDPOINT_URL?: string
  RUNPOD_MMAUDIO_MODE2_API_KEY?: string
  RUNPOD_MMAUDIO_MODE2_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const DEFAULT_ENDPOINT = 'https://api.runpod.ai/v2/tf90vnnefy2q5m'
const DEFAULT_MODE2_ENDPOINT = 'https://api.runpod.ai/v2/8kch616iovemh8'
const MAX_PROMPT_LENGTH = 300
const MAX_VIDEO_BYTES = 40 * 1024 * 1024
const MAX_VIDEO_SECONDS = 10
const TARGET_FPS = 25
const FRAME_LOAD_CAP = TARGET_FPS * MAX_VIDEO_SECONDS
const TICKET_COST = 1
const SIGNUP_TICKET_GRANT = 5

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

type AudioMode = 'mode1' | 'mode2'

const normalizeMode = (value: unknown): AudioMode => {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '2' || normalized === 'mode2' ? 'mode2' : 'mode1'
}

const resolveMode1Endpoint = (env: Env) => (env.RUNPOD_MMAUDIO_ENDPOINT_URL || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '')
const resolveMode2Endpoint = (env: Env) => (env.RUNPOD_MMAUDIO_MODE2_ENDPOINT_URL || DEFAULT_MODE2_ENDPOINT).trim().replace(/\/+$/, '')

const resolveRunpodTarget = (env: Env, mode: AudioMode) => {
  if (mode === 'mode2') {
    return {
      endpoint: resolveMode2Endpoint(env),
      apiKey: env.RUNPOD_MMAUDIO_MODE2_API_KEY?.trim() || '',
    }
  }

  return {
    endpoint: resolveMode1Endpoint(env),
    apiKey: env.RUNPOD_API_KEY?.trim() || '',
  }
}

const parseJsonSafe = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    return null
  }
}

const extractBearerToken = (request: Request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/Bearer\s+(.+)/i)
  return match ? match[1] : ''
}

const getSupabaseAdmin = (env: Env) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
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

const requireGoogleUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。' }, 500, corsHeaders) }
  }

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  if (!isGoogleUser(data.user)) return { response: jsonResponse({ error: 'Googleログインのみ対応しています。' }, 403, corsHeaders) }
  return { admin, user: data.user }
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const normalizeEmail = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

const fetchTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()
  if (userError) return { error: userError }
  if (byUser) return { data: byUser, error: null }
  if (!email) return { data: null, error: null }

  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('email', email)
    .maybeSingle()
  if (emailError) return { error: emailError }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  if (!email) return { data: null, error: null }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { data: null, error }
  if (existing) return { data: existing, error: null, created: false }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) return { data: null, error: retryError }
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
  requiredTickets: number,
  corsHeaders: HeadersInit,
) => {
  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  if (!existing.user_id) await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  if (existing.tickets < requiredTickets) return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  if (!existing.user_id) await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: usageId,
    p_cost: TICKET_COST,
    p_reason: 'generate_video',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to update tickets.'
    if (message.includes('INSUFFICIENT_TICKETS')) return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const isUsageOwnedByUser = (event: { user_id?: unknown; email?: unknown }, user: User) => {
  const eventUserId = event.user_id ? String(event.user_id) : ''
  if (eventUserId && eventUserId === user.id) return true
  const userEmail = normalizeEmail(user.email)
  const eventEmail = normalizeEmail(event.email ? String(event.email) : '')
  return Boolean(userEmail && eventEmail && userEmail === eventEmail)
}

const ensureUsageOwnership = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('user_id, email, delta')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (error) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (!data || !isUsageOwnedByUser(data, user) || Number(data.delta) >= 0) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }
  return { ok: true as const }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email, delta')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (chargeError) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (!chargeEvent || !isUsageOwnedByUser(chargeEvent, user) || Number(chargeEvent.delta) >= 0) return { skipped: true }

  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', `${usageId}:refund`)
    .maybeSingle()
  if (refundCheckError) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (existingRefund) return { alreadyRefunded: true }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  if (!existing) return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: `${usageId}:refund`,
    p_amount: TICKET_COST,
    p_reason: 'refund',
    p_metadata: metadata,
  })
  if (rpcError) return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const normalizeBase64 = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.startsWith('data:') && commaIndex >= 0) return trimmed.slice(commaIndex + 1).trim()
  return trimmed
}

const estimateBase64Bytes = (value: string) => {
  const normalized = value.replace(/\s+/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

const normalizeVideoExt = (value: unknown) => {
  if (typeof value !== 'string') return '.mp4'
  const trimmed = value.trim().toLowerCase()
  const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  return /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4'
}

const extensionToMime = (ext: string) => {
  switch (ext.toLowerCase()) {
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.avi':
      return 'video/x-msvideo'
    case '.mp4':
    default:
      return 'video/mp4'
  }
}

const buildWorkflow = (videoFilename: string, prompt: string) => ({
  '85': {
    class_type: 'MMAudioModelLoader',
    inputs: {
      mmaudio_model: 'mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors',
      base_precision: 'fp16',
    },
  },
  '102': {
    class_type: 'MMAudioFeatureUtilsLoader',
    inputs: {
      vae_model: 'mmaudio_vae_44k_fp16.safetensors',
      synchformer_model: 'mmaudio_synchformer_fp16.safetensors',
      clip_model: 'apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors',
      mode: '44k',
      precision: 'fp16',
    },
  },
  '91': {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video: videoFilename,
      force_rate: TARGET_FPS,
      force_size: 'Disabled',
      custom_width: 512,
      custom_height: 512,
      frame_load_cap: FRAME_LOAD_CAP,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
  },
  '105': {
    class_type: 'VHS_VideoInfo',
    inputs: {
      video_info: ['91', 3],
    },
  },
  '92': {
    class_type: 'MMAudioSampler',
    inputs: {
      mmaudio_model: ['85', 0],
      feature_utils: ['102', 0],
      images: ['91', 0],
      duration: ['105', 7],
      steps: 20,
      cfg: 4.5,
      seed: Math.floor(Math.random() * 2147483647),
      prompt,
      negative_prompt: '',
      mask_away_clip: false,
      force_offload: true,
    },
  },
  '97': {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: ['91', 0],
      audio: ['92', 0],
      frame_rate: ['105', 5],
      loop_count: 0,
      filename_prefix: 'MeltPlusAudio',
      format: 'video/h264-mp4',
      pingpong: false,
      save_output: false,
      pix_fmt: 'yuv420p',
      crf: 19,
      save_metadata: true,
    },
  },
})

const buildMuxWorkflow = (videoFilename: string, audioVideoFilename: string) => ({
  '201': {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video: videoFilename,
      force_rate: 0,
      force_size: 'Disabled',
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
  },
  '202': {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video: audioVideoFilename,
      force_rate: 0,
      force_size: 'Disabled',
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
  },
  '203': {
    class_type: 'VHS_VideoInfo',
    inputs: {
      video_info: ['201', 3],
    },
  },
  '204': {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: ['201', 0],
      audio: ['202', 2],
      frame_rate: ['203', 5],
      loop_count: 0,
      filename_prefix: 'MeltPlusAudioMux',
      format: 'video/h264-mp4',
      pingpong: false,
      save_output: false,
      pix_fmt: 'yuv420p',
      crf: 19,
      save_metadata: true,
    },
  },
})

const buildMode2Input = (
  videoBase64: string,
  videoExt: string,
  prompt: string,
  duration: number | null,
) => ({
  video_base64: videoBase64,
  video_ext: videoExt,
  prompt,
  duration: Number.isFinite(Number(duration)) && Number(duration) > 0 ? Math.min(MAX_VIDEO_SECONDS, Number(duration)) : MAX_VIDEO_SECONDS,
  randomize_seed: true,
})

const extractRunpodStatus = (payload: any) => {
  const raw = payload?.status ?? payload?.state ?? payload?.output?.status ?? payload?.result?.status
  return raw ? String(raw).toUpperCase() : 'UNKNOWN'
}

const isFailureStatus = (status: string) => ['FAILED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(String(status || '').toUpperCase())

const extractRunpodJobId = (payload: any) => {
  const raw = payload?.id ?? payload?.job_id ?? payload?.jobId ?? payload?.output?.id ?? payload?.output?.job_id
  return raw ? String(raw) : ''
}

const extractError = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.detail ||
  payload?.output?.error ||
  payload?.output?.message ||
  payload?.result?.error ||
  payload?.result?.message

const extractVideoOutput = (payload: any) => {
  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
    payload?.output?.result,
    payload?.result?.result,
  ]
  const listKeys = ['videos', 'outputs', 'output_videos', 'gifs', 'images']

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    const direct = normalizeBase64(root?.output_base64) || normalizeBase64(root?.video_base64) || normalizeBase64(root?.video) || normalizeBase64(root?.data)
    if (direct) {
      return {
        outputBase64: direct,
        outputFilename: root?.output_filename ? String(root.output_filename) : null,
        outputSizeBytes: Number.isFinite(Number(root?.output_size_bytes)) ? Number(root.output_size_bytes) : null,
        runtime: root?.runtime ?? null,
      }
    }
    for (const key of listKeys) {
      const candidate = root?.[key]
      if (!Array.isArray(candidate)) continue
      for (const item of candidate) {
        if (!item || typeof item !== 'object') continue
        const nested = normalizeBase64(item?.video ?? item?.data ?? item?.url ?? item?.output_base64 ?? item?.video_base64)
        if (!nested) continue
        return {
          outputBase64: nested,
          outputFilename: item?.filename ? String(item.filename) : null,
          outputSizeBytes: Number.isFinite(Number(item?.size_bytes)) ? Number(item.size_bytes) : null,
          runtime: root?.runtime ?? null,
        }
      }
    }
  }

  return { outputBase64: '', outputFilename: null, outputSizeBytes: null, runtime: null }
}

const requestRunpod = async (endpoint: string, path: string, apiKey: string, init: RequestInit = {}) => {
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

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })
  return new Response(null, { headers: corsHeaders })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const payload = await parseJsonSafe(request)
  if (!payload || typeof payload !== 'object') return jsonResponse({ error: 'リクエスト形式が不正です。' }, 400, corsHeaders)

  const input = (payload as any).input ?? payload
  if (input?.workflow) return jsonResponse({ error: 'workflow overrides are not allowed.' }, 400, corsHeaders)

  const mode = normalizeMode(input?.mode)
  const isMuxOnly = input?.mux_only === true || input?.muxOnly === true || String(input?.mux_only ?? input?.muxOnly ?? '').toLowerCase() === 'true'
  if (isMuxOnly) {
    const muxTarget = resolveRunpodTarget(env, 'mode1')
    if (!muxTarget.apiKey || !muxTarget.endpoint) return jsonResponse({ error: 'サーバー設定が不足しています。' }, 500, corsHeaders)

    const usageId = String(input?.pipeline_usage_id ?? input?.pipelineUsageId ?? '').trim()
    if (!usageId) return jsonResponse({ error: 'pipeline_usage_id is required.' }, 400, corsHeaders)

    const ownership = await ensureUsageOwnership(auth.admin, auth.user, usageId, corsHeaders)
    if ('response' in ownership) return ownership.response

    const baseVideoBase64 = normalizeBase64(
      input?.base_video_base64 ?? input?.baseVideoBase64 ?? input?.video_base64 ?? input?.videoBase64,
    )
    const audioVideoBase64 = normalizeBase64(
      input?.audio_video_base64 ?? input?.audioVideoBase64 ?? input?.audio_video ?? input?.audioVideo,
    )
    if (!baseVideoBase64) return jsonResponse({ error: '結合元の動画データが必要です。' }, 400, corsHeaders)
    if (!audioVideoBase64) return jsonResponse({ error: '音声付き動画データが必要です。' }, 400, corsHeaders)

    const baseVideoBytes = estimateBase64Bytes(baseVideoBase64)
    const audioVideoBytes = estimateBase64Bytes(audioVideoBase64)
    if (baseVideoBytes > MAX_VIDEO_BYTES || audioVideoBytes > MAX_VIDEO_BYTES || baseVideoBytes + audioVideoBytes > MAX_VIDEO_BYTES * 2) {
      return jsonResponse({ error: `video is too large (max ${MAX_VIDEO_BYTES / (1024 * 1024)}MB).` }, 413, corsHeaders)
    }

    const baseVideoExt = normalizeVideoExt(input?.base_video_ext ?? input?.baseVideoExt ?? '.mp4')
    const audioVideoExt = normalizeVideoExt(input?.audio_video_ext ?? input?.audioVideoExt ?? '.mp4')
    const baseVideoName = String(input?.base_video_name ?? input?.baseVideoName ?? `base${baseVideoExt}`).trim() || `base${baseVideoExt}`
    const audioVideoName = String(input?.audio_video_name ?? input?.audioVideoName ?? `audio-source${audioVideoExt}`).trim() || `audio-source${audioVideoExt}`

    const muxResult = await requestRunpod(muxTarget.endpoint, '/runsync', muxTarget.apiKey, {
      method: 'POST',
      body: JSON.stringify({
        input: {
          workflow: buildMuxWorkflow(baseVideoName, audioVideoName),
          uploads: [
            {
              name: baseVideoName,
              data: baseVideoBase64,
              mime: extensionToMime(baseVideoExt),
            },
            {
              name: audioVideoName,
              data: audioVideoBase64,
              mime: extensionToMime(audioVideoExt),
            },
          ],
        },
      }),
    }).catch(() => null)

    if (!muxResult || !muxResult.ok) {
      return jsonResponse({ error: '動画と音声の結合に失敗しました。', upstream_status: muxResult?.status ?? null }, 502, corsHeaders)
    }

    const muxStatus = extractRunpodStatus(muxResult.payload)
    if (isFailureStatus(muxStatus) || extractError(muxResult.payload)) {
      return jsonResponse({ error: extractError(muxResult.payload) || '動画と音声の結合に失敗しました。', status: muxStatus }, 502, corsHeaders)
    }

    const muxOutput = extractVideoOutput(muxResult.payload)
    const muxVideoMime = muxOutput.outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
    const muxVideo = muxOutput.outputBase64 ? `data:${muxVideoMime};base64,${muxOutput.outputBase64}` : null
    if (!muxVideo) return jsonResponse({ error: '動画と音声の結合結果を取得できませんでした。' }, 502, corsHeaders)

    return jsonResponse(
      {
        status: muxStatus,
        output_filename: muxOutput.outputFilename,
        output_size_bytes: muxOutput.outputSizeBytes,
        runtime: muxOutput.runtime,
        video: muxVideo,
        pipeline_usage_id: usageId,
        message: 'mux completed',
      },
      200,
      corsHeaders,
    )
  }

  const prompt = String(input?.prompt ?? input?.text ?? '').trim()
  if (!prompt) return jsonResponse({ error: 'プロンプトを入力してください。' }, 400, corsHeaders)
  if (prompt.length > MAX_PROMPT_LENGTH) return jsonResponse({ error: `prompt is too long (max ${MAX_PROMPT_LENGTH}).` }, 400, corsHeaders)

  const videoBase64 = normalizeBase64(input?.video_base64 ?? input?.videoBase64 ?? input?.video)
  if (!videoBase64) return jsonResponse({ error: '動画データを入力してください。' }, 400, corsHeaders)
  if (estimateBase64Bytes(videoBase64) > MAX_VIDEO_BYTES) {
    return jsonResponse({ error: `video is too large (max ${MAX_VIDEO_BYTES / (1024 * 1024)}MB).` }, 413, corsHeaders)
  }

  const rawDuration = Number(input?.video_duration ?? input?.videoDuration)
  if (Number.isFinite(rawDuration) && rawDuration > MAX_VIDEO_SECONDS + 0.25) {
    return jsonResponse({ error: `動画は${MAX_VIDEO_SECONDS}秒以内にしてください。` }, 400, corsHeaders)
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, TICKET_COST, corsHeaders)
  if ('response' in ticketCheck) return ticketCheck.response

  const runpodTarget = resolveRunpodTarget(env, mode)
  if (!runpodTarget.apiKey || !runpodTarget.endpoint) return jsonResponse({ error: 'サーバー設定が不足しています。' }, 500, corsHeaders)

  const videoExt = normalizeVideoExt(input?.video_ext ?? input?.videoExt)
  const videoName = String(input?.video_name ?? input?.videoName ?? `source${videoExt}`).trim() || `source${videoExt}`
  const runpodInput =
    mode === 'mode2'
      ? buildMode2Input(videoBase64, videoExt, prompt, Number.isFinite(rawDuration) ? rawDuration : null)
      : {
          workflow: buildWorkflow(videoName, prompt),
          uploads: [
            {
              name: videoName,
              data: videoBase64,
              mime: extensionToMime(videoExt),
            },
          ],
        }

  let runResult
  try {
    runResult = await requestRunpod(runpodTarget.endpoint, '/run', runpodTarget.apiKey, {
      method: 'POST',
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch {
    return jsonResponse({ error: '音声付き動画のリクエストに失敗しました。' }, 502, corsHeaders)
  }

  if (!runResult.ok) {
    return jsonResponse({ error: '音声付き動画のリクエストに失敗しました。', upstream_status: runResult.status }, 502, corsHeaders)
  }

  const status = extractRunpodStatus(runResult.payload)
  const id = extractRunpodJobId(runResult.payload)
  const usageId = id ? `audio:${mode}:${id}` : `audio:${mode}:adhoc:${makeUsageId()}`
  const charge = await consumeTicket(
    auth.admin,
    auth.user,
    { source: 'sound', mode, job_id: id || null, status, ticket_cost: TICKET_COST },
    usageId,
    corsHeaders,
  )
  if ('response' in charge) return charge.response

  let ticketsLeft: number | null = Number.isFinite(Number(charge.ticketsLeft)) ? Number(charge.ticketsLeft) : null
  if (isFailureStatus(status) || extractError(runResult.payload)) {
    const refund = await refundTicket(
      auth.admin,
      auth.user,
      { source: 'sound', mode, job_id: id || null, status, reason: 'failure' },
      usageId,
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  const output = extractVideoOutput(runResult.payload)
  const videoMime = output.outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
  const video = output.outputBase64 ? `data:${videoMime};base64,${output.outputBase64}` : null

  return jsonResponse(
    {
      id: id || null,
      status,
      output_filename: output.outputFilename,
      output_size_bytes: output.outputSizeBytes,
      runtime: output.runtime,
      video,
      ticketsLeft,
      pipeline_usage_id: usageId,
      mode,
      message: id ? 'job accepted' : 'completed',
    },
    200,
    corsHeaders,
  )
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const params = new URL(request.url).searchParams
  const mode = normalizeMode(params.get('mode'))
  const runpodTarget = resolveRunpodTarget(env, mode)
  if (!runpodTarget.apiKey || !runpodTarget.endpoint) return jsonResponse({ error: 'サーバー設定が不足しています。' }, 500, corsHeaders)

  const id = params.get('id')?.trim()
  if (!id) return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)

  const usageId = `audio:${mode}:${id}`
  const ownership = await ensureUsageOwnership(auth.admin, auth.user, usageId, corsHeaders)
  if ('response' in ownership) return ownership.response

  let statusResult
  try {
    statusResult = await requestRunpod(runpodTarget.endpoint, `/status/${encodeURIComponent(id)}`, runpodTarget.apiKey, { method: 'GET' })
  } catch {
    return jsonResponse({ error: '音声付き動画の状態確認に失敗しました。' }, 502, corsHeaders)
  }
  if (!statusResult.ok) {
    return jsonResponse({ error: '音声付き動画の状態確認に失敗しました。', upstream_status: statusResult.status }, 502, corsHeaders)
  }

  const status = extractRunpodStatus(statusResult.payload)
  let ticketsLeft: number | null = null
  if (isFailureStatus(status) || extractError(statusResult.payload)) {
    const refund = await refundTicket(
      auth.admin,
      auth.user,
      { source: 'sound', mode, job_id: id, status, reason: 'failure' },
      usageId,
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  const output = extractVideoOutput(statusResult.payload)
  const videoMime = output.outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
  const video = output.outputBase64 ? `data:${videoMime};base64,${output.outputBase64}` : null

  return jsonResponse(
    {
      id,
      status,
      output_filename: output.outputFilename,
      output_size_bytes: output.outputSizeBytes,
      runtime: output.runtime,
      video,
      ticketsLeft,
      pipeline_usage_id: usageId,
      mode,
      error: isFailureStatus(status) ? '音声付き動画の生成に失敗しました。' : null,
    },
    200,
    corsHeaders,
  )
}
