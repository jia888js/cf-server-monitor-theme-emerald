import { ref } from 'vue'

/** 三网线路数据：name -> { 电信, 联通, 移动 }，来自中转 Worker 公开接口 */
export const lineMap = ref<Record<string, Record<string, string>>>({})

let loaded = false
let loading: Promise<void> | null = null

export function loadLineInfo(): Promise<void> {
  if (loaded)
    return Promise.resolve()
  if (loading)
    return loading
  loading = (async () => {
    try {
      const r = await fetch('https://linereport.error404.cyou/lines')
      const j = await r.json()
      if (j && j.ok && j.lines && typeof j.lines === 'object')
        lineMap.value = j.lines
    }
    catch {
      // 取不到就当没有线路数据，不影响主流程
    }
    finally {
      loaded = true
      loading = null
    }
  })()
  return loading
}
