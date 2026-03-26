import {
  onRequestGet as onRequestGetWan,
  onRequestOptions as onRequestOptionsWan,
  onRequestPost as onRequestPostWan,
} from './wan'

type ActiveEnv = {
  RUNPOD_WAN_ACTIVE_ENDPOINT_URL?: string
  RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
  RUNPOD_ENDPOINT_URL?: string
  [key: string]: unknown
}

const DEFAULT_ACTIVE_I2V_ENDPOINT = 'https://api.runpod.ai/v2/0bqm7ncp0j5tbc'

const withActiveEndpoint = <T extends { env: ActiveEnv }>(context: T): T => {
  const activeEndpoint = String(
    context.env.RUNPOD_WAN_ACTIVE_ENDPOINT_URL || DEFAULT_ACTIVE_I2V_ENDPOINT,
  ).replace(/\/$/, '')

  const nextEnv: ActiveEnv = {
    ...context.env,
    RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL: activeEndpoint,
    RUNPOD_WAN_ENDPOINT_URL: context.env.RUNPOD_WAN_ENDPOINT_URL ?? activeEndpoint,
    RUNPOD_ENDPOINT_URL: context.env.RUNPOD_ENDPOINT_URL ?? activeEndpoint,
  }

  return { ...context, env: nextEnv }
}

export const onRequestOptions: PagesFunction<ActiveEnv> = async (context) =>
  onRequestOptionsWan(withActiveEndpoint(context) as any)

export const onRequestGet: PagesFunction<ActiveEnv> = async (context) =>
  onRequestGetWan(withActiveEndpoint(context) as any)

export const onRequestPost: PagesFunction<ActiveEnv> = async (context) =>
  onRequestPostWan(withActiveEndpoint(context) as any)
