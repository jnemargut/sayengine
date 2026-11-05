// The world module (Decisions 26–28): towns, real or invented, through one pipeline with fix layers.
// fetch.ts (network, Node only) is imported by the CLI directly, not from here. Plane helpers stay
// inside the module (import ./world/geo.ts directly) so their short names don't collide with core's.
export type { TownPlan, Building, Street, Area, Ground, Credit, RoofType, BuildingUse } from './plan.ts';
export { groundAt, CREDITS } from './plan.ts';
export { STYLES, styleFor } from './styles.ts';
export { applyRules, clampBuilding, gradeRoads, LIMITS } from './rules.ts';
export { applyFixes, findTarget, validateFix, type Fix, type FixReport } from './fixes.ts';
export { realPlan, inventedPlan, remixPlan, sketchFromDescription, lotsAlongStreets, type RawArea, type Sketch } from './sources.ts';
export { townNodes, nodeTriangles, type TownNode, type ModelMesh } from './mesh.ts';
export { buildTown, worldNodes, addTownsToGlb, landmarkObjects, creditsText, setWorldCacheDir, worldCacheDir, loadArea, listAreas, type TownSpec, type WorldState } from './town.ts';
export { fixFromWords, WALL_WORDS, type WordsFix } from './words.ts';
export { WORLD_TOOLS, worldChecks, landmarkMesh, landmarkMeshes } from './tools.ts';
export { townView, townsForState, buildingSource, buildingLabel, CHUNK_DEFAULT, type TownView, type TownChunk, type ViewBuilding } from './view.ts';
