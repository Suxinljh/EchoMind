import { useEffect, useRef, useState } from 'react'

// 语义稿编辑：输入只更新本地草稿，停止输入 400 ms 或失焦后才提交，
// 避免每次按键都重算整题评分并重写整份练习历史。
const COMMIT_DELAY_MS = 400

type Props = { taskId: string; value: string; rows?: number; className?: string; onChange: (taskId: string, value: string) => void }

export default function SemanticEditor({ taskId, value, rows = 8, className, onChange }: Props) {
  const [draft, setDraft] = useState(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const timer = useRef<number | null>(null)
  const taskRef = useRef(taskId)

  function clearTimer() { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null } }

  useEffect(() => {
    if (taskRef.current !== taskId) {
      // 切换题目时必须放弃上一题的待提交内容。
      taskRef.current = taskId; clearTimer(); setDraft(value); return
    }
    // 有待提交内容时不要用外部值覆盖用户正在输入的文字。
    if (timer.current === null) setDraft(value)
  }, [taskId, value])

  useEffect(() => clearTimer, [])

  return <textarea
    className={className}
    rows={rows}
    value={draft}
    onChange={event => {
      const next = event.target.value
      setDraft(next)
      clearTimer()
      timer.current = window.setTimeout(() => { timer.current = null; onChangeRef.current(taskId, next) }, COMMIT_DELAY_MS)
    }}
    onBlur={() => { if (timer.current !== null) { clearTimer(); onChangeRef.current(taskId, draft) } }}
  />
}
