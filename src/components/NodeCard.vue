<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useBackgroundSurface } from '@/composables/useBackgroundSurface'
import { buildTopPingNetworks, useNodePingDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getApiAssetUrl } from '@/utils/api'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, formatUptimeWithFormat, getStatus } from '@/utils/helper'
import { lineMap, loadLineInfo } from '@/utils/lineInfo'
import { formatOfflineTime, getCustomTags, getPriceTags, getRemainingTimeTagClass, getTrafficLevel, getTrafficUsed, getTrafficUsedPercentage, hasRegion, showTrafficProgress } from '@/utils/nodeHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'

const props = defineProps<{ node: NodeData }>()

const emit = defineEmits<{
  click: []
  pingClick: [node: NodeData]
}>()

// 三网线路数据（中转 Worker 公开接口），加载一次全站共用
loadLineInfo()

const appStore = useAppStore()
const nodesStore = useNodesStore()
const { pickSurfaceClass } = useBackgroundSurface()

const formatBytes = (bytes: number) => formatBytesWithConfig(bytes, appStore.byteDecimals)
const formatBytesPerSecond = (bytes: number) => formatBytesPerSecondWithConfig(bytes, appStore.byteDecimals)
const formatUptime = (seconds: number) => formatUptimeWithFormat(seconds, 'hour')
const offlineTime = computed(() => formatOfflineTime(props.node))
const expiredDate = computed(() => formatDateTime(props.node.expired_at, 'YYYY-MM-DD'))

const cpuStatus = computed(() => getStatus(props.node.cpu ?? 0))
const memPercentage = computed(() => (props.node.ram ?? 0) / (props.node.mem_total || 1) * 100)
const memStatus = computed(() => getStatus(memPercentage.value))
const diskPercentage = computed(() => (props.node.disk ?? 0) / (props.node.disk_total || 1) * 100)
const diskStatus = computed(() => getStatus(diskPercentage.value))

const trafficUsedPercentage = computed(() => getTrafficUsedPercentage(props.node))
const trafficStatus = computed(() => getTrafficLevel(trafficUsedPercentage.value))
const trafficUsed = computed(() => getTrafficUsed(props.node))
const priceTags = computed(() => getPriceTags(props.node, appStore.lang))
const showPriceExpire = computed(() => appStore.isLoggedIn || appStore.showPriceExpireToGuests)
// 游客只看百分比/总量，不看 load、已用/总量明细
const isGuest = computed(() => !appStore.isLoggedIn)

interface LineBadge { carrier: string, line: string }
const lineBadges = computed<LineBadge[]>(() => {
  // 公开接口不带备注，线路数据从中转 Worker 取，按服务器名匹配
  const info = lineMap.value[props.node.name]
  if (!info || typeof info !== 'object')
    return []
  return ['电信', '联通', '移动'].map((carrier) => {
    const line = info[carrier]
    return carrier && line ? { carrier, line } : null
  }).filter((x): x is LineBadge => x !== null)
})
function lineBadgeClass(carrier: string): string {
  if (carrier.includes('电信'))
    return 'text-sky-600 dark:text-sky-400 border-sky-500/30 bg-sky-500/10'
  if (carrier.includes('联通'))
    return 'text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/10'
  if (carrier.includes('移动'))
    return 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
  return 'text-muted-foreground border-border bg-muted/40'
}
const remainingTimeTagClass = computed(() => getRemainingTimeTagClass(props.node))
const customTags = computed(() => getCustomTags(props.node))

const {
  latencyRenderBars,
  lossRenderBars,
  latencyDisplay,
  lossDisplay,
  latencyPanelTooltip,
  lossPanelTooltip,
} = useNodePingDisplay(props.node.uuid)
const topPingNetworks = computed(() => buildTopPingNetworks(props.node.ping))

function openPingDialog() {
  emit('pingClick', props.node)
}
</script>

<template>
  <div
    class="node-card group relative flex h-full w-full cursor-pointer flex-col overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:z-1"
    :class="[pickSurfaceClass('bg-background/60', 'bg-background/15 backdrop-blur-lg')]"
    @click="emit('click')"
  >
    <!-- ═══ 轨道视窗 ═══ -->
    <div class="viewport">
      <div class="vp-stars" />
      <div class="vp-planet" :class="props.node.online ? 'vp-online' : 'vp-offline'" />
      <div class="vp-top">
        <div class="vp-desig">
          {{ props.node.name }}
        </div>
        <div class="vp-patches">
          <img :src="getOSImage(props.node.os, props.node.source_index)" :alt="getOSName(props.node.os)" class="size-4 drop-shadow">
          <img
            v-if="hasRegion(props.node.region)"
            :src="getApiAssetUrl(`flags/${getRegionCode(props.node.region).toLowerCase()}.svg`, props.node.source_index)"
            :alt="getRegionDisplayName(props.node.region)"
            class="vp-flag"
          >
        </div>
      </div>
      <div class="vp-signal" :class="props.node.online ? 'sig-on' : 'sig-off'">
        <span class="sig-dot" />
        {{ props.node.online ? 'ONLINE' : 'OFFLINE' }}
      </div>
    </div>

    <!-- ═══ 遥测舱 ═══ -->
    <div class="telemetry" :class="!props.node.online && 'blur-xs opacity-60 pointer-events-none'">
      <div class="grid grid-cols-2 gap-x-3 gap-y-2">
        <div class="tele">
          <div class="tele-head">
            <span>CPU</span><span>{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
          </div>
          <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
          <div v-if="!isGuest" class="tele-sub">
            {{ props.node.load.toFixed(2) ?? 0 }}, {{ props.node.load5.toFixed(2) ?? 0 }}, {{ props.node.load15.toFixed(2) ?? 0 }}
          </div>
        </div>
        <div class="tele">
          <div class="tele-head">
            <span>内存</span><span>{{ memPercentage.toFixed(1) }}%</span>
          </div>
          <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
          <DataTooltip v-if="!isGuest" placement="top" class="block" :content-class="[!props.node.swap && '!hidden']">
            <div class="tele-sub">
              {{ formatBytes(props.node.ram ?? 0) }} / {{ formatBytes(props.node.mem_total ?? 0) }}
            </div>
            <template #content>
              <div class="flex items-center justify-between gap-3 whitespace-nowrap">
                <span class="text-background/70">Swap</span>
                <span>{{ formatBytes(props.node.swap ?? 0) }}</span>
              </div>
            </template>
          </DataTooltip>
        </div>
        <div class="tele">
          <div class="tele-head">
            <span>硬盘</span><span>{{ diskPercentage.toFixed(1) }}%</span>
          </div>
          <ProgressThin :percentage="diskPercentage" :status="diskStatus" :height="4" />
          <div v-if="!isGuest" class="tele-sub">
            {{ formatBytes(props.node.disk ?? 0) }} / {{ formatBytes(props.node.disk_total ?? 0) }}
          </div>
        </div>
        <div class="tele">
          <div class="tele-head">
            <span>流量</span>
            <span v-if="isGuest">{{ formatBytes(trafficUsed) }} / {{ showTrafficProgress(props.node) ? formatBytes(props.node.traffic_limit) : '∞' }}</span>
            <span v-else>{{ trafficUsedPercentage.toFixed(1) }}%</span>
          </div>
          <ProgressThin :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
          <DataTooltip v-if="!isGuest" placement="top" class="block">
            <div class="tele-sub">
              {{ formatBytes(trafficUsed) }} /
              <template v-if="showTrafficProgress(node)">
                {{ formatBytes(props.node.traffic_limit) }}
              </template>
              <template v-else>
                ∞
              </template>
            </div>
            <template #content>
              <div class="flex items-center justify-between gap-3 whitespace-nowrap">
                <div class="text-[11px] flex flex-col">
                  <div class="flex flex-row items-center gap-1">
                    <Icon icon="tabler:chevron-up" width="12" height="12" />
                    {{ formatBytes(props.node.net_monthly_up ?? 0) }}
                  </div>
                  <div class="flex flex-row items-center gap-1">
                    <Icon icon="tabler:chevron-down" width="12" height="12" />
                    {{ formatBytes(props.node.net_monthly_down ?? 0) }}
                  </div>
                </div>
              </div>
            </template>
          </DataTooltip>
        </div>
      </div>

      <!-- 通讯日志 -->
      <div class="comms">
        <div class="comm-row">
          <span class="comm-k">速率</span>
          <span class="comm-v">
            <span class="text-green-600 flex flex-row items-center gap-1">
              <Icon icon="tabler:chevron-up" width="12" height="12" />{{ formatBytesPerSecond(props.node.net_out ?? 0) }}
            </span>
            <span class="text-blue-600 flex flex-row items-center gap-1">
              <Icon icon="tabler:chevron-down" width="12" height="12" />{{ formatBytesPerSecond(props.node.net_in ?? 0) }}
            </span>
          </span>
        </div>
        <div class="comm-row">
          <span class="comm-k">在线</span>
          <span class="comm-v">{{ props.node.uptime > 0 ? formatUptime(props.node.uptime) : '' }}</span>
        </div>
        <div v-if="showPriceExpire" class="comm-row">
          <span class="comm-k">费用</span>
          <DataTooltip placement="left" :content="expiredDate" content-class="whitespace-nowrap right-0 mr-0">
            <span class="comm-v flex flex-row gap-1">
              <template v-for="(tag, index) in priceTags" :key="tag">
                <span class="inline-flex flex-row gap-1 items-center">
                  <template v-if="tag.highlightValue">
                    <span>{{ tag.prefix }}</span><span :class="remainingTimeTagClass">{{ tag.highlightValue }}</span><span>{{ tag.suffix }}</span>
                  </template>
                  <template v-else>{{ tag.text }}</template>
                </span>
                <span v-if="index < priceTags.length - 1" :key="`${tag}-${index}`">·</span>
              </template>
            </span>
          </DataTooltip>
        </div>
        <div class="comm-row">
          <span class="comm-k">三网</span>
          <span class="comm-v">
            <template v-if="topPingNetworks.length > 0">
              <DataTooltip
                v-for="(net, index) in topPingNetworks" :key="net.key" placement="top"
                :content="net.tooltip" content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
              >
                <span class="truncate"><span v-if="index" class="mx-1">·</span><span :class="net.toneClass">{{ net.latency }}</span></span>
              </DataTooltip>
            </template>
            <template v-else>N/A</template>
          </span>
        </div>
        <div v-if="lineBadges.length > 0" class="comm-row">
          <span class="comm-k">线路</span>
          <span class="comm-v flex flex-row flex-wrap justify-end gap-1">
            <span
              v-for="badge in lineBadges" :key="badge.carrier"
              class="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium leading-4"
              :class="lineBadgeClass(badge.carrier)"
            ><span class="opacity-80">{{ badge.carrier }}</span><span>{{ badge.line }}</span></span>
          </span>
        </div>
        <template v-if="nodesStore.showThreeNetDetails">
          <div class="grid grid-cols-6 gap-x-3">
            <div
              role="button" tabindex="0"
              class="group/panel relative col-span-3 flex h-6 cursor-pointer flex-col gap-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :title="latencyPanelTooltip" :aria-label="`${props.node.name} 延迟`"
              @click.stop="openPingDialog" @keydown.enter.stop.prevent="openPingDialog" @keydown.space.stop.prevent="openPingDialog"
            >
              <div class="flex items-center justify-between text-[11px] leading-none relative">
                <span class="comm-k whitespace-nowrap shrink-0">延迟</span>
                <span class="font-medium text-foreground/85">{{ latencyDisplay }}</span>
              </div>
              <div class="grid h-full items-end gap-[1px]" :style="{ gridTemplateColumns: `repeat(${latencyRenderBars.length}, minmax(0, 1fr))` }">
                <DataTooltip
                  v-for="bar in latencyRenderBars" :key="bar.key" placement="top"
                  :content="bar.tooltip" class="h-full w-full"
                  content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
                >
                  <span class="block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-200" :class="bar.className" />
                </DataTooltip>
              </div>
            </div>
            <div
              role="button" tabindex="0"
              class="group/panel relative col-span-3 flex h-6 cursor-pointer flex-col gap-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :title="lossPanelTooltip" :aria-label="`${props.node.name} 丢包`"
              @click.stop="openPingDialog" @keydown.enter.stop.prevent="openPingDialog" @keydown.space.stop.prevent="openPingDialog"
            >
              <div class="flex items-center justify-between text-[11px] leading-none relative">
                <span class="comm-k whitespace-nowrap shrink-0">丢包</span>
                <span class="font-medium text-foreground/85">{{ lossDisplay }}</span>
              </div>
              <div class="grid h-full items-end gap-[1px]" :style="{ gridTemplateColumns: `repeat(${lossRenderBars.length}, minmax(0, 1fr))` }">
                <DataTooltip
                  v-for="bar in lossRenderBars" :key="bar.key" placement="top"
                  :content="bar.tooltip" class="h-full w-full"
                  content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
                >
                  <span class="block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-200" :class="bar.className" />
                </DataTooltip>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div v-if="customTags.length > 0" class="flex shrink-0 flex-wrap gap-1 items-center">
        <Badge v-for="(tag, index) in customTags" :key="index" variant="outline" class="!text-[11px] rounded text-muted-foreground border-muted-foreground/10 px-1.5">
          {{ tag }}
        </Badge>
      </div>
    </div>

    <!-- 离线遮罩 -->
    <div v-if="!props.node.online" class="offline-veil">
      <span class="offline-title">离线</span>
      <span class="offline-time">{{ offlineTime }}</span>
    </div>

    <div class="frame" />
  </div>
</template>

<style scoped>
/* ═══ 轨道视窗卡：切角控制台造型 ═══ */
.node-card {
  position: relative;
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
}
.node-card:hover {
  filter: drop-shadow(0 10px 24px rgba(56, 189, 248, 0.25));
}

/* ── 轨道视窗：永远是深空 ── */
.viewport {
  position: relative;
  height: 96px;
  flex-shrink: 0;
  overflow: hidden;
  background: #040814;
  border-bottom: 1px solid rgba(125, 211, 252, 0.18);
}
.vp-stars {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1px 1px at 12% 24%, rgba(255, 255, 255, 0.7) 50%, transparent 51%),
    radial-gradient(1px 1px at 78% 14%, rgba(255, 255, 255, 0.45) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 58% 66%, rgba(186, 230, 253, 0.6) 50%, transparent 51%),
    radial-gradient(1px 1px at 32% 78%, rgba(255, 255, 255, 0.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 90% 52%, rgba(255, 255, 255, 0.5) 50%, transparent 51%),
    radial-gradient(1px 1px at 44% 10%, rgba(255, 255, 255, 0.35) 50%, transparent 51%),
    radial-gradient(1px 1px at 24% 52%, rgba(216, 180, 254, 0.55) 50%, transparent 51%),
    radial-gradient(120% 90% at 85% 115%, rgba(124, 58, 237, 0.16), transparent 55%),
    radial-gradient(140% 110% at 50% -30%, rgba(37, 99, 235, 0.22), transparent 55%);
}
.vp-planet {
  position: absolute;
  width: 170px;
  height: 170px;
  left: 50%;
  bottom: -118px;
  transform: translateX(-50%);
  border-radius: 9999px;
}
.vp-online {
  background: radial-gradient(circle at 50% 28%, #8fd8ff 0%, #38bdf8 30%, #1e40af 58%, #060d28 82%);
  box-shadow:
    0 -6px 42px 8px rgba(56, 189, 248, 0.4),
    inset 0 -18px 42px rgba(0, 0, 0, 0.6);
}
.vp-offline {
  background: radial-gradient(circle at 50% 28%, #fca5a5 0%, #ef4444 32%, #7f1d1d 62%, #1c0606 85%);
  box-shadow:
    0 -6px 42px 8px rgba(248, 113, 113, 0.35),
    inset 0 -18px 42px rgba(0, 0, 0, 0.6);
}
.vp-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
}
.vp-desig {
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 10px rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.vp-patches {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.vp-flag {
  width: 26px;
  height: 26px;
  border-radius: 9999px;
  object-fit: cover;
  box-shadow:
    0 0 0 2px rgba(255, 255, 255, 0.28),
    0 2px 10px rgba(0, 0, 0, 0.55);
}
.vp-signal {
  position: absolute;
  left: 12px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  padding: 3px 9px;
  border-radius: 9999px;
  backdrop-filter: blur(4px);
}
.sig-on {
  color: #6ee7b7;
  background: rgba(6, 78, 59, 0.55);
  box-shadow: inset 0 0 0 1px rgba(110, 231, 183, 0.4);
}
.sig-off {
  color: #fca5a5;
  background: rgba(127, 29, 29, 0.55);
  box-shadow: inset 0 0 0 1px rgba(252, 165, 165, 0.4);
}
.sig-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  animation: sig-blink 2.4s ease-in-out infinite;
}
@keyframes sig-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ── 遥测舱 ── */
.telemetry {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  flex: 1;
}
.tele-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 2px;
}
.tele-head span:first-child {
  color: var(--muted-foreground);
  white-space: nowrap;
}
.tele-sub {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

/* ── 通讯日志 ── */
.comms {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}
.comm-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.comm-k {
  color: var(--muted-foreground);
  flex-shrink: 0;
}
.comm-v {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  text-align: right;
}

/* ── 离线遮罩 ── */
.offline-veil {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(10, 4, 4, 0.45);
  backdrop-filter: blur(1px);
}
.offline-title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  color: #fca5a5;
  text-shadow: 0 0 12px rgba(248, 113, 113, 0.6);
}
.offline-time {
  font-size: 11px;
  color: var(--muted-foreground);
}

/* ── 舷窗框：跟随切角形状的发光边缘 ── */
.frame {
  position: absolute;
  inset: 0;
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
  box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.3);
  pointer-events: none;
}
.dark .frame {
  box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.38);
}
.node-card:has(.offline-veil) .frame {
  box-shadow: inset 0 0 0 1px rgba(248, 113, 113, 0.42);
}
</style>
