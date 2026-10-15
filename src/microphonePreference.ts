export type MicrophonePreference = { id: string; label: string }

const key = 'echomind-microphone-v1'

export function readMicrophonePreference(): MicrophonePreference {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return { id: typeof value.id === 'string' ? value.id : '', label: typeof value.label === 'string' ? value.label : '' }
  } catch { return { id: '', label: '' } }
}

export function saveMicrophonePreference(preference: MicrophonePreference) {
  localStorage.setItem(key, JSON.stringify(preference))
  window.dispatchEvent(new Event('echomind-microphone-changed'))
}
