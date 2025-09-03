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
let selectedObject = null; // 当前选中的物体
let raycaster, mouse; // 用于射线检测点击
let isProgrammaticJsonUpdate = false; // 程序化更新textarea时抑制oninput

function setTransformSnapFromUnits() {
  if (transformControls) {
    const snapWorld = 0.01 * posUnitFactor; // JSON最小单位0.01 → Three单位
    try { transformControls.setTranslationSnap(snapWorld); } catch(e) { /* older versions may differ */ }
  }
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

// --- 单位系统设置 ---
// 位置倍率: UE 单位(厘米) × posUnitFactor → Three.js 单位
let posUnitFactor = 1;
// 尺寸倍率: UE Scale(米) × scaleUnitFactor → Three.js 单位
let scaleUnitFactor = 100;
// 旋转单位: 'deg' 或 'rad'
let rotationUnit = 'deg';
// --- 颜色设置 ---
let useRandomColor = true;
let customColor = 0xffffff;

// --- 标签显示选项 ---
let showPosition = false;
let showRotation = false;
let showScale = false;
let showDistance = false;

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
    document.getElementById('info').innerHTML = '使用内置数据 (file://协议)。如需加载外部JSON, 请通过HTTP服务器访问。';
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
        document.getElementById('info').innerHTML = `从 ${path} 加载数据成功`;
        return data;
      } else {
        console.warn(`Failed to fetch from ${path}, status: ${res.status}`);
      }
    } catch (e) {
      console.warn(`Error fetching from ${path}:`, e);
    }
  }
  console.error('All fetch attempts failed, returning default data.');
  document.getElementById('info').innerHTML = '加载外部JSON失败，使用内置数据。';
  return defaultData;
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

    const camData = data.camera || defaultData.camera;
    camera = new THREE.PerspectiveCamera(camData.fov || 75, window.innerWidth / window.innerHeight, 0.1, 1e6);
    camera.up.set(0, 0, 1);
    camera.position.set(...camData.position.map(p=> p * posUnitFactor));
    const camRotVec = rotationUnit === 'deg' ? camData.rotation.map(r=>THREE.MathUtils.degToRad(r)) : camData.rotation;
    camera.rotation.set(...camRotVec);

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
    if(data.objects && data.objects.length > 0){
        const firstObjPos = data.objects[0].position;
        controls.target.set(firstObjPos[0] * posUnitFactor, firstObjPos[1] * posUnitFactor, firstObjPos[2] * posUnitFactor);
    } else {
        controls.target.set(0,0,0); // Default target if no objects
    }
    camera.lookAt(controls.target);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1000, 1000, 1000); // Move light further away for large scenes
    scene.add(dirLight);

    const axesHelper = new THREE.AxesHelper(5000);
    mirrorRoot.add(axesHelper);
    // Add axis labels for AxesHelper (ensure CSS is present in HTML for .label)
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
        pos[index] = 5500; // Position beyond axes lines
        label.position.set(...pos);
        axesHelper.add(label);
    });

    if (data.objects && Array.isArray(data.objects)) {
        data.objects.forEach((objData, index) => createObject(objData, index));
    }

    // 初始化变换控制器和点击检测
    initTransformControls();
    initMouseInteraction();

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
    if (selectedObject) {
      updateObjectTransform(selectedObject);
    }
  });

  // 在拖拽结束时确保更新
  transformControls.addEventListener('dragging-changed', function (event) {
    console.log('TransformControls dragging-changed:', event.value);
    if (controls) {
      controls.enabled = !event.value;
    }
    // 当拖拽结束时(event.value为false)，确保更新数据
    if (!event.value && selectedObject) {
      console.log('Dragging ended, updating transform');
      updateObjectTransform(selectedObject);
    }
  });

  console.log("Transform controls initialized with", selectableObjects.length, "objects.");
}

function initMouseInteraction() {
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // 添加点击事件监听器
  renderer.domElement.addEventListener('click', onMouseClick, false);
  // 同时监听 pointerdown 提高命中可靠性（防止轻微移动导致 click 不触发）
  renderer.domElement.addEventListener('pointerdown', onMouseClick, false);
  
  // 添加键盘事件监听器用于切换模式
  window.addEventListener('keydown', onKeyDown, false);
}

function onMouseClick(event) {
  // 若当前正在拖拽 TransformControls，则不进行选中命中
  if (transformControls && transformControls.dragging) return;
  // 仅处理左键
  if (event.button !== undefined && event.button !== 0) return;

  // 计算鼠标位置
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  // 射线检测
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(selectableObjects);
  console.log('Raycast hits:', intersects.length);

  if (intersects.length > 0) {
    const clickedObject = intersects[0].object;
    selectObject(clickedObject);
  } else {
    // 点击空白处取消选择
    deselectObject();
  }
}

function onKeyDown(event) {
  if (!selectedObject) return;

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
      deselectObject();
      break;
  }
}

function selectObject(mesh) {
  // 取消之前选中物体的高亮
  if (selectedObject && selectedObject.material) {
    selectedObject.material.emissive.setHex(0x000000);
  }

  selectedObject = mesh;
  
  // 高亮选中的物体
  if (mesh.material) {
    mesh.material.emissive.setHex(0x888888);
  }

  // 将变换控制器附加到选中的物体
  transformControls.attach(mesh);
  transformControls.visible = true;
  // 进入任意模式时，将mesh.scale重置为1，避免把已写回JSON的scale再次叠加
  try {
    mesh.scale.set(1,1,1);
  } catch(e) {
    console.warn('Failed to reset mesh scale on select:', e);
  }

  console.log(`选中物体: ${mesh.userData.originalData?.name || 'Unknown'}`);
}

function deselectObject() {
  if (selectedObject && selectedObject.material) {
    selectedObject.material.emissive.setHex(0x000000);
  }
  
  selectedObject = null;
  transformControls.detach();
  transformControls.visible = false;
  
  console.log('取消选择');
}

function updateObjectTransform(mesh) {
  console.log('updateObjectTransform called for:', mesh.userData?.originalData?.name || 'Unknown');
  
  if (!mesh.userData || !mesh.userData.originalData) {
    console.warn('Mesh missing userData or originalData');
    return;
  }

  console.log('Current mesh position:', mesh.position.x, mesh.position.y, mesh.position.z);

  const mode = transformControls ? transformControls.getMode() : 'translate';

  // 获取在世界坐标系中的位置（考虑mirrorRoot的变换）
  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);
  console.log('World position:', worldPosition.x, worldPosition.y, worldPosition.z);

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
  console.log('Updating JSON data. currentJsonData exists:', !!currentJsonData);
  if (currentJsonData && Array.isArray(currentJsonData.objects)) {
    let objIndex = -1;
    if (typeof mesh.userData.objectIndex === 'number') {
      objIndex = mesh.userData.objectIndex;
    }
    if (objIndex < 0 || !currentJsonData.objects[objIndex]) {
      objIndex = currentJsonData.objects.findIndex(obj => obj && obj.name === mesh.userData.name);
    }
    console.log('Resolved object index:', objIndex);
    if (objIndex !== -1) {
      const target = currentJsonData.objects[objIndex];
      if (newPosition) target.position = newPosition;
      if (newRotation) target.rotation = newRotation;
      if (newScale) target.scale = newScale;

      // 同步originalData引用
      mesh.userData.originalData = target;
      mesh.userData.objectIndex = objIndex;

      // 更新JSON编辑器中的内容
      const textarea = document.getElementById('jsonTextarea');
      console.log('Textarea found:', !!textarea);
      if (textarea) {
        textarea.value = JSON.stringify(currentJsonData, null, 2);
        console.log('JSON textarea updated successfully');
      } else {
        console.warn('JSON textarea not found');
      }
    } else {
      console.warn('Object not found in currentJsonData.objects');
    }
  } else {
    console.warn('currentJsonData or currentJsonData.objects is null/undefined');
  }

  console.log(`物体变换更新: 模式=${mode}`);
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
  selectedObject = null;
  selectableObjects.length = 0;

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
  // 根据所选字段是否至少存在来决定可见性
  
  try {
    const dist = camera.position.distanceTo(o.mesh.position).toFixed(0);
    // 构建标签内容
    const lines = [];
    if(showName){
        lines.push(o.data.name || 'N/A');
    }
    if(showPosition){
        lines.push(`position(cm): [${(o.data.position || [0,0,0]).join(', ')}]`);
    }
    if(showRotation){
        lines.push(`rotation(P,Y,R): [${(o.data.rotation || [0,0,0]).join(', ')}] ${rotationUnit === 'deg' ? '°' : 'rad'}`);
    }
    if(showScale){
        lines.push(`scale(m): [${(o.data.scale || [0,0,0]).join(', ')}]`);
    }
    if(showDistance){
        lines.push(`距离: ${dist}`);
    }
    o.labelDiv.innerHTML = lines.join('<br>');
    o.labelObj.visible = lines.length > 0;
  } catch(e){
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
  const info = document.getElementById('info');
  if (info) {
    info.innerHTML = '编辑模式: 点击Box显示编辑轴 | G=移动 R=旋转 S=缩放 ESC=取消选择<br>单位说明: 位置=cm 尺寸=米 旋转=Pitch Yaw Roll (°)';
  }

  const editor = document.getElementById('jsonEditor');
  const icon = document.getElementById('expandCollapseIcon');
  const textarea = document.getElementById('jsonTextarea');
  const applyJsonButton = null; // 已移除按钮

  // --- 单位设置控制 ---
  const posUnitInput = document.getElementById('posUnitInput');
  const scaleUnitInput = document.getElementById('scaleUnitInput');
  const rotUnitSelect = document.getElementById('rotUnitSelect');
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
            const info = document.getElementById('info');
            if (info) info.innerHTML = 'JSON已自动应用 (500ms)';
          } catch(e) {
            // 解析失败不重建，提示错误
            const info = document.getElementById('info');
            if (info) info.innerHTML = `<strong style="color:orange;">JSON解析失败，未应用: ${e.message}</strong>`;
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