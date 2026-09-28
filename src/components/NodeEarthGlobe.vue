<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import {
  useDocumentVisibility,
  useElementSize,
  useElementVisibility,
  useRafFn,
} from '@vueuse/core'
import * as THREE from 'three'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import cloudsTextureUrl from '@/assets/clouds.png'
import earthTextureUrl from '@/assets/earth.jpg'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getApiAssetUrl } from '@/utils/api'
import { getCoordByCode, getCountryCodeFromRegion } from '@/utils/geoHelper'
import { formatBytesPerSecondSplit } from '@/utils/helper'

const props = defineProps<{
  nodes?: NodeData[]
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()

const displayNodes = computed(() => props.nodes ?? nodesStore.earthNodes)

const containerRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef)

const documentVisibility = useDocumentVisibility()
const elementVisible = useElementVisibility(containerRef)
const shouldRender = computed(() => documentVisibility.value === 'visible' && elementVisible.value)
const shouldAutoRotate = computed(() => appStore.earthViewMode !== 'earth-stop')

const BASE_TILT = 0.18
const MIN_TILT = -0.5
const MAX_TILT = 0.7
const AUTO_ROTATE_SPEED = 0.0018
const CHINA_COORD = getCoordByCode('CN') ?? [35.8617, 104.1954]

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let tiltGroup: THREE.Group | null = null
let spinGroup: THREE.Group | null = null
let cloudsMesh: THREE.Mesh | null = null
let arcsGroup: THREE.Group | null = null
let anchorsGroup: THREE.Group | null = null
let isPointerDown = false
let lastPointerX = 0
let lastPointerY = 0

const markerAnchors = new Map<string, THREE.Object3D>()

// 经纬度转球面坐标（与 three.js SphereGeometry 的 UV 展开对齐）
function latLonToVec3(lat: number, lon: number, radius = 1): THREE.Vector3 {
  const latRad = lat * Math.PI / 180
  const lonRad = lon * Math.PI / 180
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.sin(latRad),
    -radius * Math.cos(latRad) * Math.sin(lonRad),
  )
}

// 让指定经纬度正对相机所需的自转角度
function rotationYForCoord(lat: number, lon: number): number {
  const v = latLonToVec3(lat, lon, 1)
  return Math.atan2(-v.x, v.z)
}

function getCappedDpr(): number {
  if (typeof window === 'undefined')
    return 1
  return Math.min(window.devicePixelRatio || 1, 2)
}

interface RegionCluster {
  code: string
  coord: [number, number]
  servers: number
  onlineServers: number
}

function clusterKey(c: RegionCluster) {
  return `${c.code}:${c.servers}:${c.onlineServers}`
}

interface RegionRate {
  up: number
  down: number
}

// 节点按地区聚合
const regionClusters = computed<RegionCluster[]>(() => {
  const map = new Map<string, RegionCluster>()
  for (const node of displayNodes.value) {
    const code = getCountryCodeFromRegion(node.region)
    if (!code)
      continue
    const coord = getCoordByCode(code)
    if (!coord)
      continue

    let entry = map.get(code)
    if (!entry) {
      entry = { code, coord, servers: 0, onlineServers: 0 }
      map.set(code, entry)
    }
    entry.servers += 1
    if (node.online)
      entry.onlineServers += 1
  }
  return Array.from(map.values()).sort((a, b) => b.servers - a.servers)
})

const regionRates = computed<Map<string, RegionRate>>(() => {
  const map = new Map<string, RegionRate>()
  // 始终使用 nodesStore.nodes 绕过 earthNodes 60s 节流，使速率实时更新
  for (const node of nodesStore.nodes) {
    if (!node.online)
      continue
    const code = getCountryCodeFromRegion(node.region)
    if (!code)
      continue
    let entry = map.get(code)
    if (!entry) {
      entry = { up: 0, down: 0 }
      map.set(code, entry)
    }
    entry.up += node.net_out || 0
    entry.down += node.net_in || 0
  }
  return map
})

const arcsEnabled = computed(() => appStore.visitorInfoCardEnabled && appStore.visitorCountryCode != null)
const userCoord = computed<[number, number] | null>(() => {
  if (!appStore.visitorInfoCardEnabled)
    return null
  return getCoordByCode(appStore.visitorCountryCode)
})

const clusterOverlayEls = new Map<string, HTMLDivElement>()
const clusterOverlayRefBinders = new Map<string, (el: Element | ComponentPublicInstance | null) => void>()

function getRenderSize() {
  const width = containerWidth.value || canvasRef.value?.clientWidth || 320
  const height = containerHeight.value || canvasRef.value?.clientHeight || width
  return { width, height }
}

function buildStars(count: number, minRadius: number, maxRadius: number): THREE.Points {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const tint = [
    [1, 1, 1],
    [0.75, 0.85, 1],
    [1, 0.92, 0.8],
  ]
  for (let i = 0; i < count; i++) {
    // 球壳内均匀随机分布
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const r = minRadius + Math.random() * (maxRadius - minRadius)
    const s = Math.sqrt(1 - u * u)
    positions[i * 3] = r * s * Math.cos(theta)
    positions[i * 3 + 1] = r * u
    positions[i * 3 + 2] = r * s * Math.sin(theta)
    const [tr = 1, tg = 1, tb = 1] = tint[Math.floor(Math.random() * tint.length)] ?? []
    const brightness = 0.45 + Math.random() * 0.55
    colors[i * 3] = tr * brightness
    colors[i * 3 + 1] = tg * brightness
    colors[i * 3 + 2] = tb * brightness
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.055,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    sizeAttenuation: true,
  })
  return new THREE.Points(geo, mat)
}

function buildAtmosphere(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1.04, 48, 48)
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        float intensity = pow(0.66 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
        gl_FragColor = vec4(0.38, 0.62, 1.0, 1.0) * intensity;
      }
    `,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  })
  return new THREE.Mesh(geo, mat)
}

function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child)
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry)
        mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) {
        material.forEach(m => m.dispose())
      }
      else if (material) {
        material.dispose()
      }
    })
  }
}

function rebuildSceneObjects() {
  if (!spinGroup || !arcsGroup || !anchorsGroup)
    return
  disposeGroup(arcsGroup)
  disposeGroup(anchorsGroup)
  markerAnchors.clear()

  for (const cluster of regionClusters.value) {
    const anchor = new THREE.Object3D()
    anchor.position.copy(latLonToVec3(cluster.coord[0], cluster.coord[1], 1.016))
    anchorsGroup.add(anchor)
    markerAnchors.set(cluster.code, anchor)
  }

  const user = userCoord.value
  if (arcsEnabled.value && user) {
    const to = latLonToVec3(user[0], user[1], 1.016)
    for (const cluster of regionClusters.value) {
      const from = latLonToVec3(cluster.coord[0], cluster.coord[1], 1.016)
      const dist = from.distanceTo(to)
      if (dist < 0.05)
        continue
      // 弧顶至少高出地表，保证弧线浮在球面上方不扎进地球
      const lift = 1.016 + 0.07 + dist * 0.32
      const mid = from.clone().add(to).multiplyScalar(0.5).normalize().multiplyScalar(lift)
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48))
      const mat = new THREE.LineBasicMaterial({
        color: 0x8FD8FF,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      arcsGroup.add(new THREE.Line(geo, mat))
    }
  }
}

function startGlobe() {
  if (!canvasRef.value)
    return

  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, alpha: true, antialias: true })
  renderer.setPixelRatio(getCappedDpr())

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120)
  camera.position.set(0, 0, 3.4)
  camera.lookAt(0, 0, 0)

  tiltGroup = new THREE.Group()
  tiltGroup.rotation.x = BASE_TILT
  scene.add(tiltGroup)

  spinGroup = new THREE.Group()
  spinGroup.rotation.y = rotationYForCoord(CHINA_COORD[0], CHINA_COORD[1])
  tiltGroup.add(spinGroup)

  const earthTex = new THREE.TextureLoader().load(earthTextureUrl)
  earthTex.colorSpace = THREE.SRGBColorSpace
  earthTex.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 4
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshPhongMaterial({
      map: earthTex,
      shininess: 14,
      specular: new THREE.Color(0x1A2A3A),
    }),
  )
  spinGroup.add(earth)
  spinGroup.add(buildAtmosphere())

  // 云层：独立缓慢漂移，更有真实感
  const cloudsTex = new THREE.TextureLoader().load(cloudsTextureUrl)
  cloudsTex.colorSpace = THREE.SRGBColorSpace
  cloudsTex.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 4
  cloudsMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.008, 48, 48),
    new THREE.MeshLambertMaterial({
      map: cloudsTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  )
  spinGroup.add(cloudsMesh)

  arcsGroup = new THREE.Group()
  anchorsGroup = new THREE.Group()
  spinGroup.add(arcsGroup)
  spinGroup.add(anchorsGroup)

  // 太阳光 + 环境光：白天面明亮，夜晚面不至于死黑
  const sun = new THREE.DirectionalLight(0xFFF4E2, 2.8)
  sun.position.set(-4, 2.5, 4)
  scene.add(sun)
  scene.add(new THREE.AmbientLight(0x93A7C8, 0.45))

  scene.add(buildStars(1300, 16, 40))

  rebuildSceneObjects()
  resizeGlobe()
  syncRafState()
}

const { pause: pauseRaf, resume: resumeRaf } = useRafFn(
  () => {
    if (!renderer || !scene || !camera || !spinGroup)
      return
    if (!isPointerDown && shouldAutoRotate.value)
      spinGroup.rotation.y += AUTO_ROTATE_SPEED
    // 云层相对地表缓慢漂移
    if (cloudsMesh && !isPointerDown)
      cloudsMesh.rotation.y += 0.00012
    renderer.render(scene, camera)
    syncClusterOverlayPositions()
  },
  { immediate: false },
)

function stopGlobe() {
  pauseRaf()
  if (scene) {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry)
        mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) {
        material.forEach(m => m.dispose())
      }
      else if (material) {
        const withMap = material as THREE.MeshPhongMaterial
        withMap.map?.dispose()
        material.dispose()
      }
    })
  }
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
  tiltGroup = null
  spinGroup = null
  cloudsMesh = null
  arcsGroup = null
  anchorsGroup = null
  markerAnchors.clear()
}

function resizeGlobe() {
  if (!renderer || !camera)
    return
  const { width, height } = getRenderSize()
  if (width <= 0 || height <= 0)
    return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  syncClusterOverlayPositions()
}

const projectVec = new THREE.Vector3()
const camDir = new THREE.Vector3()

function syncClusterOverlayPosition(cluster: RegionCluster, el: HTMLDivElement) {
  const { width, height } = getRenderSize()
  const anchor = markerAnchors.get(cluster.code)
  if (!camera || !anchor || width <= 0 || height <= 0) {
    el.style.opacity = '0'
    return
  }
  anchor.getWorldPosition(projectVec)
  // 朝向相机的程度：>0 为可见面
  camDir.copy(camera.position).normalize()
  const facing = projectVec.clone().normalize().dot(camDir)
  projectVec.project(camera)
  const xPx = (projectVec.x * 0.5 + 0.5) * width
  const yPx = (-projectVec.y * 0.5 + 0.5) * height
  el.style.transform = `translate3d(${xPx}px, ${yPx}px, 0)`
  const visible = facing > 0.22 && projectVec.z < 1
  el.style.opacity = visible ? '1' : '0'
  el.style.filter = visible ? 'blur(0px)' : 'blur(20px)'
}

function syncClusterOverlayPositions() {
  for (const cluster of regionClusters.value) {
    const el = clusterOverlayEls.get(cluster.code)
    if (!el)
      continue
    syncClusterOverlayPosition(cluster, el)
  }
}

function setClusterOverlayEl(code: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLDivElement) {
    el.style.willChange = 'transform, opacity, filter'
    clusterOverlayEls.set(code, el)

    const cluster = regionClusters.value.find(item => item.code === code)
    if (cluster) {
      syncClusterOverlayPosition(cluster, el)
    }
    else {
      el.style.opacity = '0'
      el.style.filter = 'blur(20px)'
    }
    return
  }

  clusterOverlayEls.delete(code)
}

function bindClusterOverlayRef(code: string): (el: Element | ComponentPublicInstance | null) => void {
  const existingBinder = clusterOverlayRefBinders.get(code)
  if (existingBinder)
    return existingBinder

  const binder = (el: Element | ComponentPublicInstance | null) => setClusterOverlayEl(code, el)
  clusterOverlayRefBinders.set(code, binder)
  return binder
}

function syncRafState() {
  if (!renderer)
    return

  if (shouldRender.value && (shouldAutoRotate.value || isPointerDown)) {
    resumeRaf()
    return
  }

  pauseRaf()
  if (shouldRender.value && scene && camera) {
    renderer.render(scene, camera)
    syncClusterOverlayPositions()
  }
}

function resetStoppedView() {
  if (!spinGroup || !tiltGroup)
    return
  spinGroup.rotation.y = rotationYForCoord(CHINA_COORD[0], CHINA_COORD[1])
  tiltGroup.rotation.x = BASE_TILT
}

onMounted(() => {
  startGlobe()
})

onBeforeUnmount(() => {
  stopGlobe()
})

watch(
  [containerWidth, containerHeight],
  ([width, height]) => {
    if (!renderer || width <= 0 || height <= 0)
      return
    resizeGlobe()
  },
)

watch(
  () => appStore.earthViewMode,
  (mode) => {
    if (mode === 'earth-stop')
      resetStoppedView()
    syncRafState()
  },
)

watch(
  [() => regionClusters.value.map(clusterKey).join(','), userCoord],
  async () => {
    if (!spinGroup)
      return
    rebuildSceneObjects()
    await nextTick()
    syncClusterOverlayPositions()
    syncRafState()
  },
)

watch(shouldRender, () => {
  syncRafState()
})

function onPointerDown(e: PointerEvent) {
  isPointerDown = true
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  syncRafState()
}
function onPointerMove(e: PointerEvent) {
  if (!isPointerDown || !spinGroup || !tiltGroup)
    return
  const deltaX = e.clientX - lastPointerX
  const deltaY = e.clientY - lastPointerY
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  spinGroup.rotation.y += deltaX / 200
  tiltGroup.rotation.x = Math.min(Math.max(tiltGroup.rotation.x + deltaY / 300, MIN_TILT), MAX_TILT)
}
function onPointerUp(e: PointerEvent) {
  isPointerDown = false
  const target = e.currentTarget as HTMLElement
  if (target.hasPointerCapture(e.pointerId))
    target.releasePointerCapture(e.pointerId)
  syncRafState()
}

const totalServers = computed(() => displayNodes.value.length)
const onlineServers = computed(() => displayNodes.value.filter(node => node.online).length)
const offlineServers = computed(() => totalServers.value - onlineServers.value)

function rateFor(code: string): RegionRate {
  return regionRates.value.get(code) ?? { up: 0, down: 0 }
}

function formatRate(bytesPerSec: number): string {
  const { value, unit } = formatBytesPerSecondSplit(bytesPerSec, appStore.byteDecimals)
  return `${value} ${unit}`
}
</script>

<template>
  <div ref="containerRef" class="relative aspect-square w-full max-w-md mx-auto -translate-y-6 md:-translate-y-12">
    <!-- 太空暗角：星空感融入壁纸 -->
    <div
      class="absolute inset-0 pointer-events-none"
      style="background: radial-gradient(circle at 50% 50%, rgba(2,6,18,0.72) 0%, rgba(2,6,18,0.42) 52%, transparent 74%)"
    />
    <canvas
      ref="canvasRef"
      class="earth-globe-canvas absolute inset-0 w-full h-full select-none touch-none cursor-grab active:cursor-grabbing"
      @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    />

    <template v-for="cluster in regionClusters" :key="cluster.code">
      <div
        :ref="bindClusterOverlayRef(cluster.code)"
        class="absolute -top-7.5 left-0 pointer-events-none rounded backdrop-blur transition-[opacity,filter] duration-500"
      >
        <img
          :src="getApiAssetUrl(`flags/${cluster.code.toLowerCase()}.svg`)" :alt="cluster.code"
          class="size-4 block absolute -bottom-2 -left-2 z-1 drop-shadow-[0_0_2px_rgba(0,0,0,0.1)]"
        >
        <div class="relative z-2 bg-background/60 rounded py-0.5 px-1 text-xs zoom-80 items-start justify-center text-nowrap">
          <div class="text-green-600 flex flex-row items-center gap-0.5">
            <Icon icon="tabler:chevron-up" width="12" height="12" /> {{ formatRate(rateFor(cluster.code).up) }}
          </div>
          <div class="text-blue-600 flex flex-row items-center gap-0.5">
            <Icon icon="tabler:chevron-down" width="12" height="12" /> {{ formatRate(rateFor(cluster.code).down) }}
          </div>
        </div>
      </div>
    </template>

    <div
      v-if="totalServers > 0"
      class="absolute top-6 md:top-12 left-0 text-[10px] text-muted-foreground pointer-events-none flex gap-2 items-center backdrop-blur-lg bg-background/60 rounded px-2 py-0.5"
    >
      <div v-if="onlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-green-600 animate-pulse" />
        <span class="text-green-600">{{ onlineServers }}</span>
      </div>
      <div v-if="offlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-yellow-600 animate-pulse" />
        <span class="text-yellow-600">{{ offlineServers }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.earth-globe-canvas {
  contain: layout paint;
}
</style>
