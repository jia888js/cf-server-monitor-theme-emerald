<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
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
  <CardX
    hoverable
    class="node-card h-full w-full cursor-pointer border-none shadow-[0_0_0_1px] shadow-transparent transition-all duration-200 rounded-md hover:bg-background hover:shadow-emerald-600/10 hover:shadow-[0_0_20px,0_0_0_1px] dark:hover:shadow-[0_0_28px_rgba(56,189,248,0.16)] hover:-translate-y-0.5 hover:z-1"
    :class="[pickSurfaceClass('bg-background/60', 'bg-background/15 backdrop-blur-lg'), !props.node.online && 'shadow-[0_0_0_1px] !shadow-red-600/20']"
    @click="emit('click')"
  >
    <template #header>
      <div class="flex gap-2 min-w-0 items-center">
        <!-- 星球状态灯：土星环 + 大气辉光 -->
        <div class="relative size-5 shrink-0" aria-hidden="true">
          <svg class="absolute inset-0 overflow-visible" viewBox="0 0 20 20" fill="none">
            <ellipse
              cx="10" cy="10" rx="9" ry="3.6" transform="rotate(-18 10 10)"
              :stroke="props.node.online ? 'rgba(125,211,252,.6)' : 'rgba(252,165,165,.6)'"
              stroke-width="1"
            />
          </svg>
          <div
            class="planet absolute inset-[5px] rounded-full"
            :class="[props.node.online ? 'planet-online' : 'planet-offline']"
          />
          <div
            class="animate-ping absolute inset-[5px] rounded-full opacity-40"
            :class="[props.node.online ? 'bg-sky-400' : 'bg-red-400']"
          />
        </div>
        <div class="text-md font-bold flex-1 min-w-0 truncate">
          {{ props.node.name }}
        </div>
      </div>
    </template>

    <template #header-extra>
      <div class="flex gap-2 items-center">
        <img :src="getOSImage(props.node.os, props.node.source_index)" :alt="getOSName(props.node.os)" class="size-4">
        <img
          v-if="hasRegion(props.node.region)" :src="getApiAssetUrl(`flags/${getRegionCode(props.node.region).toLowerCase()}.svg`, props.node.source_index)"
          :alt="getRegionDisplayName(props.node.region)" class="size-5 shrink-0 rounded-sm drop-shadow-[0_0_2px_rgba(0,0,0,0.1)]"
        >
      </div>
    </template>

    <template #default>
      <div class="flex flex-col gap-3">
        <div class="gap-x-3 gap-y-1 grid grid-cols-2">
          <!-- CPU -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground whitespace-nowrap shrink-0">
                CPU
              </span>
              <span>{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
            <div v-if="!isGuest" class="text-[11px] text-muted-foreground truncate">
              {{ props.node.load.toFixed(2) ?? 0 }}, {{ props.node.load5.toFixed(2) ?? 0 }}, {{
                props.node.load15.toFixed(2) ?? 0 }}
            </div>
          </div>

          <!-- 内存 -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground whitespace-nowrap shrink-0">
                内存
              </span>
              <span>{{ memPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
            <DataTooltip v-if="!isGuest" placement="top" class="block" :content-class="[!props.node.swap && '!hidden']">
              <div class="text-[11px] text-muted-foreground truncate">
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

          <!-- 硬盘 -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground whitespace-nowrap shrink-0">
                硬盘
              </span>
              <span>{{ diskPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="diskPercentage" :status="diskStatus" :height="4" />
            <div v-if="!isGuest" class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.disk ?? 0) }} / {{ formatBytes(props.node.disk_total ?? 0) }}
            </div>
          </div>

          <!-- 流量进度条 -->
          <div class="flex flex-col gap-1">
            <div class="w-full text-xs flex flex-row justify-between">
              <span class="text-muted-foreground whitespace-nowrap shrink-0">
                流量
              </span>
              <span v-if="isGuest" class="whitespace-nowrap">{{ formatBytes(trafficUsed) }} / {{ showTrafficProgress(props.node) ? formatBytes(props.node.traffic_limit) : '∞' }}</span>
              <span v-else class="whitespace-nowrap">{{ trafficUsedPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
            <DataTooltip v-if="!isGuest" placement="top" class="block">
              <div class="text-[11px] text-muted-foreground truncate">
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
        <div class="relative text-[11px] text-muted-foreground">
          <div
            v-if="!props.node.online"
            class="absolute inset-0 z-10 flex flex-col items-center justify-center space-y-1"
          >
            <span class="text-sm text-red-600">离线</span>
            <div>{{ offlineTime }}</div>
          </div>
          <div class="flex flex-col gap-y-2" :class="[!props.node.online && 'blur-xs opacity-60 pointer-events-none']">
            <div class="flex items-center">
              <span class="truncate">
                速率
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <div class="truncate flex flex-row gap-1">
                <div class="text-green-600 flex flex-row items-center gap-1">
                  <Icon icon="tabler:chevron-up" width="12" height="12" />
                  {{ formatBytesPerSecond(props.node.net_out ?? 0) }}
                </div>
                <div class="text-blue-600 flex flex-row items-center gap-1">
                  <Icon icon="tabler:chevron-down" width="12" height="12" />
                  {{ formatBytesPerSecond(props.node.net_in ?? 0) }}
                </div>
              </div>
            </div>
            <div class="flex items-center justify-between">
              <span class="truncate">
                在线
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <span class="truncate">
                {{ props.node.uptime > 0 ? formatUptime(props.node.uptime) : '' }}
              </span>
            </div>
            <div v-if="showPriceExpire" class="flex items-center justify-between">
              <span class="truncate">
                费用
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <DataTooltip placement="left" :content="expiredDate" content-class="whitespace-nowrap right-0 mr-0">
                <span class="truncate flex flex-row gap-1">
                  <template v-for="(tag, index) in priceTags" :key="tag">
                    <span class="inline-flex flex-row gap-1 items-center">
                      <template v-if="tag.highlightValue">
                        <span>{{ tag.prefix }}</span>
                        <span :class="remainingTimeTagClass">{{ tag.highlightValue }}</span>
                        <span>{{ tag.suffix }}</span>
                      </template>
                      <template v-else>
                        {{ tag.text }}
                      </template>
                    </span>
                    <span v-if="index < priceTags.length - 1" :key="`${tag}-${index}`">·</span>
                  </template>
                </span>
              </DataTooltip>
            </div>
            <div class="flex items-center justify-between">
              <span class="truncate">
                三网
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <div v-if="topPingNetworks.length > 0" class="flex flex-row">
                <DataTooltip
                  v-for="(net, index) in topPingNetworks" :key="net.key" placement="top"
                  :content="net.tooltip"
                  content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
                >
                  <div class="truncate">
                    <span v-if="index" class="mx-1">·</span>
                    <span :class="net.toneClass">{{ net.latency }}</span>
                  </div>
                </DataTooltip>
              </div>
              <div v-else class="truncate">
                N/A
              </div>
            </div>
            <div v-if="lineBadges.length > 0" class="flex items-center justify-between">
              <span class="truncate">
                线路
              </span>
              <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
              <div class="flex flex-row flex-wrap justify-end gap-1">
                <span
                  v-for="badge in lineBadges" :key="badge.carrier"
                  class="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium leading-4"
                  :class="lineBadgeClass(badge.carrier)"
                >
                  <span class="opacity-80">{{ badge.carrier }}</span>
                  <span>{{ badge.line }}</span>
                </span>
              </div>
            </div>
            <template v-if="nodesStore.showThreeNetDetails">
              <div class="grid grid-cols-6 gap-x-3">
                <div
                  role="button" tabindex="0"
                  class="group/panel relative col-span-3 flex h-6 cursor-pointer flex-col gap-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :title="latencyPanelTooltip" :aria-label="`${props.node.name} 延迟`"
                  @click.stop="openPingDialog"
                  @keydown.enter.stop.prevent="openPingDialog"
                  @keydown.space.stop.prevent="openPingDialog"
                >
                  <div class="flex items-center justify-between text-[11px] leading-none relative">
                    <span class="text-muted-foreground whitespace-nowrap shrink-0">延迟</span>
                    <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
                    <span class="font-medium text-foreground/85">{{ latencyDisplay }}</span>
                  </div>
                  <div
                    class="grid h-full items-end gap-[1px]"
                    :style="{ gridTemplateColumns: `repeat(${latencyRenderBars.length}, minmax(0, 1fr))` }"
                  >
                    <DataTooltip
                      v-for="bar in latencyRenderBars" :key="bar.key" placement="top"
                      :content="bar.tooltip" class="h-full w-full"
                      content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
                    >
                      <span
                        class="block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-200"
                        :class="bar.className"
                      />
                    </DataTooltip>
                  </div>
                </div>
                <div
                  role="button" tabindex="0"
                  class="group/panel relative col-span-3 flex h-6 cursor-pointer flex-col gap-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :title="lossPanelTooltip" :aria-label="`${props.node.name} 丢包`"
                  @click.stop="openPingDialog"
                  @keydown.enter.stop.prevent="openPingDialog"
                  @keydown.space.stop.prevent="openPingDialog"
                >
                  <div class="flex items-center justify-between text-[11px] leading-none relative">
                    <span class="text-muted-foreground whitespace-nowrap shrink-0">丢包</span>
                    <div class="border-t-2 border-dotted border-gray-500/10 mx-2 flex-1" />
                    <span class="font-medium text-foreground/85">{{ lossDisplay }}</span>
                  </div>
                  <div
                    class="grid h-full items-end gap-[1px]"
                    :style="{ gridTemplateColumns: `repeat(${lossRenderBars.length}, minmax(0, 1fr))` }"
                  >
                    <DataTooltip
                      v-for="bar in lossRenderBars" :key="bar.key" placement="top"
                      :content="bar.tooltip" class="h-full w-full"
                      content-class="whitespace-pre-wrap w-max px-1.5 !leading-[1.2] text-[11px]"
                    >
                      <span
                        class="block h-full w-full rounded-[1px] transition-transform duration-150 group-hover/data-tooltip:scale-y-200"
                        :class="bar.className"
                      />
                    </DataTooltip>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div v-if="customTags.length > 0" class="flex shrink-0 flex-wrap gap-1 items-center">
          <Badge
            v-for="(tag, index) in customTags" :key="index" variant="outline"
            class="!text-[11px] rounded text-muted-foreground border-muted-foreground/10 px-1.5"
          >
            {{ tag }}
          </Badge>
        </div>
      </div>
    </template>
  </CardX>
</template>

<style scoped>
.node-card {
  position: relative;
  overflow: hidden;
}

/* 卡片底：浅色是天空渐变，深色是深空星野（盖在玻璃底之上、内容之下） */
.node-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 1;
  background: linear-gradient(180deg, rgba(186, 230, 253, 0.4), rgba(186, 230, 253, 0) 46%);
}
.dark .node-card::before {
  background:
    radial-gradient(1px 1px at 11% 20%, rgba(255, 255, 255, 0.65) 50%, transparent 51%),
    radial-gradient(1px 1px at 82% 12%, rgba(255, 255, 255, 0.45) 50%, transparent 51%),
    radial-gradient(1.6px 1.6px at 64% 82%, rgba(186, 230, 253, 0.55) 50%, transparent 51%),
    radial-gradient(1px 1px at 34% 72%, rgba(255, 255, 255, 0.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 90% 58%, rgba(255, 255, 255, 0.5) 50%, transparent 51%),
    radial-gradient(1px 1px at 48% 8%, rgba(255, 255, 255, 0.35) 50%, transparent 51%),
    radial-gradient(1px 1px at 22% 48%, rgba(216, 180, 254, 0.5) 50%, transparent 51%),
    radial-gradient(120% 90% at 85% 110%, rgba(124, 58, 237, 0.14), transparent 55%),
    radial-gradient(130% 100% at 50% -20%, rgba(37, 99, 235, 0.2), transparent 55%),
    linear-gradient(180deg, rgba(10, 18, 48, 0.35), rgba(4, 8, 24, 0.5));
}

/* 大气层顶光 */
.node-card::after {
  content: '';
  position: absolute;
  top: 0;
  left: 8%;
  right: 8%;
  height: 2px;
  border-radius: 9999px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(56, 189, 248, 0.55), transparent);
  opacity: 0.55;
}
.dark .node-card::after {
  opacity: 0.9;
}

/* 星球状态灯 */
.planet-online {
  background: radial-gradient(circle at 32% 30%, #e0f2fe 0%, #38bdf8 38%, #1d4ed8 72%, #0a1740 100%);
  box-shadow:
    0 0 5px 1px rgba(56, 189, 248, 0.85),
    0 0 12px 3px rgba(56, 189, 248, 0.28);
}
.planet-offline {
  background: radial-gradient(circle at 32% 30%, #fee2e2 0%, #f87171 42%, #b91c1c 74%, #3f0d0d 100%);
  box-shadow:
    0 0 5px 1px rgba(248, 113, 113, 0.85),
    0 0 12px 3px rgba(248, 113, 113, 0.28);
}
</style>
