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
let isEditMode = false; // 编辑模式开关
let currentJsonData = null; // 当前的JSON数据，用于实时更新
let selectedObject = null; // 当前选中的物体
let raycaster, mouse; // 用于射线检测点击

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
    const colorValue = useRandomColor ? Math.random() * 0xffffff : customColor;
    const mat = new THREE.MeshStandardMaterial({ color: colorValue, roughness: 0.7 });
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

  // 变换过程中实时更新数据 - 使用multiple事件确保捕获所有变化
  transformControls.addEventListener('change', function () {
    console.log('TransformControls change event triggered');
    if (selectedObject) {
      updateObjectTransform(selectedObject);
    }
  });

  // 添加objectChange事件监听器作为备选
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
  
  // 添加键盘事件监听器用于切换模式
  window.addEventListener('keydown', onKeyDown, false);
}

function onMouseClick(event) {
  if (!isEditMode) return;

  // 计算鼠标位置
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  // 射线检测
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(selectableObjects);

  if (intersects.length > 0) {
    const clickedObject = intersects[0].object;
    selectObject(clickedObject);
  } else {
    // 点击空白处取消选择
    deselectObject();
  }
}

function onKeyDown(event) {
  if (!isEditMode || !selectedObject) return;

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
    mesh.material.emissive.setHex(0x333333);
  }

  // 将变换控制器附加到选中的物体
  transformControls.attach(mesh);
  transformControls.visible = true;

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

  // 获取在世界坐标系中的位置（考虑mirrorRoot的变换）
  const worldPosition = new THREE.Vector3();
  mesh.getWorldPosition(worldPosition);
  console.log('World position:', worldPosition.x, worldPosition.y, worldPosition.z);

  // 将Three.js坐标转换回原始单位，考虑mirrorRoot的Y轴翻转
  const newPosition = [
    worldPosition.x / posUnitFactor,
    -worldPosition.y / posUnitFactor, // 因为mirrorRoot.scale.y = -1，所以需要翻转回来
    worldPosition.z / posUnitFactor
  ];

  const newRotation = [
    rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.x) : mesh.rotation.x,
    rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.y) : mesh.rotation.y,
    rotationUnit === 'deg' ? THREE.MathUtils.radToDeg(mesh.rotation.z) : mesh.rotation.z
  ];

  const newScale = [
    mesh.scale.x,
    mesh.scale.y,
    mesh.scale.z
  ];

  // 更新原始数据
  mesh.userData.originalData.position = newPosition;
  mesh.userData.originalData.rotation = newRotation;
  mesh.userData.originalData.scale = newScale;

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
      target.position = newPosition;
      target.rotation = newRotation;
      target.scale = newScale;

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

  console.log(`物体变换更新: 位置=${newPosition}, 旋转=${newRotation}, 缩放=${newScale}`);
}

function toggleEditMode() {
  isEditMode = !isEditMode;
  
  const button = document.getElementById('dragModeToggle');
  if (button) {
    button.textContent = isEditMode ? '退出编辑' : '编辑模式';
    button.classList.toggle('active', isEditMode);
  }

  // 如果退出编辑模式，取消当前选择
  if (!isEditMode) {
    deselectObject();
  }

  // 更新info提示
  const info = document.getElementById('info');
  if (info && isEditMode) {
    info.innerHTML = '编辑模式: 点击Box显示编辑轴 | G=移动 R=旋转 S=缩放 ESC=取消选择<br>单位说明: 位置=cm 尺寸=米 旋转=Pitch Yaw Roll (°)';
  } else if (info && !isEditMode) {
    info.innerHTML = '交互: 左键拖动 - 旋转视角 | 鼠标滚轮 - 缩放 | 右键拖动 - 平移<br>单位说明: 位置=cm 尺寸=米 旋转=Pitch Yaw Roll (°)';
  }

  console.log(`编辑模式 ${isEditMode ? '启用' : '禁用'}`);
}

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
  
  // 编辑模式按钮
  const editModeButton = document.getElementById('dragModeToggle');
  if(editModeButton){
      editModeButton.onclick = toggleEditMode;
      // 初始化按钮文本
      editModeButton.textContent = isEditMode ? '退出编辑' : '编辑模式';
      editModeButton.classList.toggle('active', isEditMode);
  } else {
      console.warn("Edit mode button not found.");
  }
  
  const toggleLabelsButton = document.getElementById('toggleLabels');
  if(toggleLabelsButton){
      toggleLabelsButton.onclick = () => {
        // 切换所有标签字段的显示状态
        const allHidden = !showName && !showPosition && !showRotation && !showScale && !showDistance;
        const newVisibility = allHidden; // 如果全部隐藏，则显示所有；否则隐藏所有
        
        showName = newVisibility;
        showPosition = newVisibility;
        showRotation = newVisibility;
        showScale = newVisibility;
        showDistance = newVisibility;
        
        // 更新复选框状态
        const labelNameCb = document.getElementById('labelNameCb');
        const labelPosCb = document.getElementById('labelPosCb');
        const labelRotCb = document.getElementById('labelRotCb');
        const labelScaleCb = document.getElementById('labelScaleCb');
        const labelDistCb = document.getElementById('labelDistCb');
        
        if(labelNameCb) labelNameCb.checked = showName;
        if(labelPosCb) labelPosCb.checked = showPosition;
        if(labelRotCb) labelRotCb.checked = showRotation;
        if(labelScaleCb) labelScaleCb.checked = showScale;
        if(labelDistCb) labelDistCb.checked = showDistance;
        
        // 更新标签显示
        objectsWithLabels.forEach(updateLabel);
        
        toggleLabelsButton.textContent = newVisibility ? '隐藏标签' : '显示标签';
        console.log(`Labels visibility toggled to: ${newVisibility}`);
      };
  } else {
      console.warn("Toggle labels button not found.");
  }

  const editor = document.getElementById('jsonEditor');
  const icon = document.getElementById('expandCollapseIcon');
  const textarea = document.getElementById('jsonTextarea');
  const applyJsonButton = document.getElementById('applyJsonButton');

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


  if(editor && icon && textarea && applyJsonButton){
      editor.onclick = e => {
        if (e.target.id === 'jsonEditorHeader' || e.target.parentElement.id === 'jsonEditorHeader') {
          editor.classList.toggle('expanded');
          icon.textContent = editor.classList.contains('expanded') ? '▼' : '▲';
          console.log(`JSON editor toggled. Expanded: ${editor.classList.contains('expanded')}`);
        }
      };
      textarea.value = JSON.stringify(initialData, null, 2);
      applyJsonButton.onclick = async () => { // 改为async
        console.log("Attempting to apply new JSON data...");
        try {
          const newJsonDataString = textarea.value;
          const newData = JSON.parse(newJsonDataString);
          console.log("New JSON data parsed successfully.", newData);
          
          // 停止当前动画，清理场景，然后用新数据重新启动整个boot过程或核心初始化部分
          if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }
          // cleanUpExistingScene(); // cleanUp会由initScene的开头调用
          
          // 重点：重新运行初始化场景和UI的逻辑
          // 不仅仅是 initScene(newData)，而是更完整的重置
          // 为了简单起见，我们再次调用boot，但这可能导致事件监听器重复绑定等问题，理想情况下应该有更精细的重置函数
          // 或者，确保initScene和initUI能够处理重复调用（例如，先移除旧的事件监听器）
          // 当前的initScene开头会调用cleanUpExistingScene，这应该能处理大部分重置
          currentJsonData = JSON.parse(JSON.stringify(newData)); // 更新当前JSON数据
          initScene(currentJsonData); // initScene 内部会调用 cleanUpExistingScene
          initUI(currentJsonData);    // 更新UI，特别是JSON编辑器中的内容
          animate();          // 重新启动动画循环
          
          document.getElementById('info').innerHTML = '已成功应用新JSON数据';

        } catch (e) {
          console.error('JSON parsing error or scene re-init error:', e);
          alert('JSON格式错误或场景更新失败: ' + e.message);
          document.getElementById('info').innerHTML = `<strong style="color:red;">JSON处理或场景更新失败: ${e.message}</strong>`;
        }
      };
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