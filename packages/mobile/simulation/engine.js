/**
 * SimulationEngine — generic date-advancing simulation engine.
 *
 * Handles the timer loop, data generation, state management, React hooks,
 * and profile setup/teardown lifecycle. Apps provide the app-specific parts
 * (API calls, date provider, scene configs) via the factory options.
 *
 * Usage:
 *
 *   import { createSimulationEngine } from '@openhive/mobile/simulation';
 *
 *   const engine = createSimulationEngine({
 *     scenes,
 *     dateProvider: { setSimulatedDate, addDays, localYMD },
 *     onSetup: async (profile) => { ... create entities, return them ... },
 *     onTeardown: async (created) => { ... delete entities ... },
 *   });
 *
 *   // In your deep link handler:
 *   await engine.startScene('my-scene', { onTick, onComplete });
 *
 *   // In your components:
 *   const data = engine.getSimulationData();
 *   const active = engine.isSimulationActive();
 *
 *   // React hooks:
 *   engine.useSimulationData()   — re-renders on each tick
 *   engine.useSimulationSetup()  — called after profile setup/teardown
 */

// React is imported at the module level so hooks work.
// The consuming app's bundler resolves this to its own React instance.
import { useState, useEffect } from 'react';

/**
 * Create a simulation engine instance.
 *
 * @param {object} options
 * @param {Object<string, object>} options.scenes - Scene registry (name → config)
 * @param {object} options.dateProvider - { setSimulatedDate, addDays, localYMD }
 * @param {function} [options.onSetup] - async (profile) => createdEntities
 * @param {function} [options.onTeardown] - async (createdEntities) => void
 */
export function createSimulationEngine({ scenes, dateProvider, onSetup, onTeardown }) {
  const { setSimulatedDate, addDays, localYMD } = dateProvider;

  // -------------------------------------------------------------------------
  // Instance state (captured in closure — no module globals)
  // -------------------------------------------------------------------------
  let _timer = null;
  let _simulationData = {};
  let _simulationActive = false;
  let _currentScene = null;
  let _createdEntities = null;
  const _dataListeners = new Set();
  const _setupListeners = new Set();

  function _notifyDataListeners() {
    for (const cb of _dataListeners) cb(_simulationData);
  }

  function _notifySetupListeners() {
    for (const cb of _setupListeners) cb();
  }

  // -------------------------------------------------------------------------
  // Profile lifecycle
  // -------------------------------------------------------------------------
  async function _setup(profile) {
    if (!profile || !onSetup) return null;
    console.log('[Sim] Setting up profile...');
    try {
      const created = await onSetup(profile);
      console.log('[Sim] Profile setup complete');
      return created;
    } catch (e) {
      console.warn('[Sim] Profile setup error:', e?.message);
      return null;
    }
  }

  async function _teardown() {
    if (!_createdEntities || !onTeardown) return;
    try {
      await onTeardown(_createdEntities);
      console.log('[Sim] Teardown complete');
    } catch (e) {
      console.warn('[Sim] Teardown error:', e?.message);
    }
    _createdEntities = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a simulation scene.
   *
   * 1. Tears down any leftover entities from a previous run
   * 2. Creates profile entities via onSetup (idempotent)
   * 3. Pre-generates all data from dataGenerators
   * 4. Starts a timer that advances the simulated date
   */
  async function startScene(sceneName, { onTick, onComplete, onSetupComplete } = {}) {
    const scene = scenes[sceneName];
    if (!scene) throw new Error(`Unknown scene: ${sceneName}`);

    stopScene();

    _simulationData = {};
    _simulationActive = true;
    _currentScene = scene;

    // Teardown leftover entities from a previous run
    await _teardown();

    // Setup profile entities
    if (scene.profile) {
      _createdEntities = await _setup(scene.profile);
      _notifySetupListeners();
      onSetupComplete?.();
    }

    // Pre-generate all data
    const start = new Date(scene.startDate);
    const end = scene.endDate ? new Date(scene.endDate) : new Date();

    if (scene.dataGenerators) {
      const generators = scene.dataGenerators;
      let d = new Date(start);
      while (d <= end) {
        const dateStr = localYMD(d);
        for (const [name, gen] of Object.entries(generators)) {
          const val = gen(d);
          if (val) {
            if (!_simulationData[name]) _simulationData[name] = {};
            _simulationData[name][dateStr] = val;
          }
        }
        d = addDays(d, 1);
      }
    }

    // Start the date animation
    let current = new Date(start);
    const skipDaysSet = scene.skipDays ? new Set(scene.skipDays) : null;

    // Advance past any skipped days
    const advancePastSkipped = () => {
      if (!skipDaysSet) return;
      while (current <= end && skipDaysSet.has(current.getDay())) {
        current = addDays(current, 1);
      }
    };

    advancePastSkipped();

    _timer = setInterval(async () => {
      if (current > end) {
        stopScene();
        setSimulatedDate(null);
        await _teardown();
        _notifySetupListeners();
        onComplete?.();
        return;
      }
      setSimulatedDate(current);
      onTick?.(current);
      current = addDays(current, scene.stepDays);
      advancePastSkipped();
    }, scene.intervalMs);
  }

  /** Stop the current scene (keeps data for final frame). */
  function stopScene() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _simulationActive = false;
    _currentScene = null;
  }

  /** Clear all simulation state and tear down profile. */
  async function resetSimulation() {
    stopScene();
    await _teardown();
    _simulationData = {};
    _notifyDataListeners();
    _notifySetupListeners();
  }

  /** Get current simulation data: { [entityName]: { [dateStr]: value } } */
  function getSimulationData() {
    return _simulationData;
  }

  /** Whether a simulation is actively running. */
  function isSimulationActive() {
    return _simulationActive;
  }

  /** Get all registered scene names. */
  function getSceneNames() {
    return Object.keys(scenes);
  }

  /** Get the scene config for a given name. */
  function getScene(sceneName) {
    return scenes[sceneName] || null;
  }

  /** Get the currently running scene config (or null). */
  function getCurrentScene() {
    return _currentScene;
  }

  // -------------------------------------------------------------------------
  // React hooks
  // -------------------------------------------------------------------------

  /** Subscribe to simulation data changes. Re-renders each tick. */
  function useSimulationData() {
    const [state, setState] = useState({
      active: _simulationActive,
      data: _simulationData,
    });

    useEffect(() => {
      const handler = (data) => {
        setState({ active: _simulationActive, data: { ...data } });
      };
      _dataListeners.add(handler);
      return () => _dataListeners.delete(handler);
    }, []);

    return state;
  }

  /** Subscribe to profile setup/teardown events (for refetching entity lists). */
  function useSimulationSetup(callback) {
    useEffect(() => {
      if (!callback) return;
      _setupListeners.add(callback);
      return () => _setupListeners.delete(callback);
    }, [callback]);
  }

  return {
    startScene,
    stopScene,
    resetSimulation,
    getSimulationData,
    isSimulationActive,
    getSceneNames,
    getScene,
    getCurrentScene,
    useSimulationData,
    useSimulationSetup,
  };
}
