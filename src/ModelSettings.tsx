import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { AccountUser } from './account'
import { loadAi } from './chunkLoad'
import { MAX_CUSTOM_CREDITS, MIN_CUSTOM_CREDITS } from './credits'
import type { ModelMode } from './modelMode'
import type { Provider } from './types'

const PACKAGES = [
  { id: 'basic', label: '100 积分', price: '¥1' },
  { id: 'standard', label: '1000 积分', price: '¥10' },
  { id: 'pro', label: '5000 积分', price: '¥50' },
]
/** 与服务端 worker/alipay.ts 的 customPackage 保持一致：1 积分 = ¥0.01。 */
const yuan = (credits: number) => `¥${(credits / 100).toFixed(2)}`

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
  /** /api/me 是否可用；未配置统一登录时为 false，平台模型入口不显示登录按钮。 */
  accountReady: boolean
  /** 从账号中心等外部链接传入的待充值积分，打开设置时预填到自定义额度。 */
  initialCredits?: number | null
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
  accountReady,
  initialCredits,
  onDone,
}: Props) {
  const [providerState, setProviderState] = useState('')
  const [balance, setBalance] = useState<number | null>(null)
  const [configured, setConfigured] = useState(false)
  const [managed, setManaged] = useState(false)
  const [payState, setPayState] = useState('')
  const [customCredits, setCustomCredits] = useState('')
  const own = mode === 'own'
  const customValue = Number(customCredits.trim())
  const customValid = customCredits.trim() !== '' && Number.isSafeInteger(customValue) && customValue >= MIN_CUSTOM_CREDITS && customValue <= MAX_CUSTOM_CREDITS

  useEffect(() => {
    if (typeof initialCredits !== 'number' || !Number.isSafeInteger(initialCredits) || initialCredits <= 0) return
    setCustomCredits(String(initialCredits))
    // 从账号中心跳过来时直接把光标放到额度输入框，省得用户再找。
    requestAnimationFrame(() => document.getElementById('custom-credits')?.focus())
  }, [initialCredits])

  useEffect(() => {
    if (!account) return
    const controller = new AbortController()
    fetch('/api/credits', { signal: controller.signal })
      .then(response => (response.ok ? response.json() as Promise<{ balance?: number; configured?: boolean; managed?: boolean }> : null))
      .then(data => {
        if (!data) return
        if (typeof data.balance === 'number') setBalance(data.balance)
        setConfigured(Boolean(data.configured))
        setManaged(Boolean(data.managed))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [account])

  async function submitPay(body: { packageId?: string; credits?: number }) {
    setPayState('正在创建订单…')
    try {
      const response = await fetch('/api/pay/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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

  const topUp = (packageId: string) => submitPay({ packageId })

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
              <p>出题时发送岗位和 JD；评估时发送题目、场景设置、可编辑的语义稿，以及出题时从 JD 摘录的原文依据（若有）。音频与原始转写不会发送给模型提供商；登录账号的练习文字会另行同步保存到你的账号。服务商可能保存或计费，请查看其条款。</p>
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
                  await (await loadAi()).testProvider(provider, mode)
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
              <span className="platform-badge tooltip" data-tip="一次 5 题模拟面试约 30～50 积分" tabIndex={0}>{configured ? "按量计费" : "未配置"}</span>
            </div>
            {account ? (
              <>
                <div className="platform-model-row"><span>账号</span><strong>{account.name || account.email}</strong></div>
                <div className="platform-model-row"><span>积分</span><strong>{balance === null ? '—' : balance}</strong></div>
                <p className="platform-model-note">{configured ? '按供应商 token 成本加价扣积分（倍率由服务端配置），1 积分 = ¥0.01。每次调用都有输出上限，避免异常消耗。' : '平台模型尚未配置供应商 API Key，暂时无法调用；可以先充值，配置完成后即可使用。'}</p>
                <div className="package-grid">{PACKAGES.map(pkg => <button key={pkg.id} type="button" className="package-card" onClick={() => topUp(pkg.id)}><strong>{pkg.label}</strong><span>{pkg.price}</span></button>)}</div>
                <div className="custom-topup">
                  <label htmlFor="custom-credits">自定义积分</label>
                  <input
                    id="custom-credits"
                    type="number"
                    inputMode="numeric"
                    min={MIN_CUSTOM_CREDITS}
                    max={MAX_CUSTOM_CREDITS}
                    step={1}
                    value={customCredits}
                    placeholder={`${MIN_CUSTOM_CREDITS} ~ ${MAX_CUSTOM_CREDITS}`}
                    onChange={event => { setCustomCredits(event.target.value); setPayState('') }}
                  />
                  <span className="custom-topup-price">{customValid ? yuan(customValue) : '—'}</span>
                  <button type="button" className="secondary-button" disabled={!customValid} onClick={() => void submitPay({ credits: customValue })}>充值</button>
                </div>
                <p className="platform-model-note">1 积分 = ¥0.01；自定义额度最低 {MIN_CUSTOM_CREDITS} 积分（¥0.50），最高 {MAX_CUSTOM_CREDITS.toLocaleString('zh-CN')} 积分（¥10000.00），金额按积分动态计算。</p>
                {managed && <p className="platform-model-note">积分跟随 Suxin 账号，可在接入的平台通用；退款请到<a href="https://account.ljhsu.xin/refunds" target="_blank" rel="noreferrer">账号中心</a>。</p>}
                <p className="platform-model-note">按量计费：一次 5 题模拟面试约 30～50 积分（悬停上方「按量计费」查看）。</p>
                {payState && <p className="platform-model-note">{payState}</p>}
              </>
            ) : accountReady ? (
              <>
                <p className="platform-model-note">登录 Suxin 账号后即可使用平台模型，并把练习记录同步到其他设备。</p>
                <a className="primary-button platform-login" href="/auth/login?returnTo=/">登录 Suxin 账号</a>
              </>
            ) : (
              <p className="platform-model-note">当前站点未配置统一登录，平台模型暂不可用；可继续使用自备模型或基础问题。</p>
            )}
            <p className="platform-model-consent">使用平台模型时，题目、场景设置与语义稿会发送给 EchoMind 的模型服务，并按实际用量扣减积分。音频不会上传；登录账号的原始转写与语义稿会同步保存到你的账号。</p>
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
