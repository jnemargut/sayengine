// The look module (Decision 29): whole-scene looks as data, reference boards and measured targets.
export { LookZ, PRESETS, parseLook, buildLut, sampleLut, cubeText, lutStrip, bakeLinear, bakeHex, referenceLight, engineLight, runtimeLook, gradeSceneLinear, gradeTransport, type Look, type Lut, type MaterialTweak, type Board } from './look.ts';
export { TONE_CURVES, toneCurve, transport, untransport, hexToLinear, linearToHex, srgbToLinear, linearToSrgb, type RGB, type ToneCurve } from './color.ts';
export { colourfulness, dominantColours, paletteMatch, paletteMatchImages, boardGates, type GateResult } from './gates.ts';
export { decodePng, encodePng, type Image } from './png.ts';
export { LOOK_TOOLS, activeLook, lookState, mergeLook, lookSummary } from './tools.ts';
export { LOOK_KNOBS, knob, knobsFor, turnKnob, knobStep, lookTakes, tempToKelvin, kelvinToTemp, kelvinToHex, hexToKelvin, fogDensity, type Knob } from './knobs.ts';
