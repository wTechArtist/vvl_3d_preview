# vvl_3d_preview
3D previewer generated from JSON data using Three.js

## 使用方法

启动 HTTP 服务器:  
```bash
cd vvl_3d_preview  
python -m http.server 8000
```

访问: http://localhost:8000/

## 功能特性

### 🔥 智能格式检测
系统自动识别 JSON 数据格式，无需手动切换：

**格式 1: 场景对象数据** (`scene_data.json`)
- 包含 `objects` 数组
- 渲染：实体盒子、自定义模型
- 颜色：随机/自定义

**格式 2: 游戏关卡数据** (`level_data_simple.json`)
- 包含 `beats` 和 `route`
- 渲染：半透明 Beats 盒子（按 Phase 颜色分类）+ Route 路径线
- 自动相机定位

### 📝 实时 JSON 编辑
在底部编辑器中粘贴任意格式的 JSON，系统自动：
1. 检测格式类型
2. 选择对应的渲染方式
3. 更新 3D 场景

### 🎮 交互操作
- 左键拖动：旋转视角
- 右键拖动：平移视角
- 滚轮：缩放
- 点击选中对象
- G/R/S 键：移动/旋转/缩放
- ESC：取消选择

## 独立预览器（可选）

如需专门的关卡预览界面：
- 访问: http://localhost:8000/level_viewer.html
- 文件: `level_viewer.html` + `levelSceneManager.js`

## 在线访问
https://wtechartist.github.io/vvl_3d_preview/
