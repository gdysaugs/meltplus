const MAGIC_POSITIVE_TAGS = [
  'masterpiece',
  'best quality',
  'ultra detailed',
  'highly detailed',
  'cinematic lighting',
  'sharp focus',
  'high resolution',
  'clean composition',
  'professional color grading',
  'natural motion',
]

const MAGIC_NEGATIVE_TAGS = [
  'worst quality',
  'low quality',
  'bad quality',
  'low resolution',
  'blurry',
  'artifact',
  'distorted',
  'deformed',
  'flicker',
  'watermark',
]

const appendMissingTags = (baseText: string, tags: string[]) => {
  const base = baseText.trim()
  const lowered = base.toLowerCase()
  const missingTags = tags.filter((tag) => !lowered.includes(tag.toLowerCase()))
  if (!missingTags.length) return base
  const prefix = missingTags.join(', ')
  return base ? `${prefix}, ${base}` : prefix
}

export const applyMagicPromptSet = (params: { prompt: string; negativePrompt: string; enabled: boolean }) => {
  const { prompt, negativePrompt, enabled } = params
  if (!enabled) {
    return {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim(),
    }
  }

  return {
    prompt: appendMissingTags(prompt, MAGIC_POSITIVE_TAGS),
    negativePrompt: appendMissingTags(negativePrompt, MAGIC_NEGATIVE_TAGS),
  }
}
