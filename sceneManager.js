import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/******************************
 * 全局变量与初始设置
 ******************************/
let scene, camera, renderer, labelRenderer, controls;
let transformControls;
let mirrorRoot;
const objectsWithLabels = [];
const selectableObjects = []; // 可选择的物体数组
// let labelsVisible removed; use per-field visibility
let showName = true;
let animationFrameId = null;
let isEditMode = true; // 始终处于编辑模式
let currentJsonData = null; // 当前的JSON数据，用于实时更新
let selectedObjects = []; // 当前选中的物体数组（支持多选）
let raycaster, mouse; // 用于射线检测点击
let isProgrammaticJsonUpdate = false; // 程序化更新textarea时抑制oninput
let autoShowLabelsTimer = null; // 自动显示所有标签的定时器
let showAllLabelsMode = false; // 是否显示所有标签模式（选中3秒后自动触发）
let autoShowLabelsDelay = 1000; // 自动显示所有标签的延迟时间（毫秒），默认3秒

function setTransformSnapFromUnits() {
  if (transformControls) {
    const snapWorld = 0.01 * posUnitFactor; // JSON最小单位0.01 → Three单位
    try { transformControls.setTranslationSnap(snapWorld); } catch(e) { /* older versions may differ */ }
  }
}

// 启动自动显示所有标签的定时器（3秒后）
function startAutoShowLabelsTimer() {
  // 清除现有定时器
  if (autoShowLabelsTimer) {
    clearTimeout(autoShowLabelsTimer);
    autoShowLabelsTimer = null;
  }
  
  // 重置模式
  showAllLabelsMode = false;
  
  // 只有在有选中对象时才启动定时器
  if (selectedObjects.length > 0) {
    autoShowLabelsTimer = setTimeout(() => {
      showAllLabelsMode = true;
      console.log(`${autoShowLabelsDelay/1000}秒已过，自动显示所有标签模式启动`);
      // 刷新所有标签显示
      objectsWithLabels.forEach(updateLabel);
    }, autoShowLabelsDelay);
  }
}

// 清除自动显示所有标签的定时器
function clearAutoShowLabelsTimer() {
  if (autoShowLabelsTimer) {
    clearTimeout(autoShowLabelsTimer);
    autoShowLabelsTimer = null;
  }
  showAllLabelsMode = false;
}

/******************************
 * 数据格式检测与适配
 ******************************/
// 检测数据格式类型
function detectDataFormat(data) {
  if (!data) return 'unknown';
  
  // 检测新格式：包含 beats 和 route
  if (data.beats && Array.isArray(data.beats) && data.route) {
    return 'level';
  }
  
  // 检测旧格式：包含 objects 数组
  if (data.objects && Array.isArray(data.objects)) {
    return 'scene';
  }
  
  return 'unknown';
}

// Phase 颜色映射
const PHASE_COLORS = {
  intro: 0x00ff00,        // 绿色
  pressure: 0xffff00,     // 黄色
  brief_rest: 0x00ffff,   // 青色
  hell: 0xff0000,         // 红色
  finale: 0xff00ff,       // 紫色
  default: 0xcccccc       // 默认灰色
};

// 获取 phase 对应的颜色
function getPhaseColor(phase) {
  return PHASE_COLORS[phase] || PHASE_COLORS.default;
}

// 解析 Beat 数据，从 aabb_min/max 计算盒子参数
function parseBeatData(beat) {
  const aabbMin = beat.aabb_min || [0, 0, 0];
  const aabbMax = beat.aabb_max || [0, 0, 0];
  
  // 计算中心位置
  const centerX = (aabbMin[0] + aabbMax[0]) / 2;
  const centerY = (aabbMin[1] + aabbMax[1]) / 2;
  const centerZ = (aabbMin[2] + aabbMax[2]) / 2;
  
  // 计算尺寸
  const sizeX = Math.abs(aabbMax[0] - aabbMin[0]);
  const sizeY = Math.abs(aabbMax[1] - aabbMin[1]);
  const sizeZ = Math.abs(aabbMax[2] - aabbMin[2]);
  
  return {
    position: [centerX, centerY, centerZ],
    size: [sizeX, sizeY, sizeZ],
    beat_index: beat.beat_index,
    difficulty: beat.difficulty,
    phase: beat.phase,
    intensity: beat.intensity,
    guideline_key_points: beat.guideline_key_points || [],
    overlap_regions: beat.overlap_regions || []
  };
}

// 解析 Route 数据
function parseRouteData(route) {
  if (!route) return null;
  
  return {
    key_points: route.key_points || [],
    spawn: route.spawn || null,
    goal: route.goal || null
  };
}

// --- 颜色解析与确定性颜色 ---
function parseColorToNumber(input) {
  if (typeof input === 'number') {
    return (input >>> 0) & 0xFFFFFF;
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('#')) {
      return parseInt(s.slice(1), 16) & 0xFFFFFF;
    }
    if (s.startsWith('0x') || s.startsWith('0X')) {
      return parseInt(s.slice(2), 16) & 0xFFFFFF;
    }
    const n = parseInt(s, 10);
    if (!Number.isNaN(n)) return (n >>> 0) & 0xFFFFFF;
  }
  return 0xCCCCCC; // fallback
}

function hashStringDJB2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0;
}

function getDeterministicColorForKey(key) {
  const hash = hashStringDJB2(key);
  // 取24位颜色，并提升亮度避免过暗
  let color = hash & 0x00FFFFFF;
  // 简单提升亮度：与中等亮度做或运算
  color = color | 0x303030;
  return color >>> 0;
}

function roundTo(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// --- 焦距和FOV转换函数 ---
// 根据焦距计算FOV（度）
function focalLengthToFOV(focalLength, sensorWidth = 36) {
  const fovRadians = 2 * Math.atan(sensorWidth / (2 * focalLength));
  return THREE.MathUtils.radToDeg(fovRadians);
}

// 根据FOV计算焦距（mm）
function fovToFocalLength(fovDegrees, sensorWidth = 36) {
  const fovRadians = THREE.MathUtils.degToRad(fovDegrees);
  return sensorWidth / (2 * Math.tan(fovRadians / 2));
}

// --- 单位系统设置 ---
// 位置倍率: UE 单位(厘米) × posUnitFactor → Three.js 单位
let posUnitFactor = 1;
// 尺寸倍率: UE Scale(米) × scaleUnitFactor → Three.js 单位
let scaleUnitFactor = 100;
// 旋转单位: 'deg' 或 'rad'
let rotationUnit = 'deg';
// --- 相机焦距设置 ---
let focalLength = 35; // 焦距(mm)
const sensorWidth = 36; // 传感器宽度(mm) - 35mm全画幅标准
// --- 颜色设置 ---
let useRandomColor = true;
let customColor = 0xffffff;

// --- 标签显示选项 ---
let showPosition = false;
let showRotation = false;
let showScale = false;
let showDistance = false;

// --- 深度预览模式 ---
let depthPreviewMode = false;
let depthInvert = false; // 深度反相开关
const originalMaterials = new Map(); // 保存原始材质

/******************************
 * 初始化折叠面板
 ******************************/
function initCollapsiblePanels() {
  // 处理info面板
  const info = document.getElementById('info');
  if (info) {
    const originalContent = info.innerHTML;
    info.innerHTML = `
      <div id="infoHeader" style="padding: 5px 10px; background-color: rgba(50,50,50,0.9); cursor: move; font-weight: bold; display: flex; justify-content: space-between; align-items: center; user-select: none;">
        <span>信息</span>
        <span id="infoCollapseIcon" style="cursor: pointer;">▼</span>
      </div>
      <div id="infoContent" style="padding: 10px;">
        ${originalContent}
      </div>
    `;

    // 绑定折叠事件
    const infoHeader = document.getElementById('infoHeader');
    const infoIcon = document.getElementById('infoCollapseIcon');
    if (infoHeader && infoIcon) {
      // 折叠功能 - 只在点击图标时触发
      infoIcon.onclick = (e) => {
        e.stopPropagation(); // 防止触发拖动
        info.classList.toggle('collapsed');
        infoIcon.textContent = info.classList.contains('collapsed') ? '▲' : '▼';
      };

      // 拖动功能
      let isDragging = false;
      let startX, startY, startLeft, startTop;

      infoHeader.onmousedown = (e) => {
        // 如果点击的是折叠图标，不启动拖动
        if (e.target === infoIcon) {
          return;
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // 获取当前位置
        const rect = info.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        // 改为使用 left/top 定位以便拖动
        info.style.right = 'auto';
        info.style.bottom = 'auto';
        info.style.left = startLeft + 'px';
        info.style.top = startTop + 'px';

        e.preventDefault();
      };

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const newLeft = startLeft + deltaX;
        const newTop = startTop + deltaY;

        // 限制在窗口范围内
        const maxLeft = window.innerWidth - info.offsetWidth;
        const maxTop = window.innerHeight - info.offsetHeight;

        info.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
        info.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
        }
      });
    }
  }

  // 处理unitSettings面板
  const unitSettings = document.getElementById('unitSettings');
  if (unitSettings) {
    const originalContent = unitSettings.innerHTML;
    unitSettings.innerHTML = `
      <div id="unitSettingsHeader" style="padding: 5px 10px; background-color: rgba(50,50,50,0.9); cursor: move; font-weight: bold; display: flex; justify-content: space-between; align-items: center; user-select: none;">
        <span>设置</span>
        <span id="unitSettingsCollapseIcon" style="cursor: pointer;">▼</span>
      </div>
      <div id="unitSettingsContent" style="padding: 8px 10px;">
        ${originalContent}
      </div>
    `;

    // 绑定折叠事件
    const unitSettingsHeader = document.getElementById('unitSettingsHeader');
    const unitSettingsIcon = document.getElementById('unitSettingsCollapseIcon');
    if (unitSettingsHeader && unitSettingsIcon) {
      // 折叠功能 - 只在点击图标时触发
      unitSettingsIcon.onclick = (e) => {
        e.stopPropagation(); // 防止触发拖动
        unitSettings.classList.toggle('collapsed');
        unitSettingsIcon.textContent = unitSettings.classList.contains('collapsed') ? '▲' : '▼';
      };

      // 拖动功能
      let isDragging = false;
      let startX, startY, startLeft, startTop;

      unitSettingsHeader.onmousedown = (e) => {
        // 如果点击的是折叠图标，不启动拖动
        if (e.target === unitSettingsIcon) {
          return;
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // 获取当前位置
        const rect = unitSettings.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        // 改为使用 left/top 定位以便拖动
        unitSettings.style.right = 'auto';
        unitSettings.style.bottom = 'auto';
        unitSettings.style.left = startLeft + 'px';
        unitSettings.style.top = startTop + 'px';

        e.preventDefault();
      };

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const newLeft = startLeft + deltaX;
        const newTop = startTop + deltaY;

        // 限制在窗口范围内
        const maxLeft = window.innerWidth - unitSettings.offsetWidth;
        const maxTop = window.innerHeight - unitSettings.offsetHeight;

        unitSettings.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
        unitSettings.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
        }
      });
    }
  }
}

// 切换深度预览模式
function toggleDepthPreview(enabled) {
  depthPreviewMode = enabled;

  if (!camera) {
    console.warn('Camera not initialized');
    return;
  }

  if (enabled) {
    // 计算场景中所有物体到相机的距离范围
    let minDist = Infinity;
    let maxDist = -Infinity;

    selectableObjects.forEach(mesh => {
      const dist = camera.position.distanceTo(mesh.position);
      minDist = Math.min(minDist, dist);
      maxDist = Math.max(maxDist, dist);
    });

    // 扩展范围5%以避免边界情况
    const range = maxDist - minDist;
    minDist -= range * 0.05;
    maxDist += range * 0.05;

    console.log(`深度范围: ${minDist.toFixed(2)} - ${maxDist.toFixed(2)}`);

    selectableObjects.forEach(mesh => {
      // 保存原始材质并切换到深度材质
      if (!originalMaterials.has(mesh)) {
        originalMaterials.set(mesh, mesh.material);
      }

      // 使用自定义ShaderMaterial来可视化深度
      const depthMaterial = new THREE.ShaderMaterial({
        uniforms: {
          minDepth: { value: minDist },
          maxDepth: { value: maxDist },
          cameraPos: { value: camera.position.clone() },
          invertDepth: { value: depthInvert ? 1.0 : 0.0 }
        },
        vertexShader: `
          varying vec3 vWorldPosition;
          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float minDepth;
          uniform float maxDepth;
          uniform vec3 cameraPos;
          uniform float invertDepth;
          varying vec3 vWorldPosition;

          void main() {
            // 计算到相机的距离
            float depth = distance(vWorldPosition, cameraPos);

            // 归一化深度值 (0.0 = 近, 1.0 = 远)
            float normalizedDepth = (depth - minDepth) / (maxDepth - minDepth);
            normalizedDepth = clamp(normalizedDepth, 0.0, 1.0);

            // 默认: 近白远黑 (反转深度值)
            // 反相: 近黑远白 (不反转)
            if (invertDepth < 0.5) {
              normalizedDepth = 1.0 - normalizedDepth;
            }

            // 黑白渐变
            vec3 color = vec3(normalizedDepth);

            gl_FragColor = vec4(color, 1.0);
          }
        `,
        side: THREE.DoubleSide
      });

      mesh.material = depthMaterial;
      console.log(`切换到深度材质: ${mesh.userData?.name || 'Unknown'}, 距离: ${camera.position.distanceTo(mesh.position).toFixed(2)}`);
    });
  } else {
    // 恢复原始材质
    selectableObjects.forEach(mesh => {
      const originalMaterial = originalMaterials.get(mesh);
      if (originalMaterial) {
        mesh.material = originalMaterial;
        console.log(`恢复原始材质: ${mesh.userData?.name || 'Unknown'}`);
      }
    });
  }

  console.log(`深度预览模式: ${enabled ? '开启' : '关闭'}`);
}

// 更新深度反相
function updateDepthInvert(invert) {
  depthInvert = invert;

  // 更新所有深度材质的invertDepth uniform
  selectableObjects.forEach(mesh => {
    if (mesh.material.uniforms && mesh.material.uniforms.invertDepth !== undefined) {
      mesh.material.uniforms.invertDepth.value = invert ? 1.0 : 0.0;
    }
  });

  console.log(`深度反相: ${invert ? '开启' : '关闭'}`);
}

/******************************
 * 默认数据（作为后备）
 ******************************/
const defaultData = {
  camera: {
    position: [-50, 0, 180],
    rotation: [-8, 0, 0],
    fov: 65
  },
  objects: []
};

/******************************
 * 初始化入口
 ******************************/
export async function boot() {
  console.log("Booting application...");

  // 初始化折叠面板
  initCollapsiblePanels();

  const jsonData = await loadSceneData();
  currentJsonData = JSON.parse(JSON.stringify(jsonData)); // 深拷贝保存当前数据
  initScene(currentJsonData); 
  // initUI(jsonData); // 暂时注释掉，先确保场景渲染正常
  // animate(); // 暂时注释掉，先进行单帧调试

  // 在initScene之后立即进行调试和单帧渲染
  if (scene && camera && renderer) {
    console.log("--- Post initScene Debug Info ---");
    console.log("Camera Position:", camera.position);
    console.log("Camera Rotation (Euler radians):", camera.rotation);
    console.log("Camera Near:", camera.near, "Camera Far:", camera.far, "Camera FOV:", camera.fov);
    console.log("Controls Target:", controls ? controls.target : "N/A");
    
    if (mirrorRoot && mirrorRoot.children.length > 0) {
      const firstObject = mirrorRoot.children.find(child => child.type === "Mesh");
      if (firstObject) {
        console.log("First Mesh Position:", firstObject.position);
        console.log("First Mesh Scale:", firstObject.scale);
        console.log("First Mesh Visible:", firstObject.visible);
        // 尝试让相机看向第一个物体
        // camera.lookAt(firstObject.position);
        // controls.target.copy(firstObject.position);
      } else {
        console.log("No mesh found directly in mirrorRoot. AxesHelper count:", mirrorRoot.children.filter(c => c.type === "AxesHelper").length);
      }
    } else {
      console.log("mirrorRoot is empty or not initialized.");
    }
    console.log("Scene children count:", scene.children.length);
    console.log("mirrorRoot children count:", mirrorRoot ? mirrorRoot.children.length : "N/A");

    try {
      renderer.render(scene, camera);
      if (labelRenderer) labelRenderer.render(scene, camera);
      console.log("--- Single frame rendered successfully after initScene ---");
      
      // 在这里重新启动UI和动画，确保它们在场景完全设置好之后运行
      console.log("Re-enabling UI and animation loop...");
      initUI(jsonData); // 重新启用UI初始化
      animate(); // 重新启用动画循环

    } catch (renderError) {
      console.error("Error during single frame render after initScene:", renderError);
    }
  } else {
    console.error("Scene, camera, or renderer not initialized for post-init debug.");
  }
  console.log("Application booted.");
}

/******************************
 * 加载 JSON 数据
 ******************************/
async function loadSceneData() {
  console.log("Loading scene data...");
  if (window.location.protocol === 'file:') {
    console.warn('Using file:// protocol, returning default data.');
    updateInfoContent('使用内置数据 (file://协议)。如需加载外部JSON, 请通过HTTP服务器访问。');
    return defaultData;
  }
  const paths = [
    'scene_data.json',
    './scene_data.json',
    `scene_data.json?t=${Date.now()}` // 添加时间戳防止缓存
  ];
  for (const path of paths) {
    try {
      console.log(`Attempting to fetch data from: ${path}`);
      const res = await fetch(path);
      if (res.ok) {
        const data = await res.json();
        console.log(`Successfully loaded JSON data from: ${path}`, data);
        updateInfoContent(`从 ${path} 加载数据成功`);
        return data;
      } else {
        console.warn(`Failed to fetch from ${path}, status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`Error fetching from ${path}:`, e);
    }
  }
  console.error('All fetch attempts failed, returning default data.');
  updateInfoContent('加载外部JSON失败，使用内置数据。');
  return defaultData;
}

// 更新info内容的辅助函数
function updateInfoContent(message) {
  const infoContent = document.getElementById('infoContent');
  if (infoContent) {
    // 保留原有内容并添加新消息
    const lines = infoContent.innerHTML.split('<br>');
    if (lines.length > 2) {
      lines.splice(2, 1); // 移除旧的加载消息
    }
    infoContent.innerHTML = lines[0] + '<br>' + lines[1] + '<br>' + message;
  } else {
    // 如果还没有初始化折叠结构，直接设置info
    const info = document.getElementById('info');
    if (info) {
      info.innerHTML = message;
    }
  }
}

/******************************
 * 自动相机定位
 ******************************/
function calculateSceneBounds() {
  const box = new THREE.Box3();
  
  selectableObjects.forEach(obj => {
    const objBox = new THREE.Box3().setFromObject(obj);
    box.union(objBox);
  });
  
  return box;
}

function setupCameraForScene(sceneBox) {
  if (sceneBox.isEmpty()) {
    console.warn("Scene box is empty, using default camera position");
    camera.position.set(100 * posUnitFactor, 100 * posUnitFactor, 100 * posUnitFactor);
    controls.target.set(0, 0, 0);
    return;
  }
  
  const center = new THREE.Vector3();
  sceneBox.getCenter(center);
  
  const size = new THREE.Vector3();
  sceneBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  
  const fov = camera.fov * (Math.PI / 180);
  const cameraDistance = maxDim / (2 * Math.tan(fov / 2)) * 1.5;
  
  const angle = Math.PI / 4;
  camera.position.set(
    center.x + cameraDistance * Math.cos(angle),
    center.y - cameraDistance * Math.sin(angle),
    center.z + cameraDistance * 0.7
  );
  
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
  
  console.log(`Auto camera setup: center=${center.toArray()}, distance=${cameraDistance.toFixed(2)}`);
}

/******************************
 * 场景初始化
 ******************************/
function initScene(data) {
  console.log("Initializing scene with data:", data);
  try {
    cleanUpExistingScene();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x303030);
    mirrorRoot = new THREE.Group();
    mirrorRoot.scale.y = -1;
    scene.add(mirrorRoot);

    // 检测数据格式
    const dataFormat = detectDataFormat(data);
    console.log(`Detected data format: ${dataFormat}`);

    // 初始化相机
    const camData = data.camera || defaultData.camera;
    camera = new THREE.PerspectiveCamera(camData.fov || 65, window.innerWidth / window.innerHeight, 0.1, 1e6);
    camera.up.set(0, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    document.body.appendChild(labelRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1000, 1000, 1000);
    scene.add(dirLight);

    const axesHelper = new THREE.AxesHelper(5000);
    mirrorRoot.add(axesHelper);
    const axesLabels = ['X', 'Y', 'Z'];
    const axesColors = [0xff0000, 0x00ff00, 0x0000ff];
    axesLabels.forEach((axis, index) => {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'label';
        labelDiv.textContent = axis;
        labelDiv.style.color = `#${new THREE.Color(axesColors[index]).getHexString()}`;
        labelDiv.style.fontSize = '30px';
        labelDiv.style.fontWeight = 'bold';
        const label = new CSS2DObject(labelDiv);
        const pos = [0,0,0];
        pos[index] = 5500;
        label.position.set(...pos);
        axesHelper.add(label);
    });

    // 根据数据格式创建场景对象
    if (dataFormat === 'level') {
      // 新格式：创建 beats 和 route
      console.log('Loading level data format');
      updateInfoContent('加载关卡数据格式 (Beats + Route)');
      
      if (data.beats && Array.isArray(data.beats)) {
        data.beats.forEach((beat, index) => createBeat(beat, index));
      }
      if (data.route) {
        createRoute(data.route);
      }
    } else if (dataFormat === 'scene') {
      // 旧格式：创建 objects
      console.log('Loading scene data format');
      updateInfoContent('加载场景数据格式 (Objects)');
      
      if (data.objects && Array.isArray(data.objects)) {
        data.objects.forEach((objData, index) => createObject(objData, index));
      }
    }

    // 初始化变换控制器和点击检测
    initTransformControls();
    initMouseInteraction();

    // 自动设置相机位置
    if (dataFormat === 'level' || (dataFormat === 'scene' && selectableObjects.length > 0)) {
      const sceneBox = calculateSceneBounds();
      setupCameraForScene(sceneBox);
    } else if (data.camera) {
      // 使用数据中提供的相机设置
      camera.position.set(...camData.position.map(p => p * posUnitFactor));
      const camRotVec = rotationUnit === 'deg' ? camData.rotation.map(r => THREE.MathUtils.degToRad(r)) : camData.rotation;
      camera.rotation.set(...camRotVec);
      
      if (data.objects && data.objects.length > 0) {
        const firstObjPos = data.objects[0].position;
        controls.target.set(firstObjPos[0] * posUnitFactor, firstObjPos[1] * posUnitFactor, firstObjPos[2] * posUnitFactor);
      } else {
        controls.target.set(0, 0, 0);
      }
      camera.lookAt(controls.target);
      controls.update();
    }

    window.addEventListener('resize', onResize, false);
    console.log("Scene initialized successfully.");
  } catch (error) {
    console.error("Error during scene initialization:", error);
    const errorDisplay = document.getElementById('info') || document.body.appendChild(document.createElement('div'));
    errorDisplay.innerHTML += `<br><strong style="color:red;">场景初始化失败: ${error.message}. 请检查控制台.</strong>`;
  }
}

function createObject(objData, objectIndex) {
  try {
    const scale = objData.scale || [1,1,1];
    const position = objData.position || [0,0,0];
    const rotation = objData.rotation || [0,0,0];

    // 将 UE 中的尺寸(单位: cm 或 ScaleFactor) 转换为 Three.js 长度
    const geoSize = scale.map(s => s * scaleUnitFactor);
    const geo = new THREE.BoxGeometry(...geoSize);
    // 颜色优先级：objData.color > 自定义颜色(当useRandomColor为false) > 确定性颜色
    let colorValue;
    if (objData.color !== undefined && objData.color !== null) {
      colorValue = parseColorToNumber(objData.color);
    } else if (!useRandomColor) {
      colorValue = customColor;
    } else {
      const key = `${objData.name || 'Object'}#${objectIndex}`;
      colorValue = getDeterministicColorForKey(key);
    }
    const mat = new THREE.MeshStandardMaterial({ color: colorValue, roughness: 0.7, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    const posVec = position.map(p => p * posUnitFactor);
    mesh.position.set(...posVec);
    const rotVec = rotationUnit === 'deg' ? rotation.map(r => THREE.MathUtils.degToRad(r)) : rotation;
    mesh.rotation.set(...rotVec);

    // 给mesh添加userData来保存原始数据引用与稳定索引
    mesh.userData = { originalData: objData, objectIndex, name: objData.name };

    // 保存原始材质（用于深度预览切换）
    originalMaterials.set(mesh, mat);

    mirrorRoot.add(mesh);
    selectableObjects.push(mesh); // 添加到可选择对象数组

    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    const labelObj = new CSS2DObject(labelDiv);
    labelObj.position.set(0, 0, 0);
    mesh.add(labelObj);

    objectsWithLabels.push({ mesh, labelObj, labelDiv, data: objData });
  } catch(e){
      console.error("Error creating object:", objData, e);
  }
}

// 创建 Beat 可视化（半透明盒子）
function createBeat(beatData, beatIndex) {
  try {
    const parsed = parseBeatData(beatData);
    
    const geo = new THREE.BoxGeometry(
      parsed.size[0] * posUnitFactor,
      parsed.size[1] * posUnitFactor,
      parsed.size[2] * posUnitFactor
    );
    
    const color = getPhaseColor(parsed.phase);
    
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      transparent: true,
      opacity: 0.3,
      roughness: 0.7,
      side: THREE.DoubleSide
    });
    
    const mesh = new THREE.Mesh(geo, mat);
    
    const posVec = parsed.position.map(p => p * posUnitFactor);
    mesh.position.set(...posVec);
    
    const edges = new THREE.EdgesGeometry(geo);
    const lineMat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
    const wireframe = new THREE.LineSegments(edges, lineMat);
    mesh.add(wireframe);
    
    mesh.userData = {
      type: 'beat',
      beatData: parsed,
      beatIndex: beatIndex,
      name: `Beat #${parsed.beat_index}`
    };
    
    originalMaterials.set(mesh, mat);
    
    mirrorRoot.add(mesh);
    selectableObjects.push(mesh);
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    const labelObj = new CSS2DObject(labelDiv);
    labelObj.position.set(0, 0, 0);
    mesh.add(labelObj);
    
    const labelData = {
      name: `Beat #${parsed.beat_index}`,
      beat_index: parsed.beat_index,
      phase: parsed.phase,
      difficulty: parsed.difficulty,
      intensity: parsed.intensity
    };
    
    objectsWithLabels.push({ mesh, labelObj, labelDiv, data: labelData, type: 'beat' });
    
    console.log(`Created beat #${parsed.beat_index}`);
  } catch(e) {
    console.error("Error creating beat:", beatData, e);
  }
}

// 创建 Route 可视化（球体和连线）
function createRoute(routeData) {
  try {
    const parsed = parseRouteData(routeData);
    if (!parsed) return;
    
    const keyPoints = parsed.key_points;
    const spawn = parsed.spawn;
    const goal = parsed.goal;
    
    // 创建连线
    if (keyPoints.length > 1) {
      const points = keyPoints.map(pt => 
        new THREE.Vector3(
          pt.x * posUnitFactor,
          pt.y * posUnitFactor,
          pt.z * posUnitFactor
        )
      );
      
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        linewidth: 3
      });
      const line = new THREE.Line(lineGeometry, lineMaterial);
      line.userData = { type: 'route_line', name: 'Route Path' };
      mirrorRoot.add(line);
    }
    
    // 创建关键点球体
    keyPoints.forEach((pt, index) => {
      const sphereGeo = new THREE.SphereGeometry(0.5 * posUnitFactor, 16, 16);
      const sphereMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.5
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(
        pt.x * posUnitFactor,
        pt.y * posUnitFactor,
        pt.z * posUnitFactor
      );
      
      sphere.userData = {
        type: 'route_point',
        pointIndex: index,
        name: `Point #${index + 1}`,
        position: [pt.x, pt.y, pt.z]
      };
      
      originalMaterials.set(sphere, sphereMat);
      mirrorRoot.add(sphere);
      selectableObjects.push(sphere);
      
      const labelDiv = document.createElement('div');
      labelDiv.className = 'label';
      const labelObj = new CSS2DObject(labelDiv);
      labelObj.position.set(0, 0, 0);
      sphere.add(labelObj);
      
      const labelData = {
        name: `Point #${index + 1}`,
        position: [pt.x, pt.y, pt.z]
      };
      
      objectsWithLabels.push({ mesh: sphere, labelObj, labelDiv, data: labelData, type: 'route_point' });
    });
    
    // Spawn 点
    if (spawn) {
      const spawnGeo = new THREE.SphereGeometry(0.8 * posUnitFactor, 16, 16);
      const spawnMat = new THREE.MeshStandardMaterial({
        color: 0x00ff00,
        emissive: 0x003300,
        roughness: 0.3
      });
      const spawnSphere = new THREE.Mesh(spawnGeo, spawnMat);
      spawnSphere.position.set(
        spawn.x * posUnitFactor,
        spawn.y * posUnitFactor,
        spawn.z * posUnitFactor
      );
      
      spawnSphere.userData = {
        type: 'spawn',
        name: 'Spawn',
        position: [spawn.x, spawn.y, spawn.z]
      };
      
      originalMaterials.set(spawnSphere, spawnMat);
      mirrorRoot.add(spawnSphere);
      selectableObjects.push(spawnSphere);
      
      const labelDiv = document.createElement('div');
      labelDiv.className = 'label';
      const labelObj = new CSS2DObject(labelDiv);
      labelObj.position.set(0, 0, 0);
      spawnSphere.add(labelObj);
      
      const labelData = {
        name: 'Spawn',
        position: [spawn.x, spawn.y, spawn.z]
      };
      
      objectsWithLabels.push({ mesh: spawnSphere, labelObj, labelDiv, data: labelData, type: 'spawn' });
    }
    
    // Goal 点
    if (goal) {
      const goalGeo = new THREE.SphereGeometry(0.8 * posUnitFactor, 16, 16);
      const goalMat = new THREE.MeshStandardMaterial({
        color: 0x0000ff,
        emissive: 0x000033,
        roughness: 0.3
      });
      const goalSphere = new THREE.Mesh(goalGeo, goalMat);
      goalSphere.position.set(
        goal.x * posUnitFactor,
        goal.y * posUnitFactor,
        goal.z * posUnitFactor
      );
      
      goalSphere.userData = {
        type: 'goal',
        name: 'Goal',
        position: [goal.x, goal.y, goal.z]
      };
      
      originalMaterials.set(goalSphere, goalMat);
      mirrorRoot.add(goalSphere);
      selectableObjects.push(goalSphere);
      
      const labelDiv = document.createElement('div');
      labelDiv.className = 'label';
      const labelObj = new CSS2DObject(labelDiv);
      labelObj.position.set(0, 0, 0);
      goalSphere.add(labelObj);
      
      const labelData = {
        name: 'Goal',
        position: [goal.x, goal.y, goal.z]
      };
      
      objectsWithLabels.push({ mesh: goalSphere, labelObj, labelDiv, data: labelData, type: 'goal' });
    }
    
    console.log(`Created route with ${keyPoints.length} key points`);
  } catch(e) {
    console.error("Error creating route:", routeData, e);
  }
}

/******************************
 * 变换控制器和交互功能
 ******************************/
function initTransformControls() {
  if (selectableObjects.length === 0) {
    console.log("No selectable objects to initialize transform controls.");
    return;
  }

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode('translate'); // 默认为移动模式
  transformControls.setSize(0.8); // 设置gizmo大小
  transformControls.visible = false; // 初始隐藏
  scene.add(transformControls);

  // 设置移动步进为0.01（以JSON的单位为准：cm），考虑posUnitFactor换算到Three单位
  const updateTranslationSnap = () => {
    const snapWorld = 0.01 * posUnitFactor; // JSON单位0.01 → Three单位
    transformControls.setTranslationSnap(snapWorld);
  };
  updateTranslationSnap();
  // 暴露全局函数便于外部根据单位变化时更新
  window.__updateTransformSnap = updateTranslationSnap;

  // 仅在拖拽进行中或结束时更新，避免多余的全量change噪声
  transformControls.addEventListener('objectChange', function () {
    console.log('TransformControls objectChange event triggered');
    updateSelectedObjectsTransform();
  });

  // 在拖拽结束时确保更新
  transformControls.addEventListener('dragging-changed', function (event) {
    console.log('TransformControls dragging-changed:', event.value);
    if (controls) {
      controls.enabled = !event.value;
    }
    
    if (event.value) {
      // 拖拽开始时记录初始变换状态
      recordMultiSelectInitialTransforms();
    } else if (selectedObjects.length > 0) {
      // 当拖拽结束时(event.value为false)，确保更新数据
      console.log('Dragging ended, updating transform');
      updateSelectedObjectsTransform();
    }
  });

  console.log("Transform controls initialized with", selectableObjects.length, "objects.");
}

function initMouseInteraction() {
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // 添加点击事件监听器
  renderer.domElement.addEventListener('click', onMouseClick, false);
  
  // 添加键盘事件监听器用于切换模式
  window.addEventListener('keydown', onKeyDown, false);
}

function onMouseClick(event) {
  // 若当前正在拖拽 TransformControls，则不进行选中命中
  if (transformControls && transformControls.dragging) {
    console.log('Ignoring click during transform controls dragging');
    return;
  }
  // 仅处理左键
  if (event.button !== undefined && event.button !== 0) return;

  // 计算鼠标位置
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  // 射线检测
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(selectableObjects);
  console.log('Raycast hits:', intersects.length, 'Objects:', intersects.map(i => i.object.userData?.originalData?.name || 'Unknown'));

  const isShiftPressed = event.shiftKey;

  if (intersects.length > 0) {
    // 只取最近的可选择对象
    const clickedObject = intersects.find(intersect => 
      selectableObjects.includes(intersect.object)
    )?.object || intersects[0].object;
    
    if (isShiftPressed) {
      // Shift多选模式
      toggleObjectSelection(clickedObject);
    } else {
      // 单选模式
      selectSingleObject(clickedObject);
    }
  } else {
    // 点击空白处
    if (!isShiftPressed) {
      // 非Shift模式下取消所有选择
      deselectAllObjects();
    }
  }
}

function onKeyDown(event) {
  if (selectedObjects.length === 0) return;

  switch (event.key) {
    case 'g': // G键切换到移动模式
    case 'G':
      transformControls.setMode('translate');
      console.log('切换到移动模式');
      break;
    case 'r': // R键切换到旋转模式
    case 'R':
      transformControls.setMode('rotate');
      console.log('切换到旋转模式');
      break;
    case 's': // S键切换到缩放模式
    case 'S':
      transformControls.setMode('scale');
      console.log('切换到缩放模式');
      break;
    case 'Escape': // ESC键取消选择
      deselectAllObjects();
      break;
  }
}

// 单选模式：清除所有选择并选择指定对象
function selectSingleObject(mesh) {
  // 清除所有现有选择
  deselectAllObjects();
  
  // 添加到选择列表
  selectedObjects.push(mesh);
  
  // 高亮选中的物体
  if (mesh.material) {
    mesh.material.emissive.setHex(0x888888);
  }

  // 将变换控制器附加到选中的物体
  updateTransformControls();
  // 刷新所有标签，仅显示选中对象
  objectsWithLabels.forEach(updateLabel);
  
  // 启动3秒自动显示所有标签定时器
  startAutoShowLabelsTimer();
  
  console.log(`选中物体: ${mesh.userData.originalData?.name || 'Unknown'}`);
}

// Shift多选模式：切换对象的选择状态
function toggleObjectSelection(mesh) {
  const index = selectedObjects.indexOf(mesh);
  console.log(`toggleObjectSelection called for: ${mesh.userData.originalData?.name || 'Unknown'}, currently selected: ${index > -1}, total selected: ${selectedObjects.length}`);
  
  if (index > -1) {
    // 已选中，取消选择
    selectedObjects.splice(index, 1);
    if (mesh.material) {
      mesh.material.emissive.setHex(0x000000);
    }
    console.log(`取消选中物体: ${mesh.userData.originalData?.name || 'Unknown'}, remaining selected: ${selectedObjects.length}`);
  } else {
    // 未选中，添加选择
    selectedObjects.push(mesh);
    if (mesh.material) {
      mesh.material.emissive.setHex(0x888888);
    }
    console.log(`添加选中物体: ${mesh.userData.originalData?.name || 'Unknown'}, total selected: ${selectedObjects.length}`);
  }
  
  updateTransformControls();
  // 刷新所有标签，仅显示选中对象
  objectsWithLabels.forEach(updateLabel);
  
  // 重新启动3秒自动显示所有标签定时器（如果还有选中对象）
  startAutoShowLabelsTimer();
}

// 取消所有选择
function deselectAllObjects() {
  selectedObjects.forEach(mesh => {
    if (mesh.material) {
      mesh.material.emissive.setHex(0x000000);
    }
  });
  
  selectedObjects.length = 0;
  transformControls.detach();
  transformControls.visible = false;
  
  // 清除自动显示所有标签的定时器
  clearAutoShowLabelsTimer();
  
  console.log('取消所有选择');
  // 取消选择后恢复标签显示
  objectsWithLabels.forEach(updateLabel);
}

// 更新TransformControls的附加对象
function updateTransformControls() {
  if (selectedObjects.length === 0) {
    transformControls.detach();
    transformControls.visible = false;
  } else {
    // 对于单选和多选，都附加到第一个对象
    // 多选时会在objectChange事件中同步移动其他对象
    const mesh = selectedObjects[0];
    transformControls.attach(mesh);
    transformControls.visible = true;
    // 重置scale避免累积
    try {
      mesh.scale.set(1,1,1);
    } catch(e) {
      console.warn('Failed to reset mesh scale on select:', e);
    }
  }
}

// 更新所有选中对象的变换
function updateSelectedObjectsTransform() {
  if (selectedObjects.length === 0) return;
  
  if (selectedObjects.length === 1) {
    // 单选情况，直接更新
    updateObjectTransform(selectedObjects[0]);
  } else {
    // 多选情况，需要特殊处理
    updateMultipleObjectsTransform();
  }
}

// 多选对象的初始位置记录
let multiSelectInitialPositions = new Map();
let multiSelectInitialRotations = new Map();
let multiSelectInitialScales = new Map();

// 记录多选对象的初始变换状态
function recordMultiSelectInitialTransforms() {
  multiSelectInitialPositions.clear();
  multiSelectInitialRotations.clear();
  multiSelectInitialScales.clear();
  
  selectedObjects.forEach(mesh => {
    multiSelectInitialPositions.set(mesh, mesh.position.clone());
    multiSelectInitialRotations.set(mesh, mesh.rotation.clone());
    multiSelectInitialScales.set(mesh, mesh.scale.clone());
  });
}

// 处理多选对象的变换更新
function updateMultipleObjectsTransform() {
  console.log('Updating multiple objects transform');
  const mode = transformControls ? transformControls.getMode() : 'translate';
  
  if (selectedObjects.length <= 1) {
    updateObjectTransform(selectedObjects[0]);
    return;
  }
  
  const primaryMesh = selectedObjects[0]; // 主控对象
  const primaryInitialPos = multiSelectInitialPositions.get(primaryMesh);
  const primaryInitialRot = multiSelectInitialRotations.get(primaryMesh);
  const primaryInitialScale = multiSelectInitialScales.get(primaryMesh);
  
  if (!primaryInitialPos || !primaryInitialRot || !primaryInitialScale) {
    console.warn('Primary mesh initial transform not recorded');
    return;
  }
  
  // 计算主控对象的变换增量
  const deltaPos = new THREE.Vector3().subVectors(primaryMesh.position, primaryInitialPos);
  const deltaRot = new THREE.Euler().setFromVector3(
    new THREE.Vector3().subVectors(
      new THREE.Vector3(primaryMesh.rotation.x, primaryMesh.rotation.y, primaryMesh.rotation.z),
      new THREE.Vector3(primaryInitialRot.x, primaryInitialRot.y, primaryInitialRot.z)
    )
  );
  const deltaScale = new THREE.Vector3().subVectors(primaryMesh.scale, primaryInitialScale);
  
  // 应用变换到所有选中对象
  selectedObjects.forEach((mesh, index) => {
    if (index === 0) {
      // 主控对象，直接更新
      updateObjectTransform(mesh);
    } else {
      // 从属对象，应用相同的变换增量
      const initialPos = multiSelectInitialPositions.get(mesh);
      const initialRot = multiSelectInitialRotations.get(mesh);
      const initialScale = multiSelectInitialScales.get(mesh);
      
      if (initialPos && initialRot && initialScale) {
        if (mode === 'translate') {
          mesh.position.copy(initialPos).add(deltaPos);
        } else if (mode === 'rotate') {
          mesh.rotation.setFromVector3(
            new THREE.Vector3(initialRot.x, initialRot.y, initialRot.z).add(
              new THREE.Vector3(deltaRot.x, deltaRot.y, deltaRot.z)
            )
          );
        } else if (mode === 'scale') {
          mesh.scale.copy(initialScale).add(deltaScale);
        }
        
        updateObjectTransform(mesh);
      }
    }
  });
  
  // 多选完成后统一更新JSON编辑器
  updateJsonTextarea();
  
  console.log(`多选物体变换更新: 模式=${mode}, 对象数量=${selectedObjects.length}`);
}

/******************************
 * Level Data 格式对象更新函数
 ******************************/
// 更新 beat 对象（level_data 格式）
function updateBeatTransform(mesh, mode) {
  const beatIndex = mesh.userData.beatIndex;
  if (beatIndex === undefined || !currentJsonData.beats || !currentJsonData.beats[beatIndex]) {
    console.warn('Beat index not found or beats array missing');
    return;
  }
  
  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);
  
  // 转换坐标（考虑 Y 轴翻转）
  const centerX = worldPosition.x / posUnitFactor;
  const centerY = -worldPosition.y / posUnitFactor;  // Y轴翻转
  const centerZ = worldPosition.z / posUnitFactor;
  
  // 计算尺寸（考虑 scale）
  const geometry = mesh.geometry;
  const sizeX = (geometry.parameters.width / posUnitFactor) * mesh.scale.x;
  const sizeY = (geometry.parameters.height / posUnitFactor) * mesh.scale.y;
  const sizeZ = (geometry.parameters.depth / posUnitFactor) * mesh.scale.z;
  
  // 更新所有字段
  currentJsonData.beats[beatIndex].position = {
    x: roundTo(centerX, 2),
    y: roundTo(centerY, 2),
    z: roundTo(centerZ, 2)
  };
  
  currentJsonData.beats[beatIndex].size = {
    width: roundTo(sizeX, 2),
    height: roundTo(sizeY, 2),
    depth: roundTo(sizeZ, 2)
  };
  
  currentJsonData.beats[beatIndex].aabb_min = [
    roundTo(centerX - sizeX / 2, 2),
    roundTo(centerY - sizeY / 2, 2),
    roundTo(centerZ - sizeZ / 2, 2)
  ];
  
  currentJsonData.beats[beatIndex].aabb_max = [
    roundTo(centerX + sizeX / 2, 2),
    roundTo(centerY + sizeY / 2, 2),
    roundTo(centerZ + sizeZ / 2, 2)
  ];
  
  console.log(`Updated beat #${beatIndex}: pos={x:${centerX.toFixed(2)}, y:${centerY.toFixed(2)}, z:${centerZ.toFixed(2)}}`);
}

// 更新 spawn/goal 点（level_data 格式）
function updateRoutePointTransform(mesh) {
  if (!currentJsonData.route) {
    console.warn('Route data not found');
    return;
  }
  
  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);
  
  const newPos = {
    x: roundTo(worldPosition.x / posUnitFactor, 2),
    y: roundTo(-worldPosition.y / posUnitFactor, 2),  // Y轴翻转
    z: roundTo(worldPosition.z / posUnitFactor, 2)
  };
  
  if (mesh.userData.type === 'spawn') {
    currentJsonData.route.spawn = newPos;
    console.log(`Updated spawn: ${JSON.stringify(newPos)}`);
  } else if (mesh.userData.type === 'goal') {
    currentJsonData.route.goal = newPos;
    console.log(`Updated goal: ${JSON.stringify(newPos)}`);
  }
}

// 更新 route key_points（level_data 格式）
function updateRouteKeyPointTransform(mesh) {
  const pointIndex = mesh.userData.pointIndex;
  if (pointIndex === undefined || !currentJsonData.route || !currentJsonData.route.key_points) {
    console.warn('Point index not found or key_points array missing');
    return;
  }
  
  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);
  
  currentJsonData.route.key_points[pointIndex] = {
    x: roundTo(worldPosition.x / posUnitFactor, 2),
    y: roundTo(-worldPosition.y / posUnitFactor, 2),  // Y轴翻转
    z: roundTo(worldPosition.z / posUnitFactor, 2)
  };
  
  console.log(`Updated route key_point #${pointIndex}`);
}

/******************************
 * Scene Data 格式对象更新函数
 ******************************/
// 更新 scene 对象（scene_data 格式）
function updateSceneObjectTransform(mesh, mode) {
  if (!mesh.userData.originalData) {
    console.warn('Mesh missing originalData');
    return;
  }

  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);

  // 仅按当前模式生成对应的新值
  const newPosition = (mode === 'translate') ? [
    roundTo(worldPosition.x / posUnitFactor, 2),
    roundTo(-worldPosition.y / posUnitFactor, 2), // 因为mirrorRoot.scale.y = -1，所以需要翻转回来
    roundTo(worldPosition.z / posUnitFactor, 2)
  ] : null;

  const newRotation = (mode === 'rotate') ? [
    roundTo(rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.x) : mesh.rotation.x, 2),
    roundTo(rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.y) : mesh.rotation.y, 2),
    roundTo(rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.z) : mesh.rotation.z, 2)
  ] : null;

  // 缩放：JSON中的scale表示几何体的物理尺寸(米)。当前mesh.scale是在原几何基础上的附加缩放。
  // 因此需要将 originalScale 与 mesh.scale 相乘得到新的绝对scale。
  const newScale = (mode === 'scale') ? (() => {
    const base = Array.isArray(mesh.userData.originalData.scale) ? mesh.userData.originalData.scale : [1,1,1];
    return [
      roundTo(base[0] * mesh.scale.x, 3),
      roundTo(base[1] * mesh.scale.y, 3),
      roundTo(base[2] * mesh.scale.z, 3)
    ];
  })() : null;

  // 更新原始数据（只更新当前模式对应的字段）
  if (newPosition) mesh.userData.originalData.position = newPosition;
  if (newRotation) mesh.userData.originalData.rotation = newRotation;
  if (newScale) mesh.userData.originalData.scale = newScale;

  // 更新当前JSON数据（优先按稳定索引，其次名称兜底）
  if (currentJsonData && Array.isArray(currentJsonData.objects)) {
    let objIndex = -1;
    if (typeof mesh.userData.objectIndex === 'number') {
      objIndex = mesh.userData.objectIndex;
    }
    if (objIndex < 0 || !currentJsonData.objects[objIndex]) {
      objIndex = currentJsonData.objects.findIndex(obj => obj && obj.name === mesh.userData.name);
    }
    if (objIndex !== -1) {
      const target = currentJsonData.objects[objIndex];
      if (newPosition) target.position = newPosition;
      if (newRotation) target.rotation = newRotation;
      if (newScale) target.scale = newScale;

      // 同步originalData引用
      mesh.userData.originalData = target;
      mesh.userData.objectIndex = objIndex;
    } else {
      console.warn('Object not found in currentJsonData.objects');
    }
  }
  
  console.log(`Scene object updated: mode=${mode}`);
}

function updateObjectTransform(mesh) {
  if (!mesh.userData) {
    console.warn('Mesh missing userData');
    return;
  }

  const mode = transformControls ? transformControls.getMode() : 'translate';

  // 根据对象类型分发到相应的更新函数
  if (mesh.userData.type === 'beat') {
    // Level Data: Beat 对象
    updateBeatTransform(mesh, mode);
  } else if (mesh.userData.type === 'spawn' || mesh.userData.type === 'goal') {
    // Level Data: Spawn/Goal 点
    updateRoutePointTransform(mesh);
  } else if (mesh.userData.type === 'route_point') {
    // Level Data: Route key_points
    updateRouteKeyPointTransform(mesh);
  } else if (mesh.userData.originalData) {
    // Scene Data: 普通场景对象
    updateSceneObjectTransform(mesh, mode);
  } else {
    console.warn('Unknown object type, skipping update');
    return;
  }

  // 更新 JSON textarea
  if (selectedObjects.length <= 1) {
    updateJsonTextarea();
  }
}

// 统一更新JSON编辑器内容
function updateJsonTextarea() {
  const textarea = document.getElementById('jsonTextarea');
  console.log('Textarea found:', !!textarea);
  if (textarea && currentJsonData) {
    isProgrammaticJsonUpdate = true;
    textarea.value = JSON.stringify(currentJsonData, null, 2);
    isProgrammaticJsonUpdate = false;
    console.log('JSON textarea updated successfully');
  } else {
    console.warn('JSON textarea not found or currentJsonData missing');
  }
}

// 已移除切换编辑模式逻辑，始终为编辑模式

/******************************
 * 清理资源
 ******************************/
function disposeObjectTree(obj) {
  if (obj.children) {
    // Iterate over a copy of children array as it might be modified during traversal
    [...obj.children].forEach(disposeObjectTree);
  }
  if (obj.geometry) {
    obj.geometry.dispose();
    // console.log("Disposed geometry for:", obj.name || obj.type);
  }
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach(material => material.dispose());
    } else {
      obj.material.dispose();
    }
    // console.log("Disposed material for:", obj.name || obj.type);
  }
  if(obj.texture){
      obj.texture.dispose();
  }
}

function cleanUpExistingScene() {
  console.log("Cleaning up existing scene...");
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    console.log("Cancelled animation frame.");
  }
  
  // 清理自动显示标签定时器
  clearAutoShowLabelsTimer();
  console.log("Cleared auto show labels timer.");
  
  window.removeEventListener('resize', onResize);
  console.log("Removed resize listener.");

  // 清理变换控制器
  if (transformControls) {
    transformControls.dispose();
    transformControls = null;
    console.log("Disposed transform controls.");
  }

  // 清理事件监听器
  if (renderer && renderer.domElement) {
    renderer.domElement.removeEventListener('click', onMouseClick);
  }
  window.removeEventListener('keydown', onKeyDown);

  // 清理选择状态
  selectedObjects.length = 0;
  selectableObjects.length = 0;

  // 清理深度预览相关
  depthPreviewMode = false;
  depthInvert = false;
  originalMaterials.clear();

  // Dispose and remove all objects from objectsWithLabels array
  while(objectsWithLabels.length > 0){
      const item = objectsWithLabels.pop();
      if(item.labelObj && item.mesh){
          item.mesh.remove(item.labelObj); // Remove label from mesh
      }
      // disposeObjectTree will handle mesh geometry and material
  }
  console.log("Cleared objectsWithLabels and their direct labels.");

  if (scene) {
    // Dispose all objects in the scene graph
    scene.traverse(disposeObjectTree);
    // Remove all children from mirrorRoot and scene
    if(mirrorRoot){
        while(mirrorRoot.children.length > 0) mirrorRoot.remove(mirrorRoot.children[0]);
    }
    while(scene.children.length > 0) scene.remove(scene.children[0]);
    console.log("Disposed and removed all objects from scene.");
  }
  
  if (controls) {
    controls.dispose();
    controls = null;
    console.log("Disposed controls.");
  }

  // Remove renderer DOM elements. This is crucial.
  if (renderer && renderer.domElement && renderer.domElement.parentElement) {
    renderer.domElement.parentElement.removeChild(renderer.domElement);
    renderer.dispose(); // Dispose WebGL context and resources
    renderer = null;
    console.log("Disposed and removed WebGLRenderer DOM element.");
  }
  if (labelRenderer && labelRenderer.domElement && labelRenderer.domElement.parentElement) {
    labelRenderer.domElement.parentElement.removeChild(labelRenderer.domElement);
    // CSS2DRenderer does not have a dispose method.
    labelRenderer = null;
    console.log("Removed CSS2DRenderer DOM element.");
  }
  console.log("Clean up finished.");
}

/******************************
 * 动画循环
 ******************************/
function animate() {
  animationFrameId = requestAnimationFrame(animate);
  try {
    if (controls) controls.update();

    // 更新深度预览材质的相机位置和深度范围
    if (depthPreviewMode && camera) {
      // 重新计算深度范围
      let minDist = Infinity;
      let maxDist = -Infinity;

      selectableObjects.forEach(mesh => {
        const dist = camera.position.distanceTo(mesh.position);
        minDist = Math.min(minDist, dist);
        maxDist = Math.max(maxDist, dist);
      });

      // 扩展范围5%
      const range = maxDist - minDist;
      minDist -= range * 0.05;
      maxDist += range * 0.05;

      // 更新所有深度材质的uniforms
      selectableObjects.forEach(mesh => {
        if (mesh.material.uniforms) {
          if (mesh.material.uniforms.cameraPos) {
            mesh.material.uniforms.cameraPos.value.copy(camera.position);
          }
          if (mesh.material.uniforms.minDepth) {
            mesh.material.uniforms.minDepth.value = minDist;
          }
          if (mesh.material.uniforms.maxDepth) {
            mesh.material.uniforms.maxDepth.value = maxDist;
          }
        }
      });
    }

    if (scene && camera && renderer) { // Ensure core components exist
        objectsWithLabels.forEach(o => updateLabel(o));
        renderer.render(scene, camera);
        if(labelRenderer) labelRenderer.render(scene, camera);
    }
  } catch (e) {
      console.error("Error in animation loop:", e);
      cancelAnimationFrame(animationFrameId); // Stop animation on critical error
      const errorDisplay = document.getElementById('info') || document.body.appendChild(document.createElement('div'));
      errorDisplay.innerHTML += `<br><strong style="color:red;">动画循环错误: ${e.message}. 请刷新页面.</strong>`;
  }
}

function updateLabel(o) {
  if (!o || !o.labelObj || !o.mesh || !o.data) return; // Guard clause

  try {
    const dist = camera.position.distanceTo(o.mesh.position).toFixed(0);
    const lines = [];
    
    // 根据对象类型构建不同的标签内容
    const objType = o.type || (o.mesh.userData ? o.mesh.userData.type : 'object');
    
    if (objType === 'beat') {
      // Beat 对象标签
      if (showName) {
        lines.push(o.data.name || `Beat #${o.data.beat_index}`);
      }
      if (showPosition) {
        lines.push(`Phase: ${o.data.phase || 'N/A'}`);
        lines.push(`Difficulty: ${o.data.difficulty || 'N/A'}`);
        lines.push(`Intensity: ${o.data.intensity !== undefined ? o.data.intensity.toFixed(1) : 'N/A'}`);
      }
      if (showDistance) {
        lines.push(`距离: ${dist}`);
      }
    } else if (objType === 'route_point' || objType === 'spawn' || objType === 'goal') {
      // Route 点标签
      if (showName) {
        lines.push(o.data.name || 'Point');
      }
      if (showPosition && o.data.position) {
        lines.push(`Pos: [${o.data.position.map(v => v.toFixed(1)).join(', ')}]`);
      }
      if (showDistance) {
        lines.push(`距离: ${dist}`);
      }
    } else {
      // 原有的 object 标签
      if (showName) {
        const fullName = o.data.name || 'N/A';
        const lastName = fullName.split(/[\s-]+/).filter(s => s.length > 0).pop() || fullName;
        lines.push(lastName);
      }
      if (showPosition) {
        lines.push(`position(cm): [${(o.data.position || [0,0,0]).join(', ')}]`);
      }
      if (showRotation) {
        lines.push(`rotation(P,Y,R): [${(o.data.rotation || [0,0,0]).join(', ')}] ${rotationUnit === 'deg' ? '°' : 'rad'}`);
      }
      if (showScale) {
        lines.push(`scale(m): [${(o.data.scale || [0,0,0]).join(', ')}]`);
      }
      if (showDistance) {
        lines.push(`距离: ${dist}`);
      }
    }
    
    o.labelDiv.innerHTML = lines.join('<br>');

    // 标签可见性逻辑
    const hasSelection = Array.isArray(selectedObjects) && selectedObjects.length > 0;
    let shouldShowLabel = false;

    if (showAllLabelsMode) {
      shouldShowLabel = true;
    } else if (hasSelection) {
      shouldShowLabel = selectedObjects.includes(o.mesh);
    } else {
      shouldShowLabel = true;
    }

    // 遮挡检测
    let isOccluded = false;
    if (shouldShowLabel && raycaster && camera) {
      const objectWorldPos = new THREE.Vector3();
      o.mesh.getWorldPosition(objectWorldPos);
      const direction = objectWorldPos.clone().sub(camera.position).normalize();
      raycaster.set(camera.position, direction);
      const distanceToObject = camera.position.distanceTo(objectWorldPos);
      const intersects = raycaster.intersectObjects(selectableObjects);

      if (intersects.length > 0) {
        const nearestIntersect = intersects[0];
        if (nearestIntersect.object !== o.mesh && nearestIntersect.distance < distanceToObject - 0.01) {
          isOccluded = true;
        }
      }
    }

    o.labelObj.visible = (lines.length > 0) && shouldShowLabel && !isOccluded;
  } catch(e) {
    console.warn("Error updating label for object:", o.data.name, e);
    o.labelDiv.innerHTML = `${o.data.name || 'N/A'}<br>Error updating label.`;
  }
}

/******************************
 * 事件处理
 ******************************/
function onResize() {
  if (!camera || !renderer || !labelRenderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  console.log("Window resized.");
}

/******************************
 * UI绑定
 ******************************/
function initUI(initialData) {
  console.log("Initializing UI...");

  // 固定为编辑模式的提示
  updateInfoContent('编辑模式: 点击Box选择 | Shift+点击多选 | G=移动 R=旋转 S=缩放 ESC=取消选择<br>单位说明: 位置=cm 尺寸=米 旋转=Pitch Yaw Roll (°)');

  const editor = document.getElementById('jsonEditor');
  const icon = document.getElementById('expandCollapseIcon');
  const textarea = document.getElementById('jsonTextarea');
  const applyJsonButton = null; // 已移除按钮

  // --- 单位设置控制 ---
  const posUnitInput = document.getElementById('posUnitInput');
  const scaleUnitInput = document.getElementById('scaleUnitInput');
  const rotUnitSelect = document.getElementById('rotUnitSelect');
  const focalLengthInput = document.getElementById('focalLengthInput');
  const fovInput = document.getElementById('fovInput');
  const depthPreviewCheckbox = document.getElementById('depthPreviewCheckbox');
  const depthInvertContainer = document.getElementById('depthInvertContainer');
  const depthInvertCheckbox = document.getElementById('depthInvertCheckbox');
  // const applyUnitSettings button removed;
  const randomColorCheckbox = document.getElementById('randomColorCheckbox');
  const colorPicker = document.getElementById('colorPicker');
  const labelNameCb = document.getElementById('labelNameCb');
  const labelPosCb = document.getElementById('labelPosCb');
  const labelRotCb = document.getElementById('labelRotCb');
  const labelScaleCb = document.getElementById('labelScaleCb');
  const labelDistCb = document.getElementById('labelDistCb');

  if(posUnitInput) posUnitInput.value = posUnitFactor;
  if(scaleUnitInput) scaleUnitInput.value = (scaleUnitFactor/100).toFixed(2).replace(/\.00$/, '');
  if(rotUnitSelect) rotUnitSelect.value = rotationUnit;
  if(randomColorCheckbox) randomColorCheckbox.checked = useRandomColor;
  if(labelNameCb) labelNameCb.checked = true;
  if(labelPosCb) labelPosCb.checked = showPosition;
  if(labelRotCb) labelRotCb.checked = showRotation;
  if(labelScaleCb) labelScaleCb.checked = showScale;
  if(labelDistCb) labelDistCb.checked = showDistance;

  // 初始化焦距和FOV
  if (camera && focalLengthInput && fovInput) {
    // 从相机的当前FOV计算初始焦距
    const currentFOV = camera.fov;
    focalLength = roundTo(fovToFocalLength(currentFOV, sensorWidth), 1);
    focalLengthInput.value = focalLength;
    fovInput.value = roundTo(currentFOV, 1);

    // 焦距改变时更新FOV和相机
    focalLengthInput.oninput = () => {
      const newFocalLength = parseFloat(focalLengthInput.value);
      if (!isNaN(newFocalLength) && newFocalLength > 0) {
        focalLength = newFocalLength;
        const newFOV = focalLengthToFOV(focalLength, sensorWidth);
        fovInput.value = roundTo(newFOV, 1);
        camera.fov = newFOV;
        camera.updateProjectionMatrix();
        console.log(`焦距: ${focalLength}mm → FOV: ${roundTo(newFOV, 1)}°`);
      }
    };

    // FOV改变时更新焦距和相机
    fovInput.oninput = () => {
      const newFOV = parseFloat(fovInput.value);
      if (!isNaN(newFOV) && newFOV > 0 && newFOV < 180) {
        const newFocalLength = fovToFocalLength(newFOV, sensorWidth);
        focalLength = roundTo(newFocalLength, 1);
        focalLengthInput.value = focalLength;
        camera.fov = newFOV;
        camera.updateProjectionMatrix();
        console.log(`FOV: ${roundTo(newFOV, 1)}° → 焦距: ${focalLength}mm`);
      }
    };
  }

  // 深度预览复选框
  if (depthPreviewCheckbox) {
    depthPreviewCheckbox.checked = depthPreviewMode;
    depthPreviewCheckbox.onchange = () => {
      const enabled = depthPreviewCheckbox.checked;
      toggleDepthPreview(enabled);

      // 显示或隐藏深度反相选项
      if (depthInvertContainer) {
        depthInvertContainer.style.display = enabled ? 'block' : 'none';
      }

      // 关闭深度预览时，重置深度反相
      if (!enabled && depthInvertCheckbox) {
        depthInvertCheckbox.checked = false;
        depthInvert = false;
      }
    };
  }

  // 深度反相复选框
  if (depthInvertCheckbox) {
    depthInvertCheckbox.checked = depthInvert;
    depthInvertCheckbox.onchange = () => {
      updateDepthInvert(depthInvertCheckbox.checked);
    };
  }

  if(colorPicker){
      const colHex = '#' + customColor.toString(16).padStart(6,'0');
      colorPicker.value = colHex;
      colorPicker.disabled = useRandomColor;
      if(randomColorCheckbox){
          randomColorCheckbox.onchange = () => {
              colorPicker.disabled = randomColorCheckbox.checked;
          };
      }

  // 标签复选框变化时刷新
  function refreshLabelFlags(){
      showName = labelNameCb ? labelNameCb.checked : showName;
      showPosition = labelPosCb ? labelPosCb.checked : showPosition;
      showRotation = labelRotCb ? labelRotCb.checked : showRotation;
      showScale = labelScaleCb ? labelScaleCb.checked : showScale;
      showDistance = labelDistCb ? labelDistCb.checked : showDistance;
      objectsWithLabels.forEach(updateLabel);
  }
  if(labelPosCb) labelPosCb.onchange = refreshLabelFlags;
  if(labelRotCb) labelRotCb.onchange = refreshLabelFlags;
  if(labelScaleCb) labelScaleCb.onchange = refreshLabelFlags;
  if(labelDistCb) labelDistCb.onchange = refreshLabelFlags;
  if(labelNameCb) labelNameCb.onchange = refreshLabelFlags;
  }

  if(posUnitInput && scaleUnitInput && rotUnitSelect){
      const rebuildScene = () => {
          // 记录当前视角
          const prevCamPos = camera ? camera.position.clone() : null;
          const prevCamRot = camera ? camera.rotation.clone() : null;
          const prevTarget = controls ? controls.target.clone() : null;

          const newPosFactor = parseFloat(posUnitInput.value);
          const newScaleInput = parseFloat(scaleUnitInput.value);
          const newScaleFactor = newScaleInput * 100;
          const newRotUnit = rotUnitSelect.value;
          const newUseRandom = randomColorCheckbox ? randomColorCheckbox.checked : true;
          const newCustomColor = colorPicker ? parseInt(colorPicker.value.replace('#',''),16) : customColor;
          if(!isNaN(newPosFactor) && newPosFactor>0 && !isNaN(newScaleFactor) && newScaleFactor>0){
              posUnitFactor = newPosFactor;
              scaleUnitFactor = newScaleFactor;
              rotationUnit = newRotUnit;
              useRandomColor = newUseRandom;
              customColor = newCustomColor;
              console.log('Settings changed → rebuild scene');
              let currentData;
              try { currentData = JSON.parse(document.getElementById('jsonTextarea').value);} catch(e){ currentData = defaultData; }
              currentJsonData = JSON.parse(JSON.stringify(currentData)); // 更新当前JSON数据
              initScene(currentJsonData);
              initUI(currentJsonData);
              // 更新TransformControls的移动步进
              if (typeof window.__updateTransformSnap === 'function') {
                  try { window.__updateTransformSnap(); } catch (e) { console.warn('updateTranslationSnap not available:', e); }
              }
              // 视角复原
              if(prevCamPos && camera) camera.position.copy(prevCamPos);
              if(prevCamRot && camera) camera.rotation.copy(prevCamRot);
              if(prevTarget && controls) controls.target.copy(prevTarget);
              if(camera && controls) {
                  camera.lookAt(controls.target);
                  controls.update();
              }
              animate();
          }
      };
      posUnitInput.onchange = rebuildScene;
      scaleUnitInput.onchange = rebuildScene;
      rotUnitSelect.onchange = rebuildScene;
      if(randomColorCheckbox) randomColorCheckbox.onchange = () => { colorPicker.disabled = randomColorCheckbox.checked; rebuildScene(); };
      if(colorPicker) colorPicker.onchange = rebuildScene;
  }


  if(editor && icon && textarea){
      editor.onclick = e => {
        if (e.target.id === 'jsonEditorHeader' || e.target.parentElement.id === 'jsonEditorHeader') {
          editor.classList.toggle('expanded');
          icon.textContent = editor.classList.contains('expanded') ? '▼' : '▲';
          console.log(`JSON editor toggled. Expanded: ${editor.classList.contains('expanded')}`);
        }
      };
      isProgrammaticJsonUpdate = true;
      textarea.value = JSON.stringify(initialData, null, 2);
      isProgrammaticJsonUpdate = false;
      
      // 实时自动应用：500ms防抖
      let jsonInputTimer = null;
      textarea.oninput = () => {
        if (isProgrammaticJsonUpdate) return;
        if (jsonInputTimer) clearTimeout(jsonInputTimer);
        jsonInputTimer = setTimeout(() => {
          try {
            const newData = JSON.parse(textarea.value);
            currentJsonData = JSON.parse(JSON.stringify(newData));
            // 保存当前相机与控件状态
            const prevCamPos = camera ? camera.position.clone() : null;
            const prevCamRot = camera ? camera.rotation.clone() : null;
            const prevTarget = controls ? controls.target.clone() : null;

            initScene(currentJsonData);
            initUI(currentJsonData);
            // 恢复视角
            if(prevCamPos && camera) camera.position.copy(prevCamPos);
            if(prevCamRot && camera) camera.rotation.copy(prevCamRot);
            if(prevTarget && controls) controls.target.copy(prevTarget);
            if(camera && controls) {
              camera.lookAt(controls.target);
              controls.update();
            }
            animate();
            if (typeof window.__updateTransformSnap === 'function') {
              try { window.__updateTransformSnap(); } catch(e) {}
            }
            updateInfoContent('JSON已自动应用 (500ms)');
          } catch(e) {
            // 解析失败不重建，提示错误
            updateInfoContent(`<strong style="color:orange;">JSON解析失败，未应用: ${e.message}</strong>`);
          }
        }, 500);
      };
      // 按钮已删除，保留实时自动应用即可
  } else {
      console.warn("One or more JSON editor UI elements not found.");
  }
  console.log("UI initialized.");
}

boot().catch(err => {
    console.error("Boot sequence failed:", err);
    const errorDisplay = document.getElementById('info') || document.body.appendChild(document.createElement('div'));
    errorDisplay.innerHTML = `<br><strong style="color:red;">应用启动失败: ${err.message}. 请检查控制台.</strong>`;
}); 