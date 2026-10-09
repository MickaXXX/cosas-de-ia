// Motor del visor. Convenciones:
// - El GLB conserva las coordenadas del modelo (motor). `modelRoot.matrix` = alineación (rígida) guardada en la BD.
// - Todo lo que se persiste (marcadores, puntos de calibración) está en coordenadas del MODELO, nunca de pantalla.
// - Las distancias en coordenadas del modelo × factor de escala = metros (solo si hay calibración).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraPose } from "../lib/api";

export type Mode = "orbit" | "walk" | "plan";
export interface PickResult { model: THREE.Vector3; display: THREE.Vector3; normalModel: THREE.Vector3 | null }

export class Viewer3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  controls: OrbitControls;
  modelRoot = new THREE.Group();
  overlayRoot = new THREE.Group(); // en coordenadas del modelo (hijo de modelRoot)
  mesh: THREE.Object3D | null = null;
  bbox = new THREE.Box3();
  mode: Mode = "orbit";
  clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);
  clipEnabled = false;
  camerasGroup = new THREE.Group();
  cameraPoses: CameraPose[] = [];
  minimap = true;
  private raycaster = new THREE.Raycaster();
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private walkMove = new THREE.Vector2();
  private raf = 0;
  private lastT = performance.now();
  private flight: { from: THREE.Vector3; to: THREE.Vector3; qFrom: THREE.Quaternion; qTo: THREE.Quaternion; fovFrom: number; fovTo: number; t: number; done?: () => void } | null = null;
  onFrame: (() => void) | null = null;
  private resizeObs: ResizeObserver;
  private miniCam: THREE.OrthographicCamera;
  private camMarker: THREE.Mesh;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0a0f14);
    this.persp = new THREE.PerspectiveCamera(55, 1, 0.01, 1e5);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera = this.persp;
    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.modelRoot.matrixAutoUpdate = false;
    this.modelRoot.add(this.overlayRoot, this.camerasGroup);
    this.scene.add(this.modelRoot);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    const grid = new THREE.GridHelper(1, 20, 0x22303d, 0x16202a);
    grid.name = "grid";
    this.scene.add(grid);
    this.miniCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camMarker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 3), new THREE.MeshBasicMaterial({ color: 0x38bdf8, depthTest: false }));
    this.camMarker.renderOrder = 10;
    this.camMarker.visible = false;
    this.scene.add(this.camMarker);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.bindWalk();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    this.controls.dispose();
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      ms.forEach((m: any) => { m.map?.dispose?.(); m.dispose?.(); });
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ carga
  setAlignment(rowMajor: number[]) {
    const m = new THREE.Matrix4();
    if (rowMajor?.length === 16) m.set(...(rowMajor as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
    this.modelRoot.matrix.copy(m);
    this.modelRoot.matrixWorldNeedsUpdate = true;
    this.modelRoot.updateMatrixWorld(true);
    if (this.mesh) this.computeBounds();
  }

  async load(url: string, onProgress?: (f: number) => void) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    this.mesh = gltf.scene;
    this.mesh.traverse((o: any) => {
      if (o.isMesh) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m: THREE.Material) => { m.clippingPlanes = [this.clip]; m.side = THREE.DoubleSide; });
      }
    });
    this.modelRoot.add(this.mesh);
    this.modelRoot.updateMatrixWorld(true);
    this.computeBounds();
    this.frame();
  }

  computeBounds() {
    if (!this.mesh) return;
    this.modelRoot.updateMatrixWorld(true);
    this.bbox.setFromObject(this.mesh, true);
    const size = this.bbox.getSize(new THREE.Vector3());
    const c = this.bbox.getCenter(new THREE.Vector3());
    const grid = this.scene.getObjectByName("grid")!;
    const s = Math.max(size.x, size.z) * 1.5 || 1;
    grid.scale.setScalar(s);
    grid.position.set(c.x, this.bbox.min.y, c.z);
    const d = Math.max(size.x, size.y, size.z);
    this.persp.near = d / 2000; this.persp.far = d * 50; this.persp.updateProjectionMatrix();
    this.camMarker.scale.setScalar(d / 40);
  }

  get diag() { return this.bbox.getSize(new THREE.Vector3()).length() || 1; }

  // ------------------------------------------------------------------ cámara
  frame() {
    if (this.bbox.isEmpty()) return;
    const c = this.bbox.getCenter(new THREE.Vector3());
    const d = this.diag;
    this.setMode(this.mode === "walk" ? "orbit" : this.mode);
    if (this.mode === "plan") { this.fitOrtho(); return; }
    this.persp.position.copy(c).add(new THREE.Vector3(0.6, 0.55, 0.75).normalize().multiplyScalar(d * 0.9));
    this.controls.target.copy(c);
    this.persp.fov = 55; this.persp.updateProjectionMatrix();
    this.controls.update();
  }

  private fitOrtho() {
    const c = this.bbox.getCenter(new THREE.Vector3());
    const size = this.bbox.getSize(new THREE.Vector3());
    const aspect = this.aspect();
    const half = Math.max(size.x / aspect, size.z) * 0.6;
    Object.assign(this.ortho, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.ortho.position.set(c.x, this.bbox.max.y + this.diag, c.z);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(c.x, c.y, c.z);
    this.ortho.zoom = 1;
    this.ortho.updateProjectionMatrix();
    this.controls.target.set(c.x, c.y, c.z);
    this.controls.update();
  }

  setMode(mode: Mode) {
    const prev = this.mode;
    this.mode = mode;
    this.controls.dispose();
    if (mode === "plan") {
      this.camera = this.ortho;
      this.controls = new OrbitControls(this.ortho, this.renderer.domElement);
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      if (prev !== "plan") this.fitOrtho();
    } else {
      this.camera = this.persp;
      this.controls = new OrbitControls(this.persp, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.screenSpacePanning = true;
      if (mode === "walk") {
        this.controls.enabled = false;
        const e = new THREE.Euler().setFromQuaternion(this.persp.quaternion, "YXZ");
        this.yaw = e.y; this.pitch = e.x;
        // Altura de ojos: 1,6 m si hay escala; si no, 35 % de la altura del modelo.
        const eye = this.eyeHeight();
        this.persp.position.y = Math.min(this.bbox.max.y, this.bbox.min.y + eye);
      } else {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion);
        this.controls.target.copy(this.persp.position).addScaledVector(dir, this.diag * 0.25);
      }
    }
    this.controls.update();
  }

  metersPerUnit: number | null = null;
  eyeHeight() {
    return this.metersPerUnit ? 1.6 / this.metersPerUnit : this.bbox.getSize(new THREE.Vector3()).y * 0.35;
  }

  /** Vuela a la pose de una foto (COLMAP: x derecha, y abajo, mira +Z) y ajusta el campo visual. */
  flyToPhoto(p: CameraPose, done?: () => void) {
    if (this.mode !== "orbit" && this.mode !== "walk") this.setMode("orbit");
    const Rw = new THREE.Matrix4();
    const r = p.world_from_cam_rotation;
    Rw.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1);
    const flip = new THREE.Matrix4().makeScale(1, -1, -1); // cámara COLMAP → cámara three.js
    const align = new THREE.Matrix4().extractRotation(this.modelRoot.matrixWorld);
    const q = new THREE.Quaternion().setFromRotationMatrix(align.multiply(Rw).multiply(flip));
    const pos = new THREE.Vector3(...(p.center as [number, number, number])).applyMatrix4(this.modelRoot.matrixWorld);
    const fy = p.params.length >= 4 && p.camera_model === "PINHOLE" ? p.params[1] : p.params[0];
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(p.height / 2 / fy));
    this.flight = { from: this.persp.position.clone(), to: pos, qFrom: this.persp.quaternion.clone(), qTo: q, fovFrom: this.persp.fov, fovTo: fov, t: 0, done };
    this.controls.enabled = false;
  }

  // ------------------------------------------------------------------ corte
  setClip(enabled: boolean, height01: number) {
    this.clipEnabled = enabled;
    const h = this.bbox.min.y + (this.bbox.max.y - this.bbox.min.y) * height01;
    this.clip.constant = enabled ? h : 1e9;
  }

  // ------------------------------------------------------------------ selección
  pick(clientX: number, clientY: number): PickResult | null {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, true).filter((h) => !this.clipEnabled || this.clip.distanceToPoint(h.point) >= 0);
    const h = hits[0];
    if (!h) return null;
    const inv = this.modelRoot.matrixWorld.clone().invert();
    const model = h.point.clone().applyMatrix4(inv);
    let normalModel: THREE.Vector3 | null = null;
    if (h.face) normalModel = h.face.normal.clone().transformDirection(h.object.matrixWorld).transformDirection(inv);
    return { model, display: h.point.clone(), normalModel };
  }

  toDisplay(model: number[]): THREE.Vector3 {
    return new THREE.Vector3(model[0], model[1], model[2]).applyMatrix4(this.modelRoot.matrixWorld);
  }

  /** Proyección a píxeles del contenedor; null si queda detrás de la cámara o recortado. */
  project(model: number[]): { x: number; y: number } | null {
    const p = this.toDisplay(model);
    if (this.clipEnabled && this.clip.distanceToPoint(p) < 0) return null;
    const v = p.clone().project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
  }

  // ------------------------------------------------------------------ superposiciones
  setOverlay(segments: { a: number[]; b: number[]; color: number }[], points: { p: number[]; color: number }[]) {
    this.overlayRoot.clear();
    const r = this.diag / 300;
    for (const s of segments) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...(s.a as [number, number, number])), new THREE.Vector3(...(s.b as [number, number, number]))]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: s.color, depthTest: false }));
      line.renderOrder = 5;
      this.overlayRoot.add(line);
    }
    // Las esferas se dimensionan en unidades de display; se compensa la escala de modelRoot (rígida → 1).
    for (const p of points) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: p.color, depthTest: false }));
      m.position.set(p.p[0], p.p[1], p.p[2]);
      m.renderOrder = 6;
      this.overlayRoot.add(m);
    }
  }

  setCameraPoses(poses: CameraPose[], visible: boolean) {
    this.cameraPoses = poses;
    this.camerasGroup.clear();
    if (!visible || !poses.length) return;
    const s = this.diag / 60;
    const verts: number[] = [];
    for (const p of poses) {
      const r = p.world_from_cam_rotation;
      const R = new THREE.Matrix3().set(r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]);
      const c = new THREE.Vector3(...(p.center as [number, number, number]));
      const aspect = p.width / p.height;
      const corners = [[-aspect, -1], [aspect, -1], [aspect, 1], [-aspect, 1]].map(([x, y]) => new THREE.Vector3(x * 0.5 * s, y * 0.5 * s, s).applyMatrix3(R).add(c));
      for (let i = 0; i < 4; i++) {
        verts.push(c.x, c.y, c.z, corners[i].x, corners[i].y, corners[i].z);
        const n = corners[(i + 1) % 4];
        verts.push(corners[i].x, corners[i].y, corners[i].z, n.x, n.y, n.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.8 }));
    this.camerasGroup.add(lines);
  }

  /** Foto más cercana al punto de pantalla (en px), para «ver desde aquí». */
  nearestPose(clientX: number, clientY: number, maxPx = 28): CameraPose | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best: CameraPose | null = null, bd = maxPx;
    for (const p of this.cameraPoses) {
      const s = this.project(p.center);
      if (!s) continue;
      const d = Math.hypot(s.x - (clientX - rect.left), s.y - (clientY - rect.top));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  screenshot(): string { this.render(); return this.renderer.domElement.toDataURL("image/jpeg", 0.9); }

  // ------------------------------------------------------------------ recorrido
  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.type === "keydown") this.keys.add(e.key.toLowerCase()); else this.keys.delete(e.key.toLowerCase());
  };

  setJoystick(x: number, y: number) { this.walkMove.set(x, y); }

  private bindWalk() {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    const el = this.renderer.domElement;
    let last: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => { if (this.mode === "walk") last = { x: e.clientX, y: e.clientY }; });
    window.addEventListener("pointerup", () => (last = null));
    el.addEventListener("pointermove", (e) => {
      if (this.mode !== "walk" || !last) return;
      this.yaw -= (e.clientX - last.x) * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - last.y) * 0.004, -1.4, 1.4);
      last = { x: e.clientX, y: e.clientY };
    });
  }

  private stepWalk(dt: number) {
    const speed = (this.metersPerUnit ? 1.4 / this.metersPerUnit : this.diag / 12) * (this.keys.has("shift") ? 2.5 : 1);
    let f = this.walkMove.y, s = this.walkMove.x;
    if (this.keys.has("w") || this.keys.has("arrowup")) f += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) f -= 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) s -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) s += 1;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.persp.position.addScaledVector(fwd, f * speed * dt).addScaledVector(right, s * speed * dt);
    if (this.keys.has("e")) this.persp.position.y += speed * dt;
    if (this.keys.has("q")) this.persp.position.y -= speed * dt;
    this.persp.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  // ------------------------------------------------------------------ render
  private aspect() { return Math.max(this.host.clientWidth, 1) / Math.max(this.host.clientHeight, 1); }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / Math.max(h, 1);
    this.persp.updateProjectionMatrix();
    if (this.mode === "plan" && !this.bbox.isEmpty()) {
      const half = (this.ortho.top - this.ortho.bottom) / 2;
      this.ortho.left = -half * this.aspect(); this.ortho.right = half * this.aspect(); this.ortho.updateProjectionMatrix();
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / 0.9);
      const k = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      this.persp.position.lerpVectors(f.from, f.to, k);
      this.persp.quaternion.slerpQuaternions(f.qFrom, f.qTo, k);
      this.persp.fov = f.fovFrom + (f.fovTo - f.fovFrom) * k;
      this.persp.updateProjectionMatrix();
      if (f.t >= 1) {
        this.flight = null;
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion);
        this.controls.target.copy(this.persp.position).addScaledVector(dir, this.diag * 0.15);
        this.controls.enabled = this.mode !== "walk";
        const e = new THREE.Euler().setFromQuaternion(this.persp.quaternion, "YXZ");
        this.yaw = e.y; this.pitch = e.x;
        f.done?.();
      }
    } else if (this.mode === "walk") {
      this.stepWalk(dt);
    } else {
      this.controls.update();
    }
    this.render();
    this.onFrame?.();
  };

  render() {
    const r = this.renderer;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.clear();
    this.camMarker.visible = false;
    r.render(this.scene, this.camera);
    // Minimapa: vista superior con la posición de la cámara.
    if (this.minimap && this.mode !== "plan" && !this.bbox.isEmpty() && w > 760) {
      const size = 180, x = w - 360 - size, y = 14;
      const c = this.bbox.getCenter(new THREE.Vector3());
      const sz = this.bbox.getSize(new THREE.Vector3());
      const half = Math.max(sz.x, sz.z) * 0.6;
      Object.assign(this.miniCam, { left: -half, right: half, top: half, bottom: -half });
      this.miniCam.position.set(c.x, this.bbox.max.y + this.diag, c.z);
      this.miniCam.up.set(0, 0, -1);
      this.miniCam.lookAt(c);
      this.miniCam.updateProjectionMatrix();
      this.camMarker.visible = true;
      this.camMarker.position.copy(this.persp.position);
      this.camMarker.position.y = this.bbox.max.y;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.persp.quaternion);
      // Cono (+Y) → apunta a −Z con Rx(−90°); luego rumbo alrededor de Y hacia la dirección de vista.
      const heading = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z));
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      this.camMarker.quaternion.copy(heading.multiply(tilt));
      r.setViewport(x, y, size, size);
      r.setScissor(x, y, size, size);
      r.setScissorTest(true);
      r.clearDepth();
      r.render(this.scene, this.miniCam);
      r.setScissorTest(false);
      this.camMarker.visible = false;
    }
  }
}
