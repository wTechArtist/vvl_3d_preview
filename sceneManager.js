import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/******************************
 * 全局变量与初始设置
 ******************************/
let scene, camera, renderer, labelRenderer, controls;
let mirrorRoot;
const objectsWithLabels = [];
let labelsVisible = true;
let animationFrameId = null;

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
  initScene(jsonData); 
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
    camera.position.set(...camData.position);
    camera.rotation.set(...camData.rotation.map(r => THREE.MathUtils.degToRad(r)));

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
        controls.target.set(firstObjPos[0], firstObjPos[1], firstObjPos[2]);
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
        data.objects.forEach(objData => createObject(objData));
    }

    window.addEventListener('resize', onResize, false);
    console.log("Scene initialized successfully.");
  } catch (error) {
    console.error("Error during scene initialization:", error);
    const errorDisplay = document.getElementById('info') || document.body.appendChild(document.createElement('div'));
    errorDisplay.innerHTML += `<br><strong style="color:red;">场景初始化失败: ${error.message}. 请检查控制台.</strong>`;
  }
}

function createObject(objData) {
  try {
    const scale = objData.scale || [1,1,1];
    const position = objData.position || [0,0,0];
    const rotation = objData.rotation || [0,0,0];

    const geo = new THREE.BoxGeometry(...scale);
    const mat = new THREE.MeshStandardMaterial({ color: Math.random() * 0xffffff, roughness: 0.7 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation.map(r => THREE.MathUtils.degToRad(r)));
    mirrorRoot.add(mesh);

    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    const labelObj = new CSS2DObject(labelDiv);
    labelObj.position.set(0, scale[1] / 2 + 20, 0); 
    mesh.add(labelObj);

    objectsWithLabels.push({ mesh, labelObj, labelDiv, data: objData });
  } catch(e){
      console.error("Error creating object:", objData, e);
  }
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
  o.labelObj.visible = labelsVisible;
  try {
    const dist = camera.position.distanceTo(o.mesh.position).toFixed(0);
    o.labelDiv.innerHTML = 
        `${o.data.name || 'N/A'}<br>
        坐标: [${(o.data.position || [0,0,0]).join(', ')}]<br>
        缩放: [${(o.data.scale || [0,0,0]).join(', ')}]<br>
        距离: ${dist}`;
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
  const toggleLabelsButton = document.getElementById('toggleLabels');
  if(toggleLabelsButton){
      toggleLabelsButton.onclick = () => {
        labelsVisible = !labelsVisible;
        toggleLabelsButton.textContent = labelsVisible ? '隐藏标签' : '显示标签';
        console.log(`Labels visibility toggled to: ${labelsVisible}`);
      };
  } else {
      console.warn("Toggle labels button not found.");
  }

  const editor = document.getElementById('jsonEditor');
  const icon = document.getElementById('expandCollapseIcon');
  const textarea = document.getElementById('jsonTextarea');
  const applyJsonButton = document.getElementById('applyJsonButton');

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
          initScene(newData); // initScene 内部会调用 cleanUpExistingScene
          initUI(newData);    // 更新UI，特别是JSON编辑器中的内容
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