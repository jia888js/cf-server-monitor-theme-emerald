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
  clearSignals()
  disposeGroup(anchorsGroup)
  markerAnchors.clear()

  for (const cluster of regionClusters.value) {
    const anchor = new THREE.Object3D()
    anchor.position.copy(latLonToVec3(cluster.coord[0], cluster.coord[1], 1.016))
    anchorsGroup.add(anchor)
    markerAnchors.set(cluster.code, anchor)
  }
}

// ---- 信号流星：节点之间随机互发，无固定顺序、无固定间隔 ----
// 造型：发光头部 + 一条连续的蝌蚪拖尾（头宽尾窄、头亮尾暗）
interface SignalPacket {
  curve: THREE.CatmullRomCurve3
  curveLen: number
  elapsed: number
  duration: number
  head: THREE.Sprite
  ribbon: THREE.Mesh
  ribbonGeo: THREE.BufferGeometry
  posAttr: THREE.BufferAttribute
  colAttr: THREE.BufferAttribute
}

const RIBBON_SEGMENTS = 18
const TAIL_WORLD_LEN = 0.3
const RIBBON_MAX_WIDTH = 0.012
const MAX_PACKETS = 8
let glowTex: THREE.CanvasTexture | null = null
let signalPackets: SignalPacket[] = []
let nextSignalAt = 0
let lastSignalFrameTime = 0

// 复用临时向量，避免每帧分配
const _sv1 = new THREE.Vector3()
const _sv2 = new THREE.Vector3()
const _svTan = new THREE.Vector3()
const _svView = new THREE.Vector3()
const _svSide = new THREE.Vector3()
const _svQ = new THREE.Quaternion()

function smooth01(x: number) {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * (3 - 2 * t)
}

function buildGlowTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.8)')
    grad.addColorStop(0.6, 'rgba(255,255,255,0.18)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeGlowSprite(color: number, size: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: glowTex,
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(size, size, 1)
  return sprite
}

function buildRibbonGeometry(): { geo: THREE.BufferGeometry, posAttr: THREE.BufferAttribute, colAttr: THREE.BufferAttribute } {
  const count = (RIBBON_SEGMENTS + 1) * 2
  const geo = new THREE.BufferGeometry()
  const posAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
  const colAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
  posAttr.setUsage(THREE.DynamicDrawUsage)
  colAttr.setUsage(THREE.DynamicDrawUsage)
  const index: number[] = []
  for (let i = 0; i < RIBBON_SEGMENTS; i++) {
    const a = i * 2
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  geo.setIndex(index)
  geo.setAttribute('position', posAttr)
  geo.setAttribute('color', colAttr)
  return { geo, posAttr, colAttr }
}

// 贴地飞行曲线：沿大圆方向插值，高度几乎贴着地表，中段只微微抬起
function groundHuggingCurve(from: THREE.Vector3, to: THREE.Vector3, dist: number): THREE.CatmullRomCurve3 {
  const N = 32
  const bump = 0.015 + dist * 0.02
  const angle = from.angleTo(to)
  const sinA = Math.sin(angle)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const p = new THREE.Vector3()
    if (sinA > 1e-6) {
      const wa = Math.sin((1 - t) * angle) / sinA
      const wb = Math.sin(t * angle) / sinA
      p.copy(from).multiplyScalar(wa).addScaledVector(to, wb).normalize()
    }
    else {
      p.copy(from).normalize()
    }
    p.multiplyScalar(1.016 + 0.012 + bump * Math.sin(Math.PI * t))
    pts.push(p)
  }
  return new THREE.CatmullRomCurve3(pts)
}

function spawnSignal() {
  const group = arcsGroup
  if (!group || !glowTex)
    return
  const clusters = regionClusters.value
  if (clusters.length < 2)
    return
  // 随机挑两台不同的机器
  const a = clusters[(Math.random() * clusters.length) | 0]
  let b = clusters[(Math.random() * clusters.length) | 0]
  if (!a || !b)
    return
  if (b === a) {
    const next = clusters[(clusters.indexOf(a) + 1) % clusters.length]
    if (!next)
      return
    b = next
  }
  const from = latLonToVec3(a.coord[0], a.coord[1], 1.016)
  const to = latLonToVec3(b.coord[0], b.coord[1], 1.016)
  const dist = from.distanceTo(to)
  if (dist < 0.05)
    return
  const curve = groundHuggingCurve(from, to, dist)

  const head = makeGlowSprite(0xEAF7FF, 0.05)
  const { geo, posAttr, colAttr } = buildRibbonGeometry()
  const ribbonMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const ribbon = new THREE.Mesh(geo, ribbonMat)
  ribbon.frustumCulled = false

  group.add(head)
  group.add(ribbon)
  signalPackets.push({
    curve,
    curveLen: Math.max(curve.getLength(), 0.001),
    elapsed: 0,
    duration: 600 + dist * 800,
    head,
    ribbon,
    ribbonGeo: geo,
    posAttr,
    colAttr,
  })
}

function removeSignalPacket(group: THREE.Group, index: number) {
  const p = signalPackets[index]
  if (!p)
    return
  group.remove(p.head)
  group.remove(p.ribbon)
  p.ribbonGeo.dispose()
  ;(p.ribbon.material as THREE.Material).dispose()
  ;(p.head.material as THREE.Material).dispose()
  signalPackets.splice(index, 1)
}

function clearSignals() {
  const group = arcsGroup
  if (group) {
    for (let i = signalPackets.length - 1; i >= 0; i--)
      removeSignalPacket(group, i)
  }
  else {
    signalPackets = []
  }
  nextSignalAt = 0
}

// 更新蝌蚪拖尾：面向相机的飘带，宽度头宽尾窄、亮度头亮尾暗
function updateRibbon(p: SignalPacket, t: number, env: number, spin: THREE.Group, cam: THREE.PerspectiveCamera) {
  spin.getWorldQuaternion(_svQ).invert()
  const pos = p.posAttr.array as Float32Array
  const col = p.colAttr.array as Float32Array
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const frac = i / RIBBON_SEGMENTS
    const back = frac * TAIL_WORLD_LEN
    const tt = Math.max(t - back / p.curveLen, 0)
    const pt = p.curve.getPoint(tt)
    const ptAhead = p.curve.getPoint(Math.min(tt + 0.004, 1))
    // 切向与朝向（世界空间），再转回 spinGroup 本地空间
    _sv1.copy(pt).applyMatrix4(spin.matrixWorld)
    _sv2.copy(ptAhead).applyMatrix4(spin.matrixWorld)
    _svTan.copy(_sv2).sub(_sv1)
    if (_svTan.lengthSq() < 1e-10)
      _svTan.set(0, 1, 0)
    _svTan.normalize()
    _svView.copy(cam.position).sub(_sv1).normalize()
    _svSide.crossVectors(_svTan, _svView)
    if (_svSide.lengthSq() < 1e-10)
      _svSide.set(1, 0, 0)
    _svSide.normalize().applyQuaternion(_svQ)

    const w = RIBBON_MAX_WIDTH * (1 - frac) ** 1.6
    const b = (1 - frac) ** 1.8 * env
    const o = i * 6
    pos[o] = pt.x + _svSide.x * w
    pos[o + 1] = pt.y + _svSide.y * w
    pos[o + 2] = pt.z + _svSide.z * w
    pos[o + 3] = pt.x - _svSide.x * w
    pos[o + 4] = pt.y - _svSide.y * w
    pos[o + 5] = pt.z - _svSide.z * w
    // 加色混合：颜色越暗越透明，头亮尾暗
    const r = 0.62 * b
    const g = 0.86 * b
    const bl = 1.0 * b
    col[o] = r
    col[o + 1] = g
    col[o + 2] = bl
    col[o + 3] = r
    col[o + 4] = g
    col[o + 5] = bl
  }
  p.posAttr.needsUpdate = true
  p.colAttr.needsUpdate = true
}

function updateSignals(now: number) {
  const group = arcsGroup
  const spin = spinGroup
  const cam = camera
  if (!group || !spin || !cam)
    return
  const dt = lastSignalFrameTime > 0 ? Math.min(now - lastSignalFrameTime, 50) : 16
  lastSignalFrameTime = now

  // 随机发射：无固定顺序、无固定间隔
  if (now >= nextSignalAt && signalPackets.length < MAX_PACKETS) {
    spawnSignal()
    nextSignalAt = now + 350 + Math.random() * 1500
  }

  for (let i = signalPackets.length - 1; i >= 0; i--) {
    const p = signalPackets[i]
    if (!p)
      continue
    p.elapsed += dt
    const t = Math.min(p.elapsed / p.duration, 1)
    // 淡入淡出包络：像信号发射出去又落下
    const env = smooth01(t / 0.12) * (1 - smooth01((t - 0.72) / 0.28))
    p.head.position.copy(p.curve.getPoint(t))
    ;(p.head.material as THREE.SpriteMaterial).opacity = env
    updateRibbon(p, t, env, spin, cam)
    if (t >= 1)
      removeSignalPacket(group, i)
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

  glowTex = buildGlowTexture()
  lastSignalFrameTime = 0
  nextSignalAt = 0
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
    // 信号流星：节点之间随机互发
    updateSignals(performance.now())
    renderer.render(scene, camera)
    syncClusterOverlayPositions()
  },
  { immediate: false },
)

function stopGlobe() {
  pauseRaf()
  clearSignals()
  glowTex?.dispose()
  glowTex = null
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
  [() => regionClusters.value.map(clusterKey).join(',')],
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
