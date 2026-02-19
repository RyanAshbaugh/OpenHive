/**
 * @openhive/mobile/simulation
 *
 * Optional simulation utilities for building date-advancing timelapses,
 * screen recordings, and demo flows in mobile apps.
 *
 * Core:
 *   createSimulationEngine  — factory that returns a full simulation controller
 *
 * Utilities:
 *   seededRandom, dateSeed  — reproducible random data generation
 *   loadScenes              — auto-discover scene files via require.context
 */

export { createSimulationEngine } from './engine.js';
export { seededRandom, dateSeed } from './random.js';
export { loadScenes } from './scenes.js';
