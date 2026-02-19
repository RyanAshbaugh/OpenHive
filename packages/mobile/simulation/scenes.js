/**
 * Scene loader — auto-discovers scene files via require.context.
 *
 * Usage (in your app's scenes/index.js):
 *
 *   import { loadScenes } from '@openhive/mobile/simulation';
 *   export default loadScenes(require.context('./', false, /^\.\/(?!index\.).*\.js$/));
 *
 * Each .js file in the directory should `export default` a scene config object.
 * The filename (minus extension) becomes the scene name.
 */

/**
 * @param {object} ctx - A require.context result
 * @returns {Object<string, object>} Map of scene name → scene config
 */
export function loadScenes(ctx) {
  const scenes = {};
  ctx.keys().forEach((key) => {
    const name = key.replace('./', '').replace(/\.js$/, '');
    scenes[name] = ctx(key).default;
  });
  return scenes;
}
