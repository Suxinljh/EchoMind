import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { AccountUser } from './account'
import type { ModelMode } from './modelMode'
import type { Provider } from './types'

const PACKAGES = [
  { id: 'basic', label: '100 积分', price: '¥1' },
  { id: 'standard', label: '1000 积分', price: '¥10' },
  { id: 'pro', label: '5000 积分', price: '¥50' },
]

type Props = {
  mode: ModelMode
  onModeChange: (mode: ModelMode) => void
  provider: Provider
  onProviderChange: (provider: Provider) => void
  privacyConsent: boolean
  onPrivacyConsentChange: (value: boolean) => void
  busy: boolean
  setBusy: (value: boolean) => void
  account: AccountUser | null
  onDone: () => void
}

export default function ModelSettings({
  mode,
  onModeChange,
  provider,
  onProviderChange,
  privacyConsent,
  onPrivacyConsentChange,
  busy,
  setBusy,
  account,
  onDone,
}: Props) {
  const [providerState, setProviderState] = useState('')
  const [balance, setBalance] = useState<number | null>(null)
  const [configured, setConfigured] = useState(false)
  const [payState, setPayState] = useState('')
  const own = mode === 'own'

  useEffect(() => {
    if (!account) return
    const controller = new AbortController()
    fetch('/api/credits', { signal: controller.signal })
      .then(response => (response.ok ? response.json() as Promise<{ balance?: number; configured?: boolean }> : null))
      .then(data => {
        if (!data) return
        if (typeof data.balance === 'number') setBalance(data.balance)
        setConfigured(Boolean(data.configured))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [account])

  async function topUp(packageId: string) {
    setPayState('正在创建订单…')
    try {
      const response = await fetch('/api/pay/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageId }),
      })
      const data = await response.json() as { formHtml?: string; error?: string }
      if (!response.ok || !data.formHtml) throw new Error(data.error || '创建订单失败')
      const doc = new DOMParser().parseFromString(data.formHtml, 'text/html')
      const source = doc.querySelector('form')
      if (!source) throw new Error('支付表单生成失败')
      const form = document.createElement('form')
      form.method = source.method || 'POST'
      form.action = source.action
      for (const input of source.querySelectorAll('input')) {
        const field = document.createElement('input')
        field.type = 'hidden'
        field.name = input.name
        field.value = input.value
        form.appendChild(field)
      }
      document.body.appendChild(form)
      form.submit()
    } catch (error) {
      setPayState(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div role="tabpanel" id="model-settings-panel" aria-labelledby="model-settings-tab">
      <div className="model-mode-card">
        <div>
          <strong>不使用平台模型</strong>
          <p>{own ? '使用你自己配置的模型，不消耗平台积分。' : '使用 EchoMind 提供的模型，按积分计费，无需填写接口信息。'}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={own}
          aria-label="不使用平台模型"
          className="switch"
          onClick={() => onModeChange(own ? 'platform' : 'own')}
        >
          <span />
        </button>
      </div>

      {own ? (
        <>
          <p className="settings-intro">填写兼容 OpenAI Chat Completions 的服务。接口地址和模型 ID 保存在本机浏览器；API Key 保存在当前标签页会话中，调用时经当前网站的服务转发给提供商。</p>
          <label className="field">接口根地址<input value={provider.baseUrl} onChange={e => onProviderChange({ ...provider, baseUrl: e.target.value })} placeholder="https://example.com/v1" /></label>
          <label className="field">模型 ID<input value={provider.model} onChange={e => onProviderChange({ ...provider, model: e.target.value })} placeholder="你的模型名称" /></label>
          <label className="field">API Key<input type="password" autoComplete="off" value={provider.apiKey} onChange={e => onProviderChange({ ...provider, apiKey: e.target.value })} placeholder="仅保存在当前标签页会话" /></label>
          <div className="privacy-box">
            <ShieldCheck size={20} />
            <div>
              <strong>发送范围</strong>
              <p>出题时发送岗位和 JD；评估时发送题目、场景设置、可编辑的语义稿，以及出题时从 JD 摘录的原文依据（若有）。音频与原始转写不会发送。服务商可能保存或计费，请查看其条款。</p>
            </div>
          </div>
          <label className="consent-row">
            <input type="checkbox" checked={privacyConsent} onChange={e => onPrivacyConsentChange(e.target.checked)} /> 我同意将上述文字发送给我配置的服务商
          </label>
          <div className="modal-actions">
            <span>{providerState}</span>
            <button
              className="secondary-button"
              disabled={!privacyConsent || !provider.baseUrl || !provider.model || busy}
              onClick={async () => {
                setBusy(true)
                setProviderState('正在测试，最多等待 20 秒…')
                try {
                  await (await import('./ai')).testProvider(provider, mode)
                  setProviderState('连接成功')
                } catch (error) {
                  setProviderState(error instanceof Error ? error.message : String(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              测试连接
            </button>
            <button className="primary-button" onClick={onDone}>完成</button>
          </div>
        </>
      ) : (
        <>
          <div className="platform-model-panel">
            <div className="platform-model-head">
              <strong>平台模型</strong>
              <span className="platform-badge">{configured ? "按量计费" : "未配置"}</span>
            </div>
            {account ? (
              <>
                <div className="platform-model-row"><span>账号</span><strong>{account.name || account.email}</strong></div>
                <div className="platform-model-row"><span>积分</span><strong>{balance === null ? '—' : balance}</strong></div>
                <p className="platform-model-note">{configured ? '按供应商 token 成本的 2 倍扣积分，1 积分 = ¥0.01。每次调用都有输出上限，避免异常消耗。' : '平台模型尚未配置供应商 API Key，暂时无法调用；可以先充值，配置完成后即可使用。'}</p>
                <div className="package-grid">{PACKAGES.map(pkg => <button key={pkg.id} type="button" className="package-card" onClick={() => topUp(pkg.id)}><strong>{pkg.label}</strong><span>{pkg.price}</span></button>)}</div>
                {payState && <p className="platform-model-note">{payState}</p>}
              </>
            ) : (
              <>
                <p className="platform-model-note">登录 Suxin 账号后即可使用平台模型，并把练习记录同步到其他设备。</p>
                <a className="primary-button platform-login" href="/auth/login?returnTo=/">登录 Suxin 账号</a>
              </>
            )}
            <p className="platform-model-consent">使用平台模型时，题目、场景设置与语义稿会发送给 EchoMind 的模型服务，并按实际用量扣减积分。音频与原始转写不会上传。</p>
          </div>
          <div className="modal-actions">
            <span />
            <button className="primary-button" onClick={onDone}>完成</button>
          </div>
        </>
      )}
    </div>
  )
}
