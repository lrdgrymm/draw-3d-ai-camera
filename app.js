/**
 * NAREST DRAW 3D UHUYY - Core Application Script
 * AI Hand Tracking, 3D Canvas rendering, and Semi-Hacker UI controllers.
 */

// ----------------------------------------------------
// GLOBAL SYSTEM STATES
// ----------------------------------------------------
const state = {
  activeTool: 'pen',         // pen, marker, brush, shape, eraser
  activeShape: 'sphere',     // sphere, box, torus, cone
  activeColor: '#00ff66',    // default neon green
  brushSize: 15,             // default size
  isDrawing: false,
  lastPosition: null,        // last 3D drawing coordinate
  currentGesture: 'IDLE',    // IDLE, DRAWING, ZOOMING, ROTATING, HOVER
  telemetryThrottle: 0,      // counter to throttle terminal output
  shapesSpawningLocked: false // prevents spawning multiple shapes per tap
};

// 3D Objects Storage
const drawnObjects = [];
const particlesPool = [];

// Camera spherical coordinates for orbital 360-degree rotation
const cameraOrbit = {
  theta: 0,                   // azimuthal angle
  phi: Math.PI / 2,           // polar angle
  radius: 40,                 // zoom distance
  minRadius: 8,
  maxRadius: 120,
  target: new THREE.Vector3(0, 0, 0)
};

// ----------------------------------------------------
// THREE.JS GRAPHIC CORE SETUP
// ----------------------------------------------------
let scene, camera, renderer, movingPointLight, pointerCursor, dynamicDrawPlane, drawingGroup;
let sceneGrid;

function initThree() {
  const container = document.getElementById('canvas-container');
  const width = container.clientWidth;
  const height = container.clientHeight;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  scene.fog = new THREE.FogExp2(0x05070a, 0.015);

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  updateCameraPosition();

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x08101a, 2.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0x00f0ff, 0.8);
  dirLight.position.set(20, 40, 20);
  dirLight.castShadow = true;
  scene.add(dirLight);

  // Neon Point Light attached to active drawing cursor
  movingPointLight = new THREE.PointLight(0x00ff66, 3, 30);
  movingPointLight.castShadow = true;
  scene.add(movingPointLight);

  // Glowing 3D Cursor Pointer (Hologram look)
  const cursorGeo = new THREE.SphereGeometry(0.5, 16, 16);
  const cursorMat = new THREE.MeshBasicMaterial({
    color: 0x00ff66,
    wireframe: true,
    transparent: true,
    opacity: 0.8
  });
  pointerCursor = new THREE.Mesh(cursorGeo, cursorMat);
  scene.add(pointerCursor);

  // Cybernetic Coordinates Grid
  sceneGrid = new THREE.GridHelper(100, 60, 0x00ff66, 0x162235);
  sceneGrid.position.y = -10;
  // Apply opacity to grid
  sceneGrid.material.transparent = true;
  sceneGrid.material.opacity = 0.35;
  scene.add(sceneGrid);

  // Virtual draw plane facing camera at origin
  const planeGeo = new THREE.PlaneGeometry(1000, 1000);
  const planeMat = new THREE.MeshBasicMaterial({ visible: false });
  dynamicDrawPlane = new THREE.Mesh(planeGeo, planeMat);
  scene.add(dynamicDrawPlane);

  // Isolated drawing group for 3D exporter compliance
  drawingGroup = new THREE.Group();
  scene.add(drawingGroup);

  // Event Listeners
  window.addEventListener('resize', onWindowResize);
}

function updateCameraPosition() {
  camera.position.x = cameraOrbit.radius * Math.sin(cameraOrbit.phi) * Math.sin(cameraOrbit.theta);
  camera.position.y = cameraOrbit.radius * Math.cos(cameraOrbit.phi);
  camera.position.z = cameraOrbit.radius * Math.sin(cameraOrbit.phi) * Math.cos(cameraOrbit.theta);
  camera.lookAt(cameraOrbit.target);
}

function onWindowResize() {
  const container = document.getElementById('canvas-container');
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

// ----------------------------------------------------
// CUSTOM TELEMETRY LOG FUNCTION
// ----------------------------------------------------
const terminalOutput = document.getElementById('terminal-output');

function logToTerminal(message, type = 'info') {
  const p = document.createElement('p');
  p.className = 'term-line';
  
  const timestamp = new Date().toLocaleTimeString();
  let prefix = `[${timestamp}] `;
  
  if (type === 'success') {
    p.classList.add('term-success');
    prefix += `[OK] `;
  } else if (type === 'warn') {
    p.classList.add('term-warn');
    prefix += `[ERR] `;
  } else if (type === 'gesture') {
    p.classList.add('term-gesture');
    prefix += `[SIG] `;
  } else {
    prefix += `[SYS] `;
  }
  
  p.textContent = prefix + message;
  terminalOutput.appendChild(p);
  
  // Keep only last 40 logs to prevent performance issues
  while (terminalOutput.childNodes.length > 40) {
    terminalOutput.removeChild(terminalOutput.firstChild);
  }
  
  // Scroll to bottom
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// ----------------------------------------------------
// MEDIAPIPE GESTURE RECOGNITION ENGINE
// ----------------------------------------------------
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('skeleton-canvas');
const canvasCtx = canvasElement.getContext('2d');
const activeStatus = document.getElementById('active-status');

// Variables to track tracking state between frames
let prevPinchDist = null;
let prevHandPos = null;

function processHandTracking(results) {
  // Clear skeletal canvas overlay
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    if (state.currentGesture !== 'OFFLINE') {
      updateGestureStatus('IDLE');
      pointerCursor.visible = false;
      movingPointLight.intensity = 0;
    }
    prevPinchDist = null;
    prevHandPos = null;
    state.isDrawing = false;
    state.lastPosition = null;
    state.shapesSpawningLocked = false;
    return;
  }

  const landmarks = results.multiHandLandmarks[0];
  
  // 1. DRAW SKELETON FEEDBACK OVERLAY (Mirrored naturally)
  drawSkeletonOverlay(landmarks);

  // 2. RECOGNIZE GESTURE PROTOCOLS
  const fingers = analyzeFingers(landmarks);
  
  // Calculate index tip in screen normalized coordinate (0 to 1)
  // MediaPipe is [0, 1]. x=0 is left, y=0 is top.
  // Note: We flip x because webcam is mirrored.
  const indexTip = landmarks[8];
  const screenX = indexTip.x;
  const screenY = indexTip.y;
  
  // Update virtual cursor pointer coordinates
  const worldPoint = projectTo3DSpace(screenX, screenY, landmarks);
  
  pointerCursor.visible = true;
  pointerCursor.position.copy(worldPoint);
  movingPointLight.position.copy(worldPoint);
  movingPointLight.intensity = 3.5 * (state.brushSize / 20);

  // Throttle logging coordinate telemetry to terminal
  state.telemetryThrottle++;
  if (state.telemetryThrottle > 18) {
    logToTerminal(`TELEMETRY: X=${worldPoint.x.toFixed(2)} Y=${worldPoint.y.toFixed(2)} Z=${worldPoint.z.toFixed(2)}`, 'info');
    state.telemetryThrottle = 0;
  }

  // GESTURE CLASSIFIER STATE MACHINE
  // Gestures are determined by fingers extension states: [thumb, index, middle, ring, pinky]
  
  // A. ZOOM PROTOCOL: Thumb and Index UP, Middle, Ring, Pinky DOWN
  if (fingers.thumb && fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) {
    updateGestureStatus('ZOOMING');
    state.isDrawing = false;
    state.lastPosition = null;
    state.shapesSpawningLocked = false;

    // Calculate distance between thumb tip (4) and index tip (8)
    const tTip = landmarks[4];
    const iTip = landmarks[8];
    const currentDist = Math.sqrt(
      Math.pow(tTip.x - iTip.x, 2) + 
      Math.pow(tTip.y - iTip.y, 2) + 
      Math.pow(tTip.z - iTip.z, 2)
    );

    if (prevPinchDist !== null) {
      // Zoom factor delta scaling
      const delta = currentDist - prevPinchDist;
      cameraOrbit.radius -= delta * 180; // Scale factor
      cameraOrbit.radius = Math.max(cameraOrbit.minRadius, Math.min(cameraOrbit.maxRadius, cameraOrbit.radius));
      updateCameraPosition();
      
      if (state.telemetryThrottle === 0) {
        logToTerminal(`CAM_ZOOM: RADIUS=${cameraOrbit.radius.toFixed(1)} DIST=${(currentDist * 100).toFixed(0)}%`, 'gesture');
      }
    }
    prevPinchDist = currentDist;
    prevHandPos = null;
  }
  
  // B. ROTATE PROTOCOL: Index, Middle, Ring, Pinky UP, Thumb DOWN/CLOSED
  else if (!fingers.thumb && fingers.index && fingers.middle && fingers.ring && fingers.pinky) {
    updateGestureStatus('ROTATING');
    state.isDrawing = false;
    state.lastPosition = null;
    state.shapesSpawningLocked = false;

    // Calculate center mass of 4 fingers
    const currentHandPos = {
      x: (landmarks[8].x + landmarks[12].x + landmarks[16].x + landmarks[20].x) / 4,
      y: (landmarks[8].y + landmarks[12].y + landmarks[16].y + landmarks[20].y) / 4
    };

    if (prevHandPos !== null) {
      // Delta coordinate tracking
      const dx = currentHandPos.x - prevHandPos.x;
      const dy = currentHandPos.y - prevHandPos.y;

      // Orbit camera rotation controls (flipped x direction because of mirroring)
      cameraOrbit.theta += dx * 6.5; 
      cameraOrbit.phi -= dy * 6.5;

      // Clamp polar angle to avoid screen flip gimbal lock
      cameraOrbit.phi = Math.max(0.1, Math.min(Math.PI - 0.1, cameraOrbit.phi));
      updateCameraPosition();
    }
    prevHandPos = currentHandPos;
    prevPinchDist = null;
  }
  
  // C. DRAW PROTOCOL: Index UP, Middle, Ring, Pinky DOWN
  else if (fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) {
    updateGestureStatus('DRAWING');
    prevPinchDist = null;
    prevHandPos = null;

    handle3DDrawing(worldPoint);
  }
  
  // D. HOVER PROTOCOL: All 5 fingers extended UP
  else if (fingers.thumb && fingers.index && fingers.middle && fingers.ring && fingers.pinky) {
    updateGestureStatus('HOVER');
    state.isDrawing = false;
    state.lastPosition = null;
    state.shapesSpawningLocked = false;
    prevPinchDist = null;
    prevHandPos = null;
  }
  
  // E. IDLE: Other configuration
  else {
    updateGestureStatus('IDLE');
    state.isDrawing = false;
    state.lastPosition = null;
    state.shapesSpawningLocked = false;
    prevPinchDist = null;
    prevHandPos = null;
  }
}

// ----------------------------------------------------
// GESTURE SUB-LOGIC HELPERS
// ----------------------------------------------------

/**
 * Determine if fingers are extended UP or DOWN
 */
function analyzeFingers(landmarks) {
  // Standard Y coordinate comparison: Tip y < Knuckle y means extended (since y=0 is top)
  const fingers = {
    index: landmarks[8].y < landmarks[6].y,
    middle: landmarks[12].y < landmarks[10].y,
    ring: landmarks[16].y < landmarks[14].y,
    pinky: landmarks[20].y < landmarks[18].y,
    thumb: false
  };

  // Thumb analysis: Check distance between thumb tip (4) and index base (5)
  // If thumb is extended, the distance is large
  const distThumbToIndexBase = Math.sqrt(
    Math.pow(landmarks[4].x - landmarks[5].x, 2) +
    Math.pow(landmarks[4].y - landmarks[5].y, 2)
  );
  fingers.thumb = distThumbToIndexBase > 0.085;

  return fingers;
}

/**
 * Projection algorithm mapping 2D Camera Screen space to 3D Coordinates
 */
function projectTo3DSpace(screenX, screenY, landmarks) {
  const tempV = new THREE.Vector3();
  
  // Map normalized screenX (0 to 1) to NDC (-1 to 1)
  // Mirroring correction: screenX is already mapped to camera, we align:
  const ndcX = (1 - screenX) * 2 - 1; // Mirrored flip
  const ndcY = -screenY * 2 + 1;      // Standard Y mapping
  
  tempV.set(ndcX, ndcY, 0.5);
  tempV.unproject(camera);
  
  // Raycast from camera position towards the unprojected coordinate
  const dir = tempV.sub(camera.position).normalize();
  
  // Update dynamic plane rotation to always face camera
  const planeNormal = new THREE.Vector3();
  camera.getWorldDirection(planeNormal);
  planeNormal.negate();
  
  // Setup virtual drawing plane at the scene origin
  const targetPlane = new THREE.Plane(planeNormal, 0);
  const intersectPoint = new THREE.Vector3();
  
  const ray = new THREE.Ray(camera.position, dir);
  ray.intersectPlane(targetPlane, intersectPoint);
  
  // Volume depth offset (Z coordinate): Using distance from wrist (0) to index knuckle (5)
  // as reference to calculate finger depth relative to wrist.
  const wrist = landmarks[0];
  const indexTip = landmarks[8];
  
  // Raw Z difference represents finger forward/backward push relative to wrist base
  const depthZ = (indexTip.z - wrist.z) * -38.0; 
  
  // Push/pull drawing point along the camera viewing axis
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  intersectPoint.addScaledVector(camDir, depthZ);
  
  return intersectPoint;
}

/**
 * Draw skeleton joints onto floating overlay
 */
function drawSkeletonOverlay(landmarks) {
  const width = canvasElement.width;
  const height = canvasElement.height;

  // Joint connections map
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
    [0, 5], [5, 6], [6, 7], [7, 8], // Index
    [9, 10], [10, 11], [11, 12],     // Middle (wrist link added below)
    [13, 14], [14, 15], [15, 16],    // Ring
    [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
    [5, 9], [9, 13], [13, 17] // Knuckle bridges
  ];
  connections.push([0, 9], [0, 13]); // Complete wrist base connections

  // Draw connections
  canvasCtx.strokeStyle = '#00ff66';
  canvasCtx.lineWidth = 2.5;
  canvasCtx.shadowBlur = 4;
  canvasCtx.shadowColor = '#00ff66';
  
  connections.forEach(([start, end]) => {
    const pt1 = landmarks[start];
    const pt2 = landmarks[end];
    
    canvasCtx.beginPath();
    canvasCtx.moveTo(pt1.x * width, pt1.y * height);
    canvasCtx.lineTo(pt2.x * width, pt2.y * height);
    canvasCtx.stroke();
  });

  // Draw Joint nodes
  canvasCtx.fillStyle = '#00f0ff';
  canvasCtx.shadowColor = '#00f0ff';
  
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    canvasCtx.beginPath();
    // Highlight tips with magenta
    if (i === 4 || i === 8 || i === 12 || i === 16 || i === 20) {
      canvasCtx.fillStyle = '#ff007f';
      canvasCtx.shadowColor = '#ff007f';
      canvasCtx.arc(pt.x * width, pt.y * height, 4.5, 0, 2 * Math.PI);
    } else {
      canvasCtx.fillStyle = '#00ff66';
      canvasCtx.shadowColor = '#00ff66';
      canvasCtx.arc(pt.x * width, pt.y * height, 3.5, 0, 2 * Math.PI);
    }
    canvasCtx.fill();
  }
  
  // Reset shadows
  canvasCtx.shadowBlur = 0;
}

/**
 * Handle state changes in UI status HUD
 */
function updateGestureStatus(gesture) {
  if (state.currentGesture === gesture) return;
  
  state.currentGesture = gesture;
  activeStatus.textContent = `[${gesture}]`;
  activeStatus.className = 'status-value';

  // Toggle glowing indicator styling based on gesture
  if (gesture === 'DRAWING') {
    activeStatus.classList.add('status-draw');
    pointerCursor.material.color.setHex(0x00ff66);
    logToTerminal('DRAWING PROTOCOL DECRYPTED: BRUSH_ACTIVE', 'gesture');
  } else if (gesture === 'ZOOMING') {
    activeStatus.classList.add('status-zoom');
    pointerCursor.material.color.setHex(0xff007f);
    logToTerminal('ZOOM PROTOCOL ACTUATED: OPTICAL_CALIBRATION', 'gesture');
  } else if (gesture === 'ROTATING') {
    activeStatus.classList.add('status-rotate');
    pointerCursor.material.color.setHex(0x00f0ff);
    logToTerminal('ROTATION PROTOCOL DECRYPTED: 360_ORBIT_AXIS', 'gesture');
  } else if (gesture === 'HOVER') {
    activeStatus.classList.add('status-hover');
    pointerCursor.material.color.setHex(0xffd700);
    logToTerminal('HOVER POINTER ACTIVE: SCANNING COORDINATES', 'info');
  } else {
    activeStatus.classList.add('status-idle');
    pointerCursor.material.color.setHex(0xe1e8f5);
  }
}

// ----------------------------------------------------
// 3D DRAWING MECHANICS
// ----------------------------------------------------
function handle3DDrawing(worldPoint) {
  // If ERASER tool is active
  if (state.activeTool === 'eraser') {
    eraseIntersectingObjects(worldPoint);
    return;
  }

  // If SHAPE tool is active
  if (state.activeTool === 'shape') {
    if (!state.shapesSpawningLocked) {
      spawn3DShape(worldPoint);
      state.shapesSpawningLocked = true; // Spawns only ONE shape per finger raise
    }
    return;
  }

  // Drawing Brush / Pen / Marker Strokes
  if (!state.isDrawing) {
    state.isDrawing = true;
    state.lastPosition = worldPoint.clone();
    return;
  }

  // Check movement delta distance to avoid creating points too close together
  const dist = worldPoint.distanceTo(state.lastPosition);
  if (dist > 0.3) {
    createStrokeSegment(state.lastPosition, worldPoint);
    
    // Spawn subtle neon particles for artistic premium feel
    spawnBrushParticles(worldPoint);
    
    state.lastPosition = worldPoint.clone();
  }
}

/**
 * Creates a beautiful connected 3D mesh line segment (Pen, Marker, or Brush style)
 */
function createStrokeSegment(startPt, endPt) {
  // Calculate intermediate parameters
  const distance = startPt.distanceTo(endPt);
  const radius = (state.brushSize / 40.0) * 0.4;
  
  // Select material based on active tool stylings
  let material;
  let meshName = `stroke_${drawnObjects.length}`;
  
  if (state.activeTool === 'pen') {
    // Solid retro glowing wireline or thin tube
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(state.activeColor),
      roughness: 0.1,
      metalness: 0.8,
      emissive: new THREE.Color(state.activeColor),
      emissiveIntensity: 0.45
    });
  } else if (state.activeTool === 'marker') {
    // Semi-transparent bold marker stroke
    material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(state.activeColor),
      roughness: 0.2,
      transmission: 0.5, // Sleek translucent look
      thickness: 1.0,
      transparent: true,
      opacity: 0.72,
      emissive: new THREE.Color(state.activeColor),
      emissiveIntensity: 0.2
    });
  } else { // 'brush' - Ribbons or organic crystal look
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(state.activeColor),
      roughness: 0.5,
      metalness: 0.2,
      wireframe: true, // Cool structural crystalline grid brush
      emissive: new THREE.Color(state.activeColor),
      emissiveIntensity: 0.3
    });
  }

  // To build smooth continuous cylinders connecting two arbitrary points:
  const direction = new THREE.Vector3().subVectors(endPt, startPt);
  const alignAxis = new THREE.Vector3(0, 1, 0); // Default Cylinder geometry faces Y-axis
  direction.normalize();

  // Create cylinder geometry matching exact distance
  const cylGeo = new THREE.CylinderGeometry(radius, radius, distance, 8);
  const segmentMesh = new THREE.Mesh(cylGeo, material);
  
  // Position cylinder exactly at the center of the start/end points
  const midpoint = new THREE.Vector3().addVectors(startPt, endPt).multiplyScalar(0.5);
  segmentMesh.position.copy(midpoint);
  
  // Align rotation to match start-end direction vector
  const quaternion = new THREE.Quaternion().setFromUnitVectors(alignAxis, direction);
  segmentMesh.setRotationFromQuaternion(quaternion);
  
  segmentMesh.castShadow = true;
  segmentMesh.receiveShadow = true;
  
  // Tag mesh for identification in undo and eraser operations
  segmentMesh.name = meshName;
  segmentMesh.userData = {
    type: 'stroke',
    groupIndex: drawnObjects.length, // Groups strokes by continuous lines
    radius: radius
  };

  drawingGroup.add(segmentMesh);
  
  // Track drawing items
  drawnObjects.push(segmentMesh);
}

/**
 * Spawns an aesthetic glowing wireframe 3D Shape
 */
/**
 * Procedural Low-Poly Goblin generator for 3D printing and spatial sculpting
 */
/**
 * Procedural Low-Poly Goblin generator for 3D printing and spatial sculpting.
 * Builds an extremely detailed character using colored primitives with flat shading.
 */
function createGoblinGeometryGroup(size) {
  const group = new THREE.Group();
  
  // Custom detailed low-poly color palette materials
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0x2e6f22,      // Rich goblin green
    roughness: 0.8,
    metalness: 0.05,
    flatShading: true
  });
  
  const clothesMat = new THREE.MeshStandardMaterial({
    color: 0x5c3d24,    // Leather brown tunic
    roughness: 0.9,
    metalness: 0.0,
    flatShading: true
  });

  const blackMat = new THREE.MeshStandardMaterial({
    color: 0x111111,      // Obsidian black (belt/hair/pupils)
    roughness: 0.6,
    metalness: 0.1,
    flatShading: true
  });

  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xd4af37,      // Gold metallic (belt buckle/neck collar)
    roughness: 0.2,
    metalness: 0.9,
    flatShading: true
  });

  const eyeWhiteMat = new THREE.MeshBasicMaterial({
    color: 0xeeeeee       // Clean sclera white
  });

  const irisMat = new THREE.MeshBasicMaterial({
    color: 0xff0044       // Glowing neon red iris
  });

  const teethMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,      // Pure ivory white for fangs
    roughness: 0.1,
    metalness: 0.2,
    flatShading: true
  });

  // 1. TUNIC/TORSO (Cylinder shape)
  const bodyGeo = new THREE.CylinderGeometry(size * 0.25, size * 0.28, size * 0.5, 6);
  const body = new THREE.Mesh(bodyGeo, clothesMat);
  body.position.y = -size * 0.15;
  group.add(body);

  // 2. NECK COLLAR (Gold metallic torus or cylinder slice)
  const collarGeo = new THREE.CylinderGeometry(size * 0.16, size * 0.19, size * 0.05, 6);
  const collar = new THREE.Mesh(collarGeo, goldMat);
  collar.position.y = size * 0.1;
  group.add(collar);

  // 3. LEATHER BELT (Thin black cylinder surrounding waist)
  const beltGeo = new THREE.CylinderGeometry(size * 0.29, size * 0.29, size * 0.06, 6);
  const belt = new THREE.Mesh(beltGeo, blackMat);
  belt.position.y = -size * 0.2;
  group.add(belt);

  // 4. GOLD BELT BUCKLE (Small golden box in front)
  const buckleGeo = new THREE.BoxGeometry(size * 0.1, size * 0.09, size * 0.05);
  const buckle = new THREE.Mesh(buckleGeo, goldMat);
  // Place in front along Z-axis
  buckle.position.set(0, -size * 0.2, size * 0.29);
  group.add(buckle);

  // 5. HEAD (Sphere shape)
  const headGeo = new THREE.SphereGeometry(size * 0.26, 8, 8);
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = size * 0.32;
  group.add(head);

  // 6. LEFT POINTY EAR (Pointy cone angled outwards)
  const earGeo = new THREE.ConeGeometry(size * 0.07, size * 0.28, 4);
  const leftEar = new THREE.Mesh(earGeo, skinMat);
  leftEar.position.set(-size * 0.24, size * 0.35, 0);
  leftEar.rotation.z = Math.PI / 2.8;   // Angled out
  leftEar.rotation.x = -Math.PI / 10;   // Angled back
  group.add(leftEar);

  // 7. RIGHT POINTY EAR (Pointy cone angled outwards)
  const rightEar = leftEar.clone();
  rightEar.position.x = size * 0.24;
  rightEar.rotation.z = -Math.PI / 2.8;
  group.add(rightEar);

  // 8. POINTY NOSE (Cone pointing forward)
  const noseGeo = new THREE.ConeGeometry(size * 0.05, size * 0.16, 4);
  const nose = new THREE.Mesh(noseGeo, skinMat);
  nose.position.set(0, size * 0.3, size * 0.24);
  nose.rotation.x = Math.PI / 2;       // Point forward
  group.add(nose);

  // 9. MESSY SPIKY HAIR (Spiky black cones on top of head)
  const hairGeo = new THREE.ConeGeometry(size * 0.05, size * 0.15, 3);
  
  const hair1 = new THREE.Mesh(hairGeo, blackMat);
  hair1.position.set(0, size * 0.55, 0);
  hair1.rotation.z = -Math.PI / 12;
  group.add(hair1);

  const hair2 = hair1.clone();
  hair2.position.set(-size * 0.08, size * 0.53, size * 0.03);
  hair2.rotation.z = Math.PI / 8;
  group.add(hair2);

  const hair3 = hair1.clone();
  hair3.position.set(size * 0.08, size * 0.53, -size * 0.03);
  hair3.rotation.z = -Math.PI / 6;
  group.add(hair3);

  // 10. DETAILED EYE ASSEMBLIES (Eyeballs + glowing red iris + black pupils)
  const eyeSphereGeo = new THREE.SphereGeometry(size * 0.045, 6, 6);
  const irisSphereGeo = new THREE.SphereGeometry(size * 0.03, 6, 6);
  const pupilSphereGeo = new THREE.SphereGeometry(size * 0.015, 4, 4);

  // Left Eye
  const leftEyeGroup = new THREE.Group();
  leftEyeGroup.position.set(-size * 0.08, size * 0.36, size * 0.2);
  
  const lSclera = new THREE.Mesh(eyeSphereGeo, eyeWhiteMat);
  const lIris = new THREE.Mesh(irisSphereGeo, irisMat);
  lIris.position.set(0, 0, size * 0.022); // Push forward
  const lPupil = new THREE.Mesh(pupilSphereGeo, blackMat);
  lPupil.position.set(0, 0, size * 0.033); // Push more forward
  
  leftEyeGroup.add(lSclera, lIris, lPupil);
  group.add(leftEyeGroup);

  // Right Eye
  const rightEyeGroup = leftEyeGroup.clone();
  rightEyeGroup.position.x = size * 0.08;
  group.add(rightEyeGroup);

  // 11. MOUTH WITH SHARP IVORY FANGS
  const mouthGeo = new THREE.BoxGeometry(size * 0.12, size * 0.03, size * 0.02);
  const mouth = new THREE.Mesh(mouthGeo, blackMat);
  mouth.position.set(0, size * 0.21, size * 0.22);
  group.add(mouth);

  // Left Fang (Pointy cone pointing upwards)
  const fangGeo = new THREE.ConeGeometry(size * 0.022, size * 0.08, 4);
  const leftFang = new THREE.Mesh(fangGeo, teethMat);
  leftFang.position.set(-size * 0.04, size * 0.2, size * 0.23);
  leftFang.rotation.x = -Math.PI / 10; // Angle forward
  group.add(leftFang);

  // Right Fang
  const rightFang = leftFang.clone();
  rightFang.position.x = size * 0.04;
  group.add(rightFang);

  // 12. ARMS & HANDS
  const armGeo = new THREE.CylinderGeometry(size * 0.05, size * 0.045, size * 0.35, 4);
  const handGeo = new THREE.SphereGeometry(size * 0.05, 6, 6);

  // Left Arm Assembly (slanted downwards)
  const leftArmGroup = new THREE.Group();
  leftArmGroup.position.set(-size * 0.26, -size * 0.02, 0);
  
  const lArm = new THREE.Mesh(armGeo, skinMat);
  lArm.position.y = -size * 0.1;
  lArm.rotation.z = Math.PI / 7; // Angle outwards
  
  const lHand = new THREE.Mesh(handGeo, skinMat);
  lHand.position.set(-size * 0.06, -size * 0.27, size * 0.02);
  
  leftArmGroup.add(lArm, lHand);
  group.add(leftArmGroup);

  // Right Arm Assembly (slanted downwards)
  const rightArmGroup = new THREE.Group();
  rightArmGroup.position.set(size * 0.26, -size * 0.02, 0);
  
  const rArm = new THREE.Mesh(armGeo, skinMat);
  rArm.position.y = -size * 0.1;
  rArm.rotation.z = -Math.PI / 7;
  
  const rHand = new THREE.Mesh(handGeo, skinMat);
  rHand.position.set(size * 0.06, -size * 0.27, size * 0.02);
  
  rightArmGroup.add(rArm, rHand);
  group.add(rightArmGroup);

  // 13. LEGS & FEET/SHOES
  const legGeo = new THREE.CylinderGeometry(size * 0.065, size * 0.06, size * 0.25, 4);
  const shoeGeo = new THREE.BoxGeometry(size * 0.09, size * 0.06, size * 0.16);

  // Left Leg Assembly
  const leftLegGroup = new THREE.Group();
  leftLegGroup.position.set(-size * 0.12, -size * 0.4, 0);
  
  const lLeg = new THREE.Mesh(legGeo, skinMat);
  lLeg.position.y = -size * 0.05;
  
  const lShoe = new THREE.Mesh(shoeGeo, clothesMat);
  lShoe.position.set(0, -size * 0.16, size * 0.04);
  
  leftLegGroup.add(lLeg, lShoe);
  group.add(leftLegGroup);

  // Right Leg Assembly
  const rightLegGroup = new THREE.Group();
  rightLegGroup.position.set(size * 0.12, -size * 0.4, 0);
  
  const rLeg = new THREE.Mesh(legGeo, skinMat);
  rLeg.position.y = -size * 0.05;
  
  const rShoe = new THREE.Mesh(shoeGeo, clothesMat);
  rShoe.position.set(0, -size * 0.16, size * 0.04);
  
  rightLegGroup.add(rLeg, rShoe);
  group.add(rightLegGroup);

  // Apply general photorealistic/stylized shadow casting on all meshes
  group.traverse(child => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return group;
}

/**
 * Spawns an aesthetic glowing wireframe 3D Shape or an extremely detailed low-poly Goblin group
 */
function spawn3DShape(position) {
  let size = (state.brushSize / 40.0) * 4.5;
  let shapeObj;

  if (state.activeShape === 'goblin') {
    // SCALE UP: Goblin base size is multiplied by 2.2x to make it highly impressive and clear
    size = (state.brushSize / 40.0) * 10.0;
    
    // Generate complex colored low-poly Goblin group
    shapeObj = createGoblinGeometryGroup(size);
    shapeObj.position.copy(position);
    
    // Tag group for operational deck compliance
    shapeObj.userData = {
      type: 'shape',
      radius: size * 0.7
    };
  } else {
    // Standard primitive shapes
    let geometry;
    switch (state.activeShape) {
      case 'box':
        geometry = new THREE.BoxGeometry(size, size, size);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(size * 0.6, size * 0.2, 12, 24);
        break;
      case 'cone':
        geometry = new THREE.ConeGeometry(size * 0.5, size, 16);
        break;
      case 'sphere':
      default:
        geometry = new THREE.SphereGeometry(size * 0.6, 16, 16);
        break;
    }

    // Premium Cybernetic Matrix Material
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(state.activeColor),
      wireframe: true,
      roughness: 0.3,
      metalness: 0.9,
      emissive: new THREE.Color(state.activeColor),
      emissiveIntensity: 0.6
    });

    shapeObj = new THREE.Mesh(geometry, material);
    shapeObj.position.copy(position);
    
    shapeObj.userData = {
      type: 'shape',
      radius: size * 0.7
    };
  }

  // Initial slight rotations for natural 3D appearance
  shapeObj.rotation.set(0, Math.random() * Math.PI, 0); // Rotate only horizontally so it stands upright!
  
  shapeObj.castShadow = true;
  shapeObj.receiveShadow = true;

  // Add initial entry spawn pop animation (scales up from 0)
  shapeObj.scale.set(0, 0, 0);
  
  drawingGroup.add(shapeObj);
  drawnObjects.push(shapeObj);

  logToTerminal(`SPAWNED_3D_OBJECT: [${state.activeShape.toUpperCase()}] AT [${position.x.toFixed(1)}, ${position.y.toFixed(1)}]`, 'success');

  // Popup scaling animation
  let scaleFactor = 0;
  const animatePop = () => {
    if (scaleFactor < 1) {
      scaleFactor += 0.12;
      shapeObj.scale.set(scaleFactor, scaleFactor, scaleFactor);
      requestAnimationFrame(animatePop);
    } else {
      shapeObj.scale.set(1, 1, 1);
    }
  };
  animatePop();
}

/**
 * Eraser algorithm: Checks distance bounding box collisions
 */
function eraseIntersectingObjects(eraserPoint) {
  const eraserRadius = (state.brushSize / 40.0) * 3.5;
  
  // Visual feedback: Shrink/Grow glowing eraser sphere
  pointerCursor.material.color.setHex(0xff3366); // Red warning glow
  pointerCursor.scale.set(eraserRadius * 2, eraserRadius * 2, eraserRadius * 2);

  const targetsToRemove = [];

  for (let i = drawnObjects.length - 1; i >= 0; i--) {
    const obj = drawnObjects[i];
    const distance = eraserPoint.distanceTo(obj.position);
    
    // Simple collision check: if distance is less than eraser boundary + object volume radius
    const objectRadius = obj.userData.radius || 0.5;
    if (distance < (eraserRadius + objectRadius)) {
      targetsToRemove.push({ mesh: obj, index: i });
    }
  }

  targetsToRemove.forEach(({ mesh, index }) => {
    // Remove from active array
    drawnObjects.splice(index, 1);
    
    // Trigger digitize dissolve decay particle effect
    spawnDissolveParticles(mesh.position, mesh.material.color);
    
    logToTerminal(`PURGED_SECTOR: OBJECT_DECAYED`, 'warn');

    // Smooth scaling decay animation before complete removal
    let decayFactor = 1.0;
    const animateDecay = () => {
      if (decayFactor > 0.1) {
        decayFactor -= 0.18;
        mesh.scale.set(decayFactor, decayFactor, decayFactor);
        requestAnimationFrame(animateDecay);
      } else {
        drawingGroup.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
      }
    };
    animateDecay();
  });
}

// Reset cursor scale when leaving eraser tool
function resetCursorScale() {
  if (state.activeTool !== 'eraser') {
    pointerCursor.scale.set(1, 1, 1);
    pointerCursor.material.color.setHex(new THREE.Color(state.activeColor).getHex());
  }
}

// ----------------------------------------------------
// PARTICLE SUB-SYSTEM (Aesthetic Micro-Animations)
// ----------------------------------------------------
function spawnBrushParticles(position) {
  const particleGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const particleMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(state.activeColor),
    transparent: true,
    opacity: 0.95
  });

  const pMesh = new THREE.Mesh(particleGeo, particleMat);
  pMesh.position.copy(position);
  
  // Vector speed displacement
  const velocity = new THREE.Vector3(
    (Math.random() - 0.5) * 0.3,
    (Math.random() - 0.5) * 0.3 + 0.1,
    (Math.random() - 0.5) * 0.3
  );

  scene.add(pMesh);
  particlesPool.push({ mesh: pMesh, vel: velocity, life: 1.0 });
}

function spawnDissolveParticles(position, color) {
  // Digitized square particles on erase
  const count = 12;
  const particleGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  
  for (let i = 0; i < count; i++) {
    const particleMat = new THREE.MeshBasicMaterial({
      color: color || new THREE.Color(0xff3366),
      transparent: true,
      opacity: 1.0
    });
    const pMesh = new THREE.Mesh(particleGeo, particleMat);
    pMesh.position.copy(position).add(new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2
    ));

    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.8,
      Math.random() * 0.8,
      (Math.random() - 0.5) * 0.8
    );

    scene.add(pMesh);
    particlesPool.push({ mesh: pMesh, vel: velocity, life: 1.0 });
  }
}

function updateParticles() {
  for (let i = particlesPool.length - 1; i >= 0; i--) {
    const p = particlesPool[i];
    p.mesh.position.add(p.vel);
    
    // Slow drift friction
    p.vel.multiplyScalar(0.96);
    
    // Decay life
    p.life -= 0.04;
    p.mesh.material.opacity = p.life;
    p.mesh.rotation.x += 0.08;
    p.mesh.rotation.y += 0.08;

    if (p.life <= 0) {
      scene.remove(p.mesh);
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      if (p.mesh.material) p.mesh.material.dispose();
      particlesPool.splice(i, 1);
    }
  }
}

// ----------------------------------------------------
// UI DECK ACTION EVENT HANDLERS
// ----------------------------------------------------
function bindUIElements() {
  // 1. TOOL DOCKS SELECTION
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Clean active styling
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      const activeBtn = e.currentTarget;
      activeBtn.classList.add('active');

      state.activeTool = activeBtn.dataset.tool;
      logToTerminal(`ACTIVE_TOOL_SWITCHED: [${state.activeTool.toUpperCase()}]`, 'success');

      // Toggle Shapes Library View
      const shapeConfig = document.getElementById('shape-config-section');
      if (state.activeTool === 'shape') {
        shapeConfig.classList.remove('hidden');
      } else {
        shapeConfig.classList.add('hidden');
      }

      resetCursorScale();
    });
  });

  // 2. SHAPE LIBRARIES SELECTION
  document.querySelectorAll('.shape-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
      const activeBtn = e.currentTarget;
      activeBtn.classList.add('active');

      state.activeShape = activeBtn.dataset.shape;
      logToTerminal(`ACTIVE_SHAPE_SWITCHED: [${state.activeShape.toUpperCase()}]`, 'success');
    });
  });

  // 3. SWATCH COLOR PALETTES
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      const activeSwatch = e.currentTarget;
      activeSwatch.classList.add('active');

      state.activeColor = activeSwatch.dataset.color;
      
      // Update custom color picker values to match
      document.getElementById('color-picker-input').value = state.activeColor;
      document.getElementById('color-hex-label').textContent = state.activeColor.toUpperCase();

      logToTerminal(`PALETTE_COLOR_ENGAGED: ${state.activeColor}`, 'success');
      resetCursorScale();
    });
  });

  // 4. CUSTOM HEX COLOR PICKER INPUT
  const colorPickerInput = document.getElementById('color-picker-input');
  colorPickerInput.addEventListener('input', (e) => {
    // Clear swatches highlight
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    
    state.activeColor = e.target.value;
    document.getElementById('color-hex-label').textContent = state.activeColor.toUpperCase();
    
    resetCursorScale();
  });

  // 5. BRUSH STYLUS SLIDER DOCK
  const brushSlider = document.getElementById('brush-size-slider');
  const brushSizeVal = document.getElementById('brush-size-val');
  brushSlider.addEventListener('input', (e) => {
    state.brushSize = parseInt(e.target.value);
    brushSizeVal.textContent = `${state.brushSize}px`;
    
    resetCursorScale();
  });

  // 6. OPERATION DOCKS: PURGE CANVAS
  document.getElementById('btn-clear').addEventListener('click', () => {
    logToTerminal('PURGING ALL OBJECTS FROM VIRTUAL SPACE...', 'warn');
    
    // Reverse loop to remove all meshes safely
    for (let i = drawnObjects.length - 1; i >= 0; i--) {
      const obj = drawnObjects[i];
      drawingGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    
    drawnObjects.length = 0;
    logToTerminal('CANVAS STORAGE PURGED. MEMORY ZERO.', 'success');
  });

  // 7. OPERATION DOCKS: REVERT LAST
  document.getElementById('btn-undo').addEventListener('click', () => {
    if (drawnObjects.length === 0) {
      logToTerminal('REVERT OPERATION CRITICAL: STORAGE EMPTY', 'warn');
      return;
    }

    const lastObj = drawnObjects.pop();
    
    // If it's a stroke, we could have multiple segments grouped.
    // For now we revert the exact last drawn segment or shape.
    drawingGroup.remove(lastObj);
    if (lastObj.geometry) lastObj.geometry.dispose();
    if (lastObj.material) lastObj.material.dispose();

    logToTerminal(`REVERT_SUCCESS: LATEST_INDEX_PURGED`, 'success');
  });

  // 7.1 OPERATION DOCKS: EXPORT TO 3D OBJ
  document.getElementById('btn-export').addEventListener('click', () => {
    if (drawnObjects.length === 0) {
      logToTerminal('EXPORT OPERATION CRITICAL: CANVAS IS EMPTY', 'warn');
      alert('Kanvas masih kosong! Gambar sesuatu terlebih dahulu sebelum mengekspor.');
      return;
    }

    logToTerminal('COMPILING 3D OBJ MESH REPRESENTATION...', 'info');

    try {
      const exporter = new THREE.OBJExporter();
      // Parse the isolated drawingGroup
      const objResult = exporter.parse(drawingGroup);

      // Generate downloadable blob
      const blob = new Blob([objResult], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = 'narest-draw-3d-uhuyy.obj';
      link.click();

      // Clean up memory
      URL.revokeObjectURL(url);

      logToTerminal(`EXPORT_SUCCESS: narest-draw-3d-uhuyy.obj (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
    } catch (err) {
      logToTerminal(`EXPORT_FAILED: ${err.message}`, 'warn');
      console.error(err);
    }
  });

  // 8. ONBOARDING INITIALIZATION DEPLOYMENT
  const bootScreen = document.getElementById('boot-screen');
  const appContainer = document.getElementById('app-container');
  const initBtn = document.getElementById('btn-init-system');

  initBtn.addEventListener('click', () => {
    logToTerminal('INITIALIZING MEDIA_CAPTURE_DEVICES...', 'info');
    
    // Hide onboarding panel and reveal workspace
    bootScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    
    // Resize viewport to standard values
    onWindowResize();

    // Fire up webcam stream & AI Hands parser
    setupAIHandTracker();
  });
}

// ----------------------------------------------------
// WEBCAM & MEDIAPIPE PIPELINE SETUP
// ----------------------------------------------------
let cameraTracker = null;

function setupAIHandTracker() {
  logToTerminal('MOUNTING CAMERA FEED TO NEURAL PORT...', 'info');

  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });

  hands.onResults(processHandTracking);

  // Bind camera frame listener loop
  cameraTracker = new Camera(videoElement, {
    onFrame: async () => {
      // Dynamically align skeletal overlay resolution to stream size
      if (canvasElement.width !== videoElement.videoWidth) {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
        logToTerminal(`CALIBRATED: OVERLAY_RESOLUTION_MATCHED [${canvasElement.width}x${canvasElement.height}]`, 'success');
      }
      
      await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480
  });

  cameraTracker.start()
    .then(() => {
      logToTerminal('CAMERA_STREAM CONNECTED. AI TRACKER ONLINE.', 'success');
      updateGestureStatus('IDLE');
    })
    .catch((err) => {
      logToTerminal(`CAMERA MOUNT FAILED: ${err.message}`, 'warn');
      alert('Gagal mengakses Kamera Webcam! Silakan izinkan akses kamera di browser Anda.');
      updateGestureStatus('OFFLINE');
    });
}

// ----------------------------------------------------
// DYNAMIC ANIMATION RENDER LOOP
// ----------------------------------------------------
function animateLoop() {
  requestAnimationFrame(animateLoop);

  // Update neon interactive particles
  updateParticles();

  // Shapes auto-rotation removed at user request to ensure stable alignment for 3D printing
  
  // Render Three.js Graphics Viewport
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ----------------------------------------------------
// APPLICATION INITIAL BOOTSTRAPPER
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize Three.js Viewport
  initThree();

  // 2. Bind all Control Sidebar Action buttons
  bindUIElements();

  // 3. Start Core Graphic Animation Frame loop
  animateLoop();

  logToTerminal('NAREST DRAW 3D DECK FULLY LOADED. COMPLIANT WITH SYSTEM SECURITY.', 'success');
});
