// Page used by web roundTrip(): load scene.glb with three.js's GLTFLoader and report what it built.
// window.__roundTrip resolves to { meshes, triangles, materials, objects } or { error }.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

(window as any).__roundTrip = new GLTFLoader().loadAsync('scene.glb').then((gltf) => {
  let meshes = 0, triangles = 0;
  const mats = new Map<string, any>();
  gltf.scene.traverse((o: any) => {
    if (!o.isMesh) return;
    meshes++;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count) / 3;
    for (const m of [o.material].flat()) mats.set(m.uuid, { name: m.name, type: m.type, color: m.color ? '#' + m.color.getHexString() : undefined, roughness: m.roughness, metalness: m.metalness, textures: !!m.map });
  });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  return {
    meshes, triangles, materials: [...mats.values()],
    objects: gltf.scene.children.map((c) => c.name),
    size: box.isEmpty() ? null : box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)),
  };
}, (e) => ({ error: `GLTFLoader: ${e?.message ?? e}` }));
